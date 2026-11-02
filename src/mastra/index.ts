import { Mastra } from '@mastra/core/mastra'
import { randomUUID } from 'node:crypto'
import { AgentController } from '@mastra/core/agent-controller'
import { chatRoute } from '@mastra/ai-sdk'
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context'
import type { Middleware, ServerConfig } from '@mastra/core/server'
import type { CrumEnv } from '../config/env'
import { parseEnv } from '../config/env'
import { buildObservability } from './observability'
import { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'
import { buildMastraStorage } from './storage'
import type { CrumStorage } from './storage'
import { crmAssistant, CRUM_SUBAGENTS } from './agent'
import { buildCrumMemory } from './memory'
import { buildRecallDeps } from './recall'
import { ingestWorkflow } from './workflows/ingest'
import { documentIntakeWorkflow, MAX_DOCUMENT_BYTES } from './workflows/document-intake'
import { sponsorshipIntakeWorkflow } from './workflows/sponsorship-intake'
import { intentClassifier } from './classifiers/intent'
import { injectionClassifier } from './classifiers/injection'
import { intentTriageFlow } from './workflows/intent-triage'
import { digestWorkflow } from './workflows/digest'
import { parserAgent } from './agents/parser'
import { documentExtractorAgent } from './agents/document-extractor'
import { emailDrafterAgent } from './agents/email-drafter'
import { digestAgent } from './agents/digest'
import { offerStrategistAgent } from './agents/offer-strategist'
import { marketerCopywriterAgent } from './agents/marketer-copywriter'
import { creativeDesignerAgent } from './agents/creative-designer'
import { mediaBuyerAgent } from './agents/media-buyer'
import { funnelBuilderAgent } from './agents/funnel-builder'
import { campaignAnalystAgent } from './agents/campaign-analyst'
import { createCrumMcpServer } from './mcp-server'
import { buildScorers } from '../evals/scorers'
import { buildScheduleHooks } from './schedule-hooks'
import { resolveIdentity, IdentityError } from './identity'
import { CRUM_AGENT_CONTROLLER_ID, resourceIdFor } from './sessions'
import { createGmailConnectRoute, createGmailCallbackRoute } from '../api/gmail'
import { registerActionAdapter } from '../marketing/outbox'
import { makePromotePageAdapter, makePublishPageAdapter, pageHostConfigFromEnv } from '../marketing/page-host'
import { makeCreateCampaignAdapter, makeSetCampaignStatusAdapter } from '../marketing/meta-ads'
import { makeReplicateAdapter, registerImageAdapter, setSelectedImageProvider } from '../marketing/image-provider'

export interface CrumMastraOptions {
  storage?: CrumStorage
}

export function buildCrumServerConfig(env: CrumEnv): ServerConfig {
  const identityMiddleware: Middleware = {
    path: '/chat/*',
    handler: async (c, next) => {
      const header = (name: string): string | undefined => c.req.header(name)

      let identity
      try {
        identity = await resolveIdentity(header, env)
      } catch (err) {
        if (!(err instanceof IdentityError)) {
          console.error('[CRUM] identity resolution threw unexpectedly', err)
        }
        return c.json({ error: 'unauthorized' }, 401)
      }
      const existing = c.get('requestContext') as RequestContext | undefined
      const rc = existing ?? new RequestContext()

      rc.set('tenantContext', identity)
      rc.set('tenantId', identity.tenantId)
      rc.set('userId', identity.userId)
      rc.set('userRole', identity.userRole)

      rc.set(MASTRA_RESOURCE_ID_KEY, resourceIdFor(identity))

      const threadId = header('x-thread-id') ?? randomUUID()
      rc.set(MASTRA_THREAD_ID_KEY, threadId)

      if (!c.get('requestContext')) c.set('requestContext', rc)
      return next()
    },
  }

  return {
    port: env.CRUM_API_PORT,
    host: env.CRUM_API_HOST,
    middleware: [identityMiddleware],
    apiRoutes: [
      chatRoute({
        path: '/chat/crm',
        agent: 'crm-assistant',
        version: 'v7',
        heartbeatMs: 10000,
      }),
      createGmailConnectRoute(env),
      createGmailCallbackRoute(env),
    ],
  }
}

// createCrumMastra runs per request, so the adapter registration it performs is
// deliberately not guarded; this log is. It writes once per process, or once per
// actual lane change, which stops a load balancer's /health probes from
// repeating the same boot line forever, while still leaving one line an operator
// can find when asking why staging refuses.
let lastLane: 'pages' | 'none' | undefined
let lastMetaLane: 'meta-ads' | 'none' | undefined
let lastImageLane: string | undefined

function logLaneOnce(lane: 'pages' | 'none'): void {
  if (lastLane === lane) return
  lastLane = lane
  console.log(
    lane === 'pages'
      ? '[CRUM] marketing page adapters registered'
      : '[CRUM] marketing page adapters not registered: Pages config incomplete, staging will refuse',
  )
}

function logMetaLaneOnce(lane: 'meta-ads' | 'none'): void {
  if (lastMetaLane === lane) return
  lastMetaLane = lane
  console.log(
    lane === 'meta-ads'
      ? '[CRUM] Meta Ads API adapters registered'
      : '[CRUM] Meta Ads API not configured; create_campaign and set_campaign_status actions will be refused at staging',
  )
}

function logImageLaneOnce(lane: string): void {
  if (lastImageLane === lane) return
  lastImageLane = lane
  console.log(
    lane === 'none'
      ? '[CRUM] image provider not configured; marketing.generate_assets will refuse'
      : `[CRUM] image adapter registered: ${lane}`,
  )
}

export function createCrumMastra(env: CrumEnv, options: CrumMastraOptions = {}): Mastra {
  assertMcpRequestStateKey(env)

  // Slice 2's staging guard refuses a bundle whose action has no adapter, so a
  // half-configured page host would stage a publish that can never run. All four
  // Pages settings or none: pageHostConfigFromEnv answers null for a partial one.
  const pageHost = pageHostConfigFromEnv(env)
  if (pageHost !== null) {
    // Deliberately outside the log guard below: createCrumMastra runs per request
    // (the REST plane rebuilds the runtime, and every /health probe calls it), and
    // a second construction must still register. A Map.set is cheap.
    registerActionAdapter(makePublishPageAdapter(pageHost))
    registerActionAdapter(makePromotePageAdapter(pageHost))
    logLaneOnce('pages')
  } else {
    logLaneOnce('none')
  }

  // Slice 3 spec section 5.4: both Meta Ads adapters register only when the
  // access token and the ad accounts list are both present. Either absent means
  // the adapters stay unmapped, and the slice 1 guard refuses at staging.
  const metaToken = env.CRUM_META_ADS_ACCESS_TOKEN
  const metaAccountsRaw = env.CRUM_META_AD_ACCOUNTS
  if (metaToken && metaAccountsRaw) {
    let adAccounts: string[]
    try {
      const parsed: unknown = JSON.parse(metaAccountsRaw)
      if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
        throw new Error('CRUM_META_AD_ACCOUNTS must be a JSON array of strings')
      }
      adAccounts = parsed
    } catch (err) {
      console.warn('[CRUM] Failed to parse CRUM_META_AD_ACCOUNTS:', err instanceof Error ? err.message : String(err))
      logMetaLaneOnce('none')
      adAccounts = []
    }
    if (adAccounts.length > 0) {
      registerActionAdapter(makeCreateCampaignAdapter({ accessToken: metaToken, adAccounts }))
      registerActionAdapter(makeSetCampaignStatusAdapter({ accessToken: metaToken, adAccounts }))
      logMetaLaneOnce('meta-ads')
    } else {
      logMetaLaneOnce('none')
    }
  } else {
    logMetaLaneOnce('none')
  }

  // The registry starts empty and the selection is set whether or not a credential
  // is present, because the refusal message names the selected provider.
  // `createCrumMastra` runs per request, so a registration is a Map.set and
  // re-setting the same name is expected rather than an error.
  const imageToken = env.CRUM_REPLICATE_API_TOKEN
  setSelectedImageProvider(env.CRUM_IMAGE_PROVIDER)
  if (imageToken) {
    registerImageAdapter(
      makeReplicateAdapter({
        apiToken: imageToken,
        model: env.CRUM_REPLICATE_MODEL,
        ceilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR,
        bundleCeilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE,
        costMinorPerImage: env.CRUM_IMAGE_COST_MINOR_PER_IMAGE,
        // The document lane's own limit, so a picture this build could not store
        // is a picture this build will not pay for.
        maxBytes: MAX_DOCUMENT_BYTES,
      }),
    )
    logImageLaneOnce(env.CRUM_IMAGE_PROVIDER)
  } else {
    // Nothing to unregister: an install without a credential has no adapter, and
    // selectImageAdapter() answers null for that reason rather than for a spelling.
    logImageLaneOnce('none')
  }

  const storage = options.storage ?? buildMastraStorage(env)
  // buildRecallDeps is lazy, returns undefined for in-memory CI (no
  // DATABASE_URL), and memoizes per credential set — so even REST lanes that
  // rebuild the runtime per request share a single recall pool.
  const memory = buildCrumMemory(storage, env, buildRecallDeps(env))

  const crmController = new AgentController({
    id: CRUM_AGENT_CONTROLLER_ID,
    modes: [{ id: 'default', name: 'Default' }],
    agent: crmAssistant,
    subagents: CRUM_SUBAGENTS,
  })

  const mcpDecision = resolveMcpRequestState(env)
  if (mcpDecision.warning) {
    console.warn(`[CRUM] ${mcpDecision.warning}`)
  }
  const crumMcpServer = createCrumMcpServer(mcpDecision.key)

  return new Mastra({
    agents: {
      'crm-assistant': crmAssistant,
      'parser': parserAgent,
      'document-extractor': documentExtractorAgent,
      'email-drafter': emailDrafterAgent,
      'digest': digestAgent,
      'offer-strategist': offerStrategistAgent,
      'marketer-copywriter': marketerCopywriterAgent,
      'creative-designer': creativeDesignerAgent,
      'media-buyer': mediaBuyerAgent,
      'funnel-builder': funnelBuilderAgent,
      'campaign-analyst': campaignAnalystAgent,
    },
    workflows: {
      'knowledge-ingest': ingestWorkflow,
      'crum-document-intake': documentIntakeWorkflow,
      'crum-sponsorship-intake': sponsorshipIntakeWorkflow,
      'crum-intent-triage': intentTriageFlow,
      'crum-digest': digestWorkflow,
    },
    classifiers: {
      'crum-intent': intentClassifier,
      'crum-injection': injectionClassifier,
    },
    scorers: buildScorers(),
    schedules: buildScheduleHooks(),
    mcpServers: {
      'crum-crm': crumMcpServer,
    },
    storage,
    memory: {
      coreMemory: memory,
    },
    observability: buildObservability(env),
    agentControllers: {
      [CRUM_AGENT_CONTROLLER_ID]: crmController,
    },
    server: buildCrumServerConfig(env),
  })
}

export { OBSERVABILITY_INSTANCE, OBSERVABILITY_SERVICE_NAME } from './observability'
export { buildMastraStorage, isPostgresStorage, STORAGE_ID } from './storage'
export type { CrumStorage } from './storage'
export { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'
export { crmAssistant } from './agent'
export { buildCrumMemory } from './memory'
export { createSession, listSessions, queryThreads } from './sessions'
export { CRUM_AGENT_CONTROLLER_ID, resourceIdFor, resolveSession } from './sessions'
export type { ResolvedSession, ResolveSessionOptions } from './sessions'
export type { CreateSessionOptions, ListSessionsOptions } from './sessions'

interface EntryMastraGlobal {
  __crumEntryMastra?: Mastra
}

const entryEnv = parseEnv()
const entryHolder = globalThis as unknown as EntryMastraGlobal
export const mastra: Mastra = entryHolder.__crumEntryMastra ??= createCrumMastra(entryEnv)

if (entryEnv.NODE_ENV !== 'test') {
  void import('./boot')
    .then(({ bootCrumProcess }) => {
      const result = bootCrumProcess(entryEnv, mastra)
      if (result.skipped === 'already-started') {
        console.log('[CRUM] Boot side effects already running in this process (the bundler evaluates this module twice); not binding a second plane.')
      } else if (result.skipped && result.skipped !== 'not-server-process') {
        console.log(`[CRUM] Boot side effects skipped: ${result.skipped}`)
      }
      return result.restPlane
    })
    .catch((err: unknown) => {
      console.error(`[CRUM] Boot side effects never ran: ${err instanceof Error ? err.message : String(err)}`)
    })
}

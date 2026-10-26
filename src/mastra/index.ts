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
import { ingestWorkflow } from './workflows/ingest'
import { documentIntakeWorkflow } from './workflows/document-intake'
import { intentClassifier } from './classifiers/intent'
import { injectionClassifier } from './classifiers/injection'
import { intentTriageFlow } from './workflows/intent-triage'
import { digestWorkflow } from './workflows/digest'
import { parserAgent } from './agents/parser'
import { documentExtractorAgent } from './agents/document-extractor'
import { emailDrafterAgent } from './agents/email-drafter'
import { digestAgent } from './agents/digest'
import { createCrumMcpServer } from './mcp-server'
import { buildScorers } from '../evals/scorers'
import { buildScheduleHooks } from './schedule-hooks'
import { resolveIdentity, IdentityError } from './identity'
import { CRUM_AGENT_CONTROLLER_ID, resourceIdFor } from './sessions'
import { createGmailConnectRoute, createGmailCallbackRoute } from '../api/gmail'

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

export function createCrumMastra(env: CrumEnv, options: CrumMastraOptions = {}): Mastra {
  assertMcpRequestStateKey(env)

  const storage = options.storage ?? buildMastraStorage(env)
  const memory = buildCrumMemory(storage)

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
    },
    workflows: {
      'knowledge-ingest': ingestWorkflow,
      'crum-document-intake': documentIntakeWorkflow,
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

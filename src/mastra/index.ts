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
import { intentClassifier } from './classifiers/intent'
import { injectionClassifier } from './classifiers/injection'
import { intentTriageFlow } from './workflows/intent-triage'
import { digestWorkflow } from './workflows/digest'
import { parserAgent } from './agents/parser'
import { emailDrafterAgent } from './agents/email-drafter'
import { digestAgent } from './agents/digest'
import { createCrumMcpServer } from './mcp-server'
import { buildScorers } from '../evals/scorers'
import { buildScheduleHooks } from './schedule-hooks'
import { resolveIdentity, IdentityError } from './identity'
import { CRUM_AGENT_CONTROLLER_ID, resourceIdFor } from './sessions'
import { createGmailConnectRoute, createGmailCallbackRoute } from '../api/gmail'

export interface CrumMastraOptions {
  /**
   * Inject a store instead of building one from the environment. Tests use this
   * to construct a real Mastra without opening a socket; nothing in production
   * passes it.
   */
  storage?: CrumStorage
}

/**
 * Builds the `server:` block (§4.1, §13.2): a chat route for the assistant plus
 * one middleware that turns each request into a validated `TenantRequestContext`
 * before the agent runs.
 *
 * Exported separately from `createCrumMastra` so the middleware's dual-convention
 * `RequestContext` writes are unit-testable with a stub Hono context, without
 * binding a socket.
 *
 * The middleware satisfies BOTH request-context conventions the tools rely on:
 * - the NESTED convention, `agent.ts` `defaultOptions` reads via
 *   `requestContext.get('tenantContext')` to pick `activeTools`; and
 * - the FLAT convention, each tool's `requestContextSchema` reads via
 *   `requestContext.all` (`tenantId`/`userId`/`userRole`).
 * Because `RequestContext` is an open map, one handler populating both is enough
 * — no per-tool changes are required.
 *
 * Identity is fail-closed: any `resolveIdentity` throw (missing claim, bad UUID,
 * unverified token, unset JWKS) short-circuits with a 401 and never calls
 * `next()`, so a request without a trustworthy identity cannot reach the agent or
 * read another tenant's rows.
 */
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
          // Unexpected failure: log it but still deny — never let an unknown
          // error open the route. Logged through the process logger, not the
          // request-scoped `mastra` Hono variable, to keep this handler off
          // `any`-typed context access.
          console.error('[CRUM] identity resolution threw unexpectedly', err)
        }
        return c.json({ error: 'unauthorized' }, 401)
      }

      // The framework installs a per-request `RequestContext` before middleware
      // runs; mutate that instance so the chat route reads the same object. Fall
      // back to a fresh one (and re-set it) if a non-Hono path reaches here.
      const existing = c.get('requestContext') as RequestContext | undefined
      const rc = existing ?? new RequestContext()

      // NESTED convention — drives activeTools selection in agent.ts.
      rc.set('tenantContext', identity)
      // FLAT convention — validated by each tool's requestContextSchema.
      rc.set('tenantId', identity.tenantId)
      rc.set('userId', identity.userId)
      rc.set('userRole', identity.userRole)

      // Memory/resource scoping: a tenant-qualified resource id keeps threads
      // isolated per user within a tenant (§4.2). The same helper builds the
      // resource for the signal and session routes, so the three cannot drift.
      rc.set(MASTRA_RESOURCE_ID_KEY, resourceIdFor(identity))

      // Thread id comes from a header, not the body, so identity resolution
      // never has to read (or buffer) the streamed request body. When it is
      // absent a fresh id is minted rather than left unset: core memory needs
      // an active thread for the goal-state signal, and a missing threadId made
      // every run throw before the first model call. A minted thread is a
      // single-turn thread, which is the right semantics for "no conversation
      // yet" — the console sends `x-thread-id` on every turn after the first.
      const threadId = header('x-thread-id') ?? randomUUID()
      rc.set(MASTRA_THREAD_ID_KEY, threadId)

      if (!c.get('requestContext')) c.set('requestContext', rc)
      return next()
    },
  }

  return {
    port: env.CRUM_API_PORT,
    // Undefined keeps the framework default (loopback locally); a container sets
    // CRUM_API_HOST=0.0.0.0 so the console service reaches this plane over the
    // Compose network. See src/config/env.ts.
    host: env.CRUM_API_HOST,
    middleware: [identityMiddleware],
    apiRoutes: [
      chatRoute({
        path: '/chat/crm',
        agent: 'crm-assistant',
        version: 'v7',
        heartbeatMs: 10000,
      }),
      // Gmail connector: OAuth consent start + callback (src/api/gmail.ts).
      createGmailConnectRoute(env),
      createGmailCallbackRoute(env),
    ],
  }
}

/**
 * Builds the CRUM Mastra instance from a parsed environment.
 *
 * No module-level singleton on purpose. `parseEnv()` reads `process.env`, and a
 * singleton constructed at import time would make every test that touches this
 * module depend on the developer's shell. Phase 1 adds the Mastra CLI entrypoint
 * and constructs the singleton there, where the process environment is the right
 * thing to read.
 *
 * Phase 1 registers the crmAssistant agent and coreMemory. The agent carries
 * instructions, processors, and model configuration; memory uses
 * messageHistory.maxTokens (24_000), not lastMessages.
 */
export function createCrumMastra(env: CrumEnv, options: CrumMastraOptions = {}): Mastra {
  // Fail closed at boot, five phases before the MCP server exists. §13.8.
  assertMcpRequestStateKey(env)

  const storage = options.storage ?? buildMastraStorage(env)
  const memory = buildCrumMemory(storage)

  // §4.2 — Agent Controller for session orchestration. Phase 1 registers a
  // single controller backed by crmAssistant with one default mode. The
  // controller inherits the parent Mastra's storage via __registerMastra,
  // called internally when the controller is passed in agentControllers.
  const crmController = new AgentController({
    id: CRUM_AGENT_CONTROLLER_ID,
    modes: [{ id: 'default', name: 'Default' }],
    agent: crmAssistant,
    subagents: CRUM_SUBAGENTS,
  })

  // §10.3 — Resolve MCP request state key (ephemeral in dev, configured in prod)
  const mcpDecision = resolveMcpRequestState(env)
  if (mcpDecision.warning) {
    console.warn(`[CRUM] ${mcpDecision.warning}`)
  }
  const crumMcpServer = createCrumMcpServer(mcpDecision.key)

  return new Mastra({
    agents: {
      'crm-assistant': crmAssistant,
      'parser': parserAgent,
      'email-drafter': emailDrafterAgent,
      'digest': digestAgent,
    },
    workflows: {
      'knowledge-ingest': ingestWorkflow,
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

/**
 * Named export the Mastra CLI reads. The bundler resolves `src/mastra/index.ts`
 * as the entry file and requires an `export const mastra` at module scope, so
 * this is the process singleton used by `mastra dev` and `mastra build`.
 *
 * The factory above stays the primary surface for tests: they import
 * `createCrumMastra` and pass an injected env/storage, so they never read
 * `process.env`. The eager construction below only runs when this file is used
 * as the CLI entry (dev/build) or when a test imports the module by path —
 * which is safe because `parseEnv()` defaults to in-memory storage and an
 * ephemeral MCP request-state key when `DATABASE_URL` is unset, matching the
 * contract already proven in tests/entry/index.test.ts.
 *
 * Kept last so bundler tree-shaking doesn't reorder side effects before the
 * factory and helpers it depends on are defined.
 *
 * Memoised on `globalThis` rather than just constructed, because the bundler
 * evaluates this module more than once inside a single server process: four
 * routers under `src/api` import `createCrumMastra` from here, so the
 * dynamically-loaded `serve.mjs` chunk gets its own copy of this module, and
 * `node .mastra/output/index.mjs` was observed constructing a second registry.
 * A per-process global is the only seam that survives chunk duplication, and it
 * keeps the promise the paragraph above makes — one instance per process.
 */
interface EntryMastraGlobal {
  __crumEntryMastra?: Mastra
}

const entryEnv = parseEnv()
const entryHolder = globalThis as unknown as EntryMastraGlobal
export const mastra: Mastra = entryHolder.__crumEntryMastra ??= createCrumMastra(entryEnv)

/**
 * Process-level side effects: the digest schedule and the `/api` REST plane.
 *
 * They live here because this is the module the CLI actually executes. `mastra
 * dev` and `mastra build` bundle from `src/mastra/index.ts`, not from
 * `src/index.ts`, so anything placed in the latter is never evaluated by a
 * server the framework starts — observed in a real `mastra dev` boot that came
 * up with no REST plane listener, then confirmed by grepping the generated
 * `.mastra/output/index.mjs` and finding the plane's strings only in the
 * `.mastra/output/boot.mjs` and `serve.mjs` chunks the bundler splits out beside
 * it — that is where `src/mastra/boot.ts` and `src/api/serve.ts` ended up, not in
 * the dead `src/index.ts`.
 *
 * `bootCrumProcess` re-checks the environment and refuses to bind anything when
 * this module is loaded from source, because it is also the library barrel that
 * `src/api/*` and half the suite import.
 *
 * Imported lazily on purpose: every router under `src/api` imports this barrel,
 * so a static edge back to the plane would put the entry in a cycle and leave
 * `mastra` uninitialised while those routers are still being evaluated.
 */
if (entryEnv.NODE_ENV !== 'test') {
  void import('./boot')
    .then(({ bootCrumProcess }) => {
      const result = bootCrumProcess(entryEnv, mastra)
      // A server that decided not to boot must say why; the first `npm run
      // dev:all` came up looking healthy with no plane and no clue in the log.
      // Refusing a source-mode load is the normal case and stays quiet, and the
      // registry itself is memoised, so the duplicate evaluation this reports is
      // cheap.
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

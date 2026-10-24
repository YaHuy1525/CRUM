import { Mastra } from '@mastra/core/mastra'
import { AgentController } from '@mastra/core/agent-controller'
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
import { parserAgent } from './agents/parser'
import { emailDrafterAgent } from './agents/email-drafter'
import { createCrumMcpServer } from './mcp-server'

export interface CrumMastraOptions {
  /**
   * Inject a store instead of building one from the environment. Tests use this
   * to construct a real Mastra without opening a socket; nothing in production
   * passes it.
   */
  storage?: CrumStorage
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
    id: 'crm-assistant',
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
    },
    workflows: {
      'knowledge-ingest': ingestWorkflow,
      'crum-intent-triage': intentTriageFlow,
    },
    classifiers: {
      'crum-intent': intentClassifier,
      'crum-injection': injectionClassifier,
    },
    mcpServers: {
      'crum-crm': crumMcpServer,
    },
    storage,
    memory: {
      coreMemory: memory,
    },
    observability: buildObservability(env),
    agentControllers: {
      'crm-assistant': crmController,
    },
  })
}

export { OBSERVABILITY_INSTANCE, OBSERVABILITY_SERVICE_NAME } from './observability'
export { buildMastraStorage, isPostgresStorage, STORAGE_ID } from './storage'
export type { CrumStorage } from './storage'
export { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'
export { crmAssistant } from './agent'
export { buildCrumMemory } from './memory'
export { createSession, listSessions, queryThreads } from './sessions'
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
 */
export const mastra: Mastra = createCrumMastra(parseEnv())

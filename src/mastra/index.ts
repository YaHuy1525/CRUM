import { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { buildObservability } from './observability'
import { assertMcpRequestStateKey } from './mcp-guard'
import { buildMastraStorage } from './storage'
import type { CrumStorage } from './storage'
import { crmAssistant } from './agent'
import { buildCrumMemory } from './memory'

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

  return new Mastra({
    agents: {
      'crm-assistant': crmAssistant,
    },
    workflows: {},
    storage,
    memory: {
      coreMemory: memory,
    },
    observability: buildObservability(env),
  })
}

export { OBSERVABILITY_INSTANCE, OBSERVABILITY_SERVICE_NAME } from './observability'
export { buildMastraStorage, isPostgresStorage, STORAGE_ID } from './storage'
export type { CrumStorage } from './storage'
export { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'
export { crmAssistant } from './agent'
export { buildCrumMemory } from './memory'

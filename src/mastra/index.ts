import { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { buildObservability } from './observability'
import { assertMcpRequestStateKey } from './mcp-guard'
import { buildMastraStorage } from './storage'
import type { CrumStorage } from './storage'

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
 * Phase 0 mounts no agents and no workflows. §16's Phase 0 acceptance criterion
 * is that the instance constructs both with and without DATABASE_URL and refuses
 * to boot in production without MCP_REQUEST_STATE_KEY, which is what this
 * function does and what tests/mastra/boot.test.ts asserts.
 */
export function createCrumMastra(env: CrumEnv, options: CrumMastraOptions = {}): Mastra {
  // Fail closed at boot, five phases before the MCP server exists. §13.8.
  assertMcpRequestStateKey(env)

  const storage = options.storage ?? buildMastraStorage(env)

  return new Mastra({
    agents: {},
    workflows: {},
    storage,
    observability: buildObservability(env),
  })
}

export { OBSERVABILITY_INSTANCE, OBSERVABILITY_SERVICE_NAME } from './observability'
export { buildMastraStorage, isPostgresStorage, STORAGE_ID } from './storage'
export type { CrumStorage } from './storage'
export { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'

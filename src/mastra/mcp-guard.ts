import { randomBytes } from 'node:crypto'
import { isProduction } from '../config/env'
import type { CrumEnv } from '../config/env'

/**
 * Thrown when MCP continuation state cannot be configured safely. `variables`
 * carries names, never values.
 */
export class McpConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'McpConfigError'
    this.variables = variables
  }
}

export interface McpRequestStateDecision {
  /** False would mean do not mount the MCP server at all. CRUM never returns it. */
  mount: boolean
  /** The HMAC key to pass as `requestState.key`. Never logged. */
  key: string
  /** True when the key was generated for this process rather than configured. */
  ephemeral: boolean
  /** A warning to log when the decision is unsafe but recoverable. */
  warning: string | undefined
}

const EPHEMERAL_WARNING =
  'MCP_REQUEST_STATE_KEY is unset, so a per-process key was generated. input_required ' +
  'continuations will not survive a restart or a second replica. Set the variable before ' +
  'deploying (§10.3.3, §14.3).'

/**
 * Resolves the key that signs MCP `input_required` continuations.
 *
 * §10.3.3: MCP 2.0 is sessionless, so continuation state travels in a signed
 * `requestState` envelope, and on a server without authorization that envelope
 * acts as a bearer credential for its round. Without an explicit key the server
 * generates one per process and continuations only succeed on that process.
 *
 * In production that failure is intermittent, load-balancer dependent, and
 * invisible in a single-container preview: an approval suspends on replica A and
 * resumes on replica B and is rejected, with no local reproduction. So production
 * throws. Development gets a random per-process key and a warning, because a
 * laptop that cannot start is a worse outcome than a laptop whose continuations
 * do not survive a restart. §13.8 lists this as one of two fail-closed exceptions.
 *
 * The generated key is 32 random bytes, matching the EnvSchema floor for
 * configured secrets, and is never written to a log line.
 */
export function resolveMcpRequestState(env: CrumEnv): McpRequestStateDecision {
  const configured = env.MCP_REQUEST_STATE_KEY

  if (configured !== undefined && configured.length > 0) {
    return { mount: true, key: configured, ephemeral: false, warning: undefined }
  }

  if (isProduction(env)) {
    throw new McpConfigError(
      'MCP_REQUEST_STATE_KEY is required in production. Without it every replica mints its own ' +
        'signing key and an approval that suspends on one replica is rejected when it resumes on ' +
        'another. Set the same value in every replica environment (§10.3.3, §13.8, §14.3).',
      ['MCP_REQUEST_STATE_KEY'],
    )
  }

  return {
    mount: true,
    key: randomBytes(32).toString('base64url'),
    ephemeral: true,
    warning: EPHEMERAL_WARNING,
  }
}

/**
 * The boot-time check. Called by createCrumMastra so the failure happens when
 * the process starts rather than at the first MCP request in Phase 5.
 */
export function assertMcpRequestStateKey(env: CrumEnv): void {
  resolveMcpRequestState(env)
}

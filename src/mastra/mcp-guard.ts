import { randomBytes } from 'node:crypto'
import { isProduction } from '../config/env'
import type { CrumEnv } from '../config/env'

export class McpConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'McpConfigError'
    this.variables = variables
  }
}

export interface McpRequestStateDecision {
  mount: boolean
  key: string
  ephemeral: boolean
  warning: string | undefined
}

const EPHEMERAL_WARNING =
  'MCP_REQUEST_STATE_KEY is unset, so a per-process key was generated. input_required ' +
  'continuations will not survive a restart or a second replica. Set the variable before ' +
  'deploying (§10.3.3, §14.3).'

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

export function assertMcpRequestStateKey(env: CrumEnv): void {
  resolveMcpRequestState(env)
}

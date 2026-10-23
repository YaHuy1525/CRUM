import { parseEnv } from '../config/env'
import { loadPolicy, type GovernanceContext, type Policy, PolicyLoadError } from './policy'
import { domainOf, scoreRisk, type RiskAssessment } from './risk'
import type { Gate, ToolClass, ToolPolicyEntry } from './schema'

/**
 * The governance singleton, loaded at import time.
 *
 * Loading eagerly is deliberate. A malformed policy file becomes a boot failure
 * with a Zod-formatted message naming the file and the field, rather than a
 * request-time failure in the middle of a user's turn. §12.2: "loaded at boot,
 * asserted by tests". Tests that need a different policy call loadPolicy() with
 * a temporary directory instead of importing this.
 *
 * The singleton reads the parsed environment, not raw process.env: it must see
 * the same validated, defaulted environment as every other consumer, and a raw
 * read would let POLICY_DIR='' bypass parseEnv's ''→undefined normalization and
 * resolve policy files against cwd.
 */
export const policy: Policy = loadPolicy(parseEnv(process.env).POLICY_DIR)

export { domainOf, loadPolicy, PolicyLoadError, scoreRisk }
export type { Gate, GovernanceContext, Policy, RiskAssessment, ToolClass, ToolPolicyEntry }

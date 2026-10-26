import { parseEnv } from '../config/env'
import { loadPolicy, type GovernanceContext, type Policy, PolicyLoadError } from './policy'
import { domainOf, scoreRisk, type RiskAssessment } from './risk'
import type { Gate, ToolClass, ToolPolicyEntry } from './schema'

export const policy: Policy = loadPolicy(parseEnv(process.env).POLICY_DIR)

export { domainOf, loadPolicy, PolicyLoadError, scoreRisk }
export type { Gate, GovernanceContext, Policy, RiskAssessment, ToolClass, ToolPolicyEntry }

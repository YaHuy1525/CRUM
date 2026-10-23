import type { TenantRequestContext } from './tenant-context'
import { loadPolicy } from '../governance/policy'

/**
 * Returns the list of active tool names for a request context.
 *
 * Phase 2: all read-only tools are active for every authenticated caller.
 * The policy file (policy/tools.yaml) is the source of truth for tool classes.
 * TECHNICAL_PLAN.md §4.6.2.
 */
export function resolveActiveTools(_context: TenantRequestContext): string[] {
  const policy = loadPolicy()
  return policy.toolsByClass('read-only')
}

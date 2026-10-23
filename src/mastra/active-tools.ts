import type { TenantRequestContext } from './tenant-context'
import { loadPolicy } from '../governance/policy'

/**
 * Returns the list of active tool names for a request context.
 * Phase 3: read-only + auto + approval classes are active for every
 * authenticated caller. The refuse class (crm.bulk_import) is never active.
 */
export function resolveActiveTools(_context: TenantRequestContext): string[] {
  const policy = loadPolicy()
  return [
    ...policy.toolsByClass('read-only'),
    ...policy.toolsByClass('auto'),
    ...policy.toolsByClass('approval'),
  ]
}

import type { TenantRequestContext } from './tenant-context'
import { loadPolicy } from '../governance/policy'
import type { ToolClass } from '../governance/schema'

/**
 * Which permission classes each role may actually invoke.
 *
 * The classes come from policy/tools.yaml (§4.6.2), but the ROLE boundary is a
 * decision, not a table:
 *   - `user`  — acts only within their own rows, so read + low-blast-radius
 *                auto writes. No approval-gated mutating tools.
 *   - `admin` — acts tenant-wide, so additionally the approval-class writes.
 *   - `refuse` (crm.bulk_import) is never callable for anyone: §4.6.1 routes it
 *                to a human task instead of the agent.
 *
 * This mirrors tenantScope(), where an admin sees all rows and a user only their
 * own: the tools that mutate across the whole tenant are gated to the admin.
 */
const CALLABLE_CLASSES: Record<TenantRequestContext['userRole'], ToolClass[]> = {
  user: ['read-only', 'auto'],
  admin: ['read-only', 'auto', 'approval'],
}

/**
 * Returns the list of active tool names for a request context.
 *
 * policy/tools.yaml is the source of truth for tool CLASSES; the callable
 * surface is derived from them, minus anything that is not directly invocable.
 * A tool whose `scope` is a template (contains a `{`, e.g. `run.side-effect`'s
 * `{workflow}:{step}`) is resolved per workflow step at run time by
 * `scopeFor` — it is not a callable tool the agent can be handed, so it is
 * excluded here. The registry, not the YAML, is the truth for what a caller may
 * invoke. TECHNICAL_PLAN.md §4.6.2.
 */
export function resolveActiveTools(context: TenantRequestContext): string[] {
  const policy = loadPolicy()
  const names = new Set<string>()
  for (const klass of CALLABLE_CLASSES[context.userRole]) {
    for (const name of policy.toolsByClass(klass)) {
      names.add(name)
    }
  }
  return [...names].filter((name) => !(policy.toolByName.get(name)?.scope ?? '').includes('{'))
}

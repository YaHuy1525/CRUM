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

/**
 * Translate a registry tool id into the name the model is actually shown.
 *
 * `activeTools` is NOT matched against registry ids. Agent#formatTools
 * (@mastra/core 1.79.0, dist/agent-tuAMgHe3.js:45913) rewrites every tool key
 * in place — `[^a-zA-Z0-9_-]` becomes `_`, a non-letter first character gets a
 * `_` prefix, and the result is truncated to 63 — and it does so BEFORE the
 * step's `activeTools` filter (`prepareToolsAndToolChoice`, :799, which is a
 * plain `activeTools.includes(name)` over the already-rewritten keys). The
 * registry ids are all dotted (`crm.search`), so handing their dotted spelling
 * to `activeTools` matches nothing and the model is silently sent an EMPTY tool
 * list: the agent answers by inventing tool calls in prose (`crmAPI`,
 * `pg_vector`, `accounts_search`) and no tool ever executes. That is why this
 * mapping is applied at the agent boundary rather than inside
 * `resolveActiveTools`, whose dotted output is the governance vocabulary
 * (policy/tools.yaml, tests/mastra/active-tools.test.ts).
 *
 * The same rewritten name is what a dataset experiment's `toolMocks[].toolName`
 * is matched against, so the golden fixtures map through here too.
 */
const INVALID_TOOL_CHAR = /[^a-zA-Z0-9_-]/
const TOOL_START_CHAR = /[a-zA-Z_]/
const MAX_TOOL_NAME_LENGTH = 63

export function providerToolName(name: string): string {
  const needsRewrite =
    name.length > MAX_TOOL_NAME_LENGTH ||
    INVALID_TOOL_CHAR.test(name) ||
    !TOOL_START_CHAR.test(name[0] ?? '')
  if (!needsRewrite) return name
  let rewritten = name.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
  if (!TOOL_START_CHAR.test(rewritten[0] ?? '')) rewritten = `_${rewritten}`
  return rewritten.slice(0, MAX_TOOL_NAME_LENGTH)
}

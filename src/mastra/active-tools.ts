import type { TenantRequestContext } from './tenant-context'
import { loadPolicy } from '../governance/policy'
import type { ToolClass } from '../governance/schema'

const CALLABLE_CLASSES: Record<TenantRequestContext['userRole'], ToolClass[]> = {
  user: ['read-only', 'auto'],
  admin: ['read-only', 'auto', 'approval'],
}

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

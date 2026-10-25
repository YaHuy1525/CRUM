import { describe, it, expect } from 'vitest'
import { resolveActiveTools, providerToolName } from '../../src/mastra/active-tools'
import type { TenantRequestContext } from '../../src/mastra/tenant-context'

const baseContext: TenantRequestContext = {
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  userRole: 'user',
}

// Read-only is active for every authenticated caller.
const READ_ONLY_TOOLS = [
  'crm.list_customers',
  'crm.get_customer',
  'crm.find_contacts',
  'crm.list_followups',
  'crm.list_tasks',
  'crm.list_schedules',
  'crm.my_open_items',
  'crm.search',
  'knowledge.retrieve',
  'mail.search_threads',
]

// Auto-class low-blast-radius writes: active for every role.
const AUTO_TOOLS = ['crm.log_followup', 'crm.create_task', 'mail.draft']

// Approval-class writes: admin-only, tenant-wide.
const APPROVAL_TOOLS = [
  'crm.create_customer',
  'crm.update_customer',
  'crm.delete_customer',
  'crm.create_contact',
  'crm.create_schedule',
  'crm.transfer_owner',
  'mail.send',
]

// Never callable, regardless of role:
//  - run.side-effect: scope template `{workflow}:{step}`, resolved at run time,
//    not a tool the agent can be handed.
//  - crm.bulk_import: refuse class → routed to a human task (§4.6.1).
const NEVER_CALLABLE = ['run.side-effect', 'crm.bulk_import']

const USER_EXPECTED = [...READ_ONLY_TOOLS, ...AUTO_TOOLS] // 13
const ADMIN_EXPECTED = [...READ_ONLY_TOOLS, ...AUTO_TOOLS, ...APPROVAL_TOOLS] // 20

describe('resolveActiveTools', () => {
  it('gives a non-admin the read-only + auto tools (13)', () => {
    const active = resolveActiveTools(baseContext)
    expect(active).toHaveLength(13)
    expect(active.slice().sort()).toEqual(USER_EXPECTED.slice().sort())
  })

  it('gives an admin the approval-class writes too (20)', () => {
    const active = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    expect(active).toHaveLength(20)
    expect(active.slice().sort()).toEqual(ADMIN_EXPECTED.slice().sort())
  })

  it('honours role: admin is a strict superset of user', () => {
    const user = resolveActiveTools(baseContext)
    const admin = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    for (const name of user) expect(admin).toContain(name)
    for (const name of APPROVAL_TOOLS) {
      expect(admin).toContain(name)
      expect(user).not.toContain(name)
    }
  })

  it('never exposes the template or refuse tools to either role', () => {
    const user = resolveActiveTools(baseContext)
    const admin = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    for (const name of NEVER_CALLABLE) {
      expect(user).not.toContain(name)
      expect(admin).not.toContain(name)
    }
  })

  it('tool names all come from the policy registry', () => {
    const active = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    for (const name of active) expect(name).toMatch(/^(crm|knowledge|mail)\./)
  })
})

// Agent#formatTools (@mastra/core 1.79.0) rewrites the registry keys in place
// before anything consumes them, so `activeTools`, `toolMocks[].toolName` and
// the tool names a processor sees are all in the rewritten form. Handing the
// dotted id to any of them matches nothing — for `activeTools` that silently
// leaves the model with an empty tool list. providerToolName is the single
// mapping, so it is pinned against the shipped behaviour.
describe('providerToolName', () => {
  it('rewrites the dotted registry ids the agent actually registers', () => {
    expect(providerToolName('crm.search')).toBe('crm_search')
    expect(providerToolName('knowledge.retrieve')).toBe('knowledge_retrieve')
    expect(providerToolName('mail.draft')).toBe('mail_draft')
    expect(providerToolName('crm.list_customers')).toBe('crm_list_customers')
  })

  it('is the identity for names the provider already accepts', () => {
    for (const name of ['crm_list_customers', 'get_email', 'a-b_9']) {
      expect(providerToolName(name)).toBe(name)
    }
  })

  it('prefixes, replaces and truncates the way formatTools does', () => {
    // first character not a letter/underscore gets an underscore prefix
    expect(providerToolName('9lives')).toBe('_9lives')
    // every character outside [A-Za-z0-9_-] becomes an underscore
    expect(providerToolName('crm.search:v2/sub')).toBe('crm_search_v2_sub')
    // and the result is capped at the provider limit
    expect(providerToolName(`${'x'.repeat(70)}.y`)).toHaveLength(63)
  })

  it('leaves no dotted id in the list the agent hands the model', () => {
    const providerNames = resolveActiveTools({ ...baseContext, userRole: 'admin' }).map(providerToolName)
    expect(providerNames).toHaveLength(20)
    for (const name of providerNames) {
      expect(name).not.toContain('.')
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/)
    }
    // the mapping is injective, so no two registry ids collapse onto one tool
    // (formatTools throws AGENT_TOOL_NAME_COLLISION if they did)
    expect(new Set(providerNames).size).toBe(providerNames.length)
  })
})

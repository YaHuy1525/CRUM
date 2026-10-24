import { describe, it, expect } from 'vitest'
import { resolveActiveTools } from '../../src/mastra/active-tools'
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

const USER_EXPECTED = [...READ_ONLY_TOOLS, ...AUTO_TOOLS] // 12
const ADMIN_EXPECTED = [...READ_ONLY_TOOLS, ...AUTO_TOOLS, ...APPROVAL_TOOLS] // 19

describe('resolveActiveTools', () => {
  it('gives a non-admin the read-only + auto tools (12)', () => {
    const active = resolveActiveTools(baseContext)
    expect(active).toHaveLength(12)
    expect(active.slice().sort()).toEqual(USER_EXPECTED.slice().sort())
  })

  it('gives an admin the approval-class writes too (19)', () => {
    const active = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    expect(active).toHaveLength(19)
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

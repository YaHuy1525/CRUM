import { describe, it, expect } from 'vitest'
import { resolveActiveTools } from '../../src/mastra/active-tools'
import type { TenantRequestContext } from '../../src/mastra/tenant-context'

const baseContext: TenantRequestContext = {
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  userRole: 'user',
}

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

const AUTO_TOOLS = [
  'crm.log_followup',
  'crm.create_task',
  'mail.draft',
]

const APPROVAL_TOOLS = [
  'crm.create_customer',
  'crm.update_customer',
  'crm.delete_customer',
  'crm.create_contact',
  'crm.create_schedule',
  'crm.transfer_owner',
  'mail.send',
  'run.side-effect',
]

const REFUSE_TOOLS = [
  'crm.bulk_import',
]

describe('resolveActiveTools', () => {
  it('returns all 20 active tool names (read-only + auto + approval)', () => {
    const active = resolveActiveTools(baseContext)
    expect(active).toHaveLength(20)
    for (const name of READ_ONLY_TOOLS) {
      expect(active).toContain(name)
    }
    for (const name of AUTO_TOOLS) {
      expect(active).toContain(name)
    }
    for (const name of APPROVAL_TOOLS) {
      expect(active).toContain(name)
    }
  })

  it('does not include refuse-class tools', () => {
    const active = resolveActiveTools(baseContext)
    for (const name of REFUSE_TOOLS) {
      expect(active).not.toContain(name)
    }
  })

  it('returns the same tools regardless of user role', () => {
    const userTools = resolveActiveTools(baseContext)
    const adminTools = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    expect(userTools).toEqual(adminTools)
  })

  it('tool names match policy classes read-only + auto + approval', () => {
    const active = resolveActiveTools(baseContext)
    const expected = [...READ_ONLY_TOOLS, ...AUTO_TOOLS, ...APPROVAL_TOOLS]
    expect(active.sort()).toEqual(expected.sort())
  })
})

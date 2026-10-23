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

const MUTATING_TOOLS = [
  'crm.create_customer',
  'crm.update_customer',
  'crm.delete_customer',
  'crm.create_contact',
  'crm.create_schedule',
  'crm.transfer_owner',
  'crm.create_task',
  'crm.log_followup',
  'mail.draft',
  'mail.send',
  'crm.bulk_import',
  'run.side-effect',
]

describe('resolveActiveTools', () => {
  it('returns all 9 read-only tool names', () => {
    const active = resolveActiveTools(baseContext)
    expect(active).toHaveLength(9)
    for (const name of READ_ONLY_TOOLS) {
      expect(active).toContain(name)
    }
  })

  it('does not include mutating tools', () => {
    const active = resolveActiveTools(baseContext)
    for (const name of MUTATING_TOOLS) {
      expect(active).not.toContain(name)
    }
  })

  it('returns the same tools regardless of user role', () => {
    const userTools = resolveActiveTools(baseContext)
    const adminTools = resolveActiveTools({ ...baseContext, userRole: 'admin' })
    expect(userTools).toEqual(adminTools)
  })

  it('tool names match policy/tools.yaml', () => {
    const active = resolveActiveTools(baseContext)
    expect(active.sort()).toEqual(READ_ONLY_TOOLS.slice().sort())
  })
})

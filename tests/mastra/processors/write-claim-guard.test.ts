import { describe, it, expect } from 'vitest'
import { WriteClaimGuardProcessor, MUTATING_TOOLS } from '../../../src/mastra/processors/write-claim-guard'

describe('WriteClaimGuardProcessor', () => {
  it('has the correct id', () => {
    const proc = new WriteClaimGuardProcessor()
    expect(proc.id).toBe('crum-write-claim-guard')
  })

  it('MUTATING_TOOLS contains all auto and approval tool ids', () => {
    expect(MUTATING_TOOLS.has('crm.create_customer')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.update_customer')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.delete_customer')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.create_contact')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.create_schedule')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.transfer_owner')).toBe(true)
    expect(MUTATING_TOOLS.has('mail.send')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.log_followup')).toBe(true)
    expect(MUTATING_TOOLS.has('crm.create_task')).toBe(true)
    expect(MUTATING_TOOLS.has('mail.draft')).toBe(true)
  })

  it('MUTATING_TOOLS does not contain read-only tool ids', () => {
    expect(MUTATING_TOOLS.has('crm.list_customers')).toBe(false)
    expect(MUTATING_TOOLS.has('crm.get_customer')).toBe(false)
    expect(MUTATING_TOOLS.has('knowledge.retrieve')).toBe(false)
  })
})

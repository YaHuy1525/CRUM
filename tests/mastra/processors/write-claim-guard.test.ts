import { describe, it, expect } from 'vitest'
import { WriteClaimGuardProcessor, MUTATING_TOOLS, MUTATING_TOOL_IDS } from '../../../src/mastra/processors/write-claim-guard'
import { providerToolName } from '../../../src/mastra/active-tools'

describe('WriteClaimGuardProcessor', () => {
  it('has the correct id', () => {
    const proc = new WriteClaimGuardProcessor()
    expect(proc.id).toBe('crum-write-claim-guard')
  })

  it('MUTATING_TOOLS contains all mutating tools in provider-facing form', () => {
    // MUTATING_TOOLS holds the sanitized names (post Agent#formatTools), which is
    // what processOutputStep receives. Check via providerToolName so the
    // assertion tracks any future registry-id renames automatically.
    for (const id of MUTATING_TOOL_IDS) {
      expect(MUTATING_TOOLS.has(providerToolName(id))).toBe(true)
    }
    // Spot-check the actual names to guard against a providerToolName regression.
    expect(MUTATING_TOOLS.has('crm_create_customer')).toBe(true)
    expect(MUTATING_TOOLS.has('crm_log_followup')).toBe(true)
    expect(MUTATING_TOOLS.has('mail_draft')).toBe(true)
    expect(MUTATING_TOOLS.has('mail_send')).toBe(true)
  })

  it('MUTATING_TOOLS does not contain read-only tool names', () => {
    expect(MUTATING_TOOLS.has(providerToolName('crm.list_customers'))).toBe(false)
    expect(MUTATING_TOOLS.has(providerToolName('crm.get_customer'))).toBe(false)
    expect(MUTATING_TOOLS.has(providerToolName('knowledge.retrieve'))).toBe(false)
  })

  it('MUTATING_TOOL_IDS lists every write tool by registry id', () => {
    // The governance vocabulary (policy/tools.yaml and tests) uses dotted ids.
    expect(MUTATING_TOOL_IDS).toContain('crm.create_customer')
    expect(MUTATING_TOOL_IDS).toContain('crm.update_customer')
    expect(MUTATING_TOOL_IDS).toContain('crm.delete_customer')
    expect(MUTATING_TOOL_IDS).toContain('crm.create_contact')
    expect(MUTATING_TOOL_IDS).toContain('crm.create_schedule')
    expect(MUTATING_TOOL_IDS).toContain('crm.transfer_owner')
    expect(MUTATING_TOOL_IDS).toContain('mail.send')
    expect(MUTATING_TOOL_IDS).toContain('crm.log_followup')
    expect(MUTATING_TOOL_IDS).toContain('crm.create_task')
    expect(MUTATING_TOOL_IDS).toContain('mail.draft')
    expect(MUTATING_TOOL_IDS).toHaveLength(10)
  })
})

// tests/governance/denial-path.test.ts
import { describe, it, expect } from 'vitest'
import { loadPolicy } from '../../src/governance/policy'
import { scoreRisk } from '../../src/governance/risk'

/**
 * Policy denial-path tests. §12.2: every approval-class tool must have a test
 * verifying that when scoreRisk returns a score >= refuse_at, the gate is 'refuse'.
 *
 * These are unit tests against the policy + risk modules, not integration tests
 * against the tools. The tool-level refuse path (beforeApproval creating a
 * human task) is tested by the tool tests.
 */

const REFUSE_THRESHOLD = 80 // from risk.yaml gates.refuse_at

describe('policy denial path', () => {
  const policy = loadPolicy()

  const approvalTools = [
    'crm.create_customer',
    'crm.update_customer',
    'crm.delete_customer',
    'crm.create_contact',
    'crm.create_schedule',
    'crm.transfer_owner',
    'mail.send',
  ]

  for (const toolName of approvalTools) {
    it(`${toolName}: score >= ${REFUSE_THRESHOLD} produces gate 'refuse'`, () => {
      // Craft a payload that triggers irreversible + high-blast terms
      const draft = { name: 'delete all customers permanently' }
      const assessment = scoreRisk(draft, policy.risk, toolName)
      expect(assessment.score).toBeGreaterThanOrEqual(REFUSE_THRESHOLD)
      const gate = policy.gateFor(toolName, assessment)
      expect(gate).toBe('refuse')
    })

    it(`${toolName}: low score produces gate 'approval' (declared class)`, () => {
      const draft = { name: 'Acme Corp' }
      const assessment = scoreRisk(draft, policy.risk, toolName)
      expect(assessment.score).toBeLessThan(REFUSE_THRESHOLD)
      const gate = policy.gateFor(toolName, assessment)
      expect(gate).toBe('approval')
    })
  }

  it('crm.bulk_import: always refuse regardless of score', () => {
    const draft = { name: 'small import' }
    const assessment = scoreRisk(draft, policy.risk, 'crm.bulk_import')
    const gate = policy.gateFor('crm.bulk_import', assessment)
    expect(gate).toBe('refuse')
  })
})

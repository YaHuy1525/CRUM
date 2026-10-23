import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '@/governance/policy'
import { domainOf, scoreRisk } from '@/governance/risk'

const policy = loadPolicy(join(process.cwd(), 'policy'))
const risk = policy.risk

describe('domainOf', () => {
  it.each([
    ['crm.delete_customer', 'customer'],
    ['crm.create_customer', 'customer'],
    ['crm.list_customers', 'customer'],
    ['crm.get_customer', 'customer'],
    ['crm.find_contacts', 'contact'],
    ['crm.list_followups', 'followup'],
    ['crm.list_tasks', 'task'],
    ['crm.create_schedule', 'schedule'],
    ['mail.send', 'mail'],
    ['mail.draft', 'mail'],
    ['knowledge.retrieve', 'knowledge'],
  ])('infers %s as %s', (toolName, domain) => {
    expect(domainOf(toolName)).toBe(domain)
  })

  it.each([
    ['crm.transfer_owner', 'owner'],
    ['crm.my_open_items', undefined],
    ['crm.search', undefined],
    ['crm.bulk_import', undefined],
    ['run.side-effect', undefined],
    [undefined, undefined],
  ])('returns %s for %s', (toolName, expected) => {
    expect(domainOf(toolName)).toBe(expected)
  })

  it('prefers an explicit objectType from the request context', () => {
    expect(domainOf('run.side-effect', { requestContext: { objectType: 'customer' } })).toBe(
      'customer',
    )
  })
})

describe('scoreRisk term matching', () => {
  it('does not treat "all" inside "called" as a high-blast term', () => {
    // The false positive this asserts against would raise crm.log_followup from
    // auto to approval and put every phone log in the human queue.
    const assessment = scoreRisk({ notes: 'called the client about the wallet' }, risk, 'crm.log_followup')
    expect(assessment.score).toBe(risk.preflight.scores.benign)
    expect(assessment.reasons).toEqual([])
  })

  it('matches "all" as a whole token', () => {
    const assessment = scoreRisk({ note: 'delete all records' }, risk, 'crm.delete_customer')
    expect(assessment.score).toBe(risk.preflight.scores.irreversible_high_blast)
  })

  it('keeps a hyphenated term as one token', () => {
    const assessment = scoreRisk({ note: 'team-wide rollout' }, risk, 'crm.update_customer')
    expect(assessment.reasons.join(' ')).toContain('team-wide')
    expect(assessment.score).toBe(risk.preflight.scores.single_risk)
  })

  it('matches a multi-word sensitive marker as a phrase', () => {
    const assessment = scoreRisk({ notes: 'stored a home address on the record' }, risk, 'crm.update_customer')
    expect(assessment.sensitive).toBe(true)
    expect(assessment.reasons.join(' ')).toContain('home address')
  })

  it('does not match a marker inside a longer word', () => {
    const assessment = scoreRisk({ notes: 'works in healthcare staffing' }, risk, 'crm.update_customer')
    expect(assessment.sensitive).toBe(false)
  })

  it('survives a circular draft and a BigInt without throwing', () => {
    const circular: Record<string, unknown> = { name: 'Acme' }
    circular['self'] = circular
    expect(() => scoreRisk(circular, risk, 'crm.create_customer')).not.toThrow()
    expect(() => scoreRisk({ n: BigInt(1) }, risk, 'crm.create_customer')).not.toThrow()
  })
})

describe('scoreRisk bands', () => {
  const { scores } = risk.preflight

  it('scores a benign draft at the benign level', () => {
    expect(scoreRisk({ city: 'Lisbon' }, risk, 'crm.list_customers').score).toBe(scores.benign)
  })

  it('scores a single irreversible term at single_risk', () => {
    expect(scoreRisk({ id: 'x' }, risk, 'crm.delete_customer').score).toBe(scores.single_risk)
  })

  it('scores a domain term at single_risk', () => {
    // crm.update_customer is not itself an irreversible verb, but the customer
    // domain requires approval for `merge`.
    const assessment = scoreRisk({ operation: 'merge', into: 'y' }, risk, 'crm.update_customer')
    expect(assessment.score).toBe(scores.single_risk)
    expect(assessment.reasons.join(' ')).toContain('domain customer')
  })

  it('scores irreversible plus high-blast at the top level', () => {
    const assessment = scoreRisk(
      { note: 'export every customer to production' },
      risk,
      'crm.update_customer',
    )
    expect(assessment.score).toBe(scores.irreversible_high_blast)
    expect(assessment.reasons.join(' ')).toContain('irreversible')
    expect(assessment.reasons.join(' ')).toContain('high-blast')
  })

  it('flags sensitivity without changing the score', () => {
    const assessment = scoreRisk({ notes: 'salary band discussed' }, risk, 'crm.log_followup')
    expect(assessment.sensitive).toBe(true)
    expect(assessment.score).toBe(scores.benign)
  })

  it('omits toolName cleanly when the caller uses the two-argument form', () => {
    // §4.6.1 calls scoreRisk(input, policy.risk). That must still work.
    expect(scoreRisk({ note: 'bulk delete' }, risk).score).toBe(scores.irreversible_high_blast)
  })

  it('returns deterministic reasons in a stable order', () => {
    const a = scoreRisk({ note: 'delete all' }, risk, 'crm.delete_customer')
    const b = scoreRisk({ note: 'delete all' }, risk, 'crm.delete_customer')
    expect(a.reasons).toEqual(b.reasons)
  })
})

describe('gateFor monotonicity', () => {
  const benign = { score: 10, sensitive: false, reasons: [] }
  const risky = { score: 55, sensitive: false, reasons: [] }
  const severe = { score: 90, sensitive: false, reasons: [] }

  it('raises a read-only tool through both bands', () => {
    expect(policy.gateFor('crm.list_customers', benign)).toBe('auto')
    expect(policy.gateFor('crm.list_customers', risky)).toBe('approval')
    expect(policy.gateFor('crm.list_customers', severe)).toBe('refuse')
  })

  it('never lowers a declared refuse', () => {
    expect(policy.gateFor('crm.bulk_import', benign)).toBe('refuse')
    expect(policy.gateFor('crm.bulk_import', risky)).toBe('refuse')
    expect(policy.gateFor('crm.bulk_import', severe)).toBe('refuse')
  })

  it('raises an auto tool on a sensitive marker alone', () => {
    const sensitiveBenign = { score: 10, sensitive: true, reasons: ['sensitive'] }
    expect(policy.gateFor('crm.log_followup', sensitiveBenign)).toBe('approval')
  })

  it('never raises a sensitive floor above a score-driven refuse', () => {
    const sensitiveSevere = { score: 90, sensitive: true, reasons: [] }
    expect(policy.gateFor('crm.list_customers', sensitiveSevere)).toBe('refuse')
  })

  it('refuses an unknown tool whatever the score', () => {
    expect(policy.gateFor('crm.not_in_policy', benign)).toBe('refuse')
    expect(policy.gateFor('', benign)).toBe('refuse')
  })

  it('treats every registered tool as gated at or above its declared class', () => {
    // Walks the whole policy file. No tool may resolve to `auto` when it is
    // declared `approval` or `refuse`.
    for (const tool of policy.tools.tools) {
      const gate = policy.gateFor(tool.name, benign)
      if (tool.class === 'approval') expect(gate, tool.name).toBe('approval')
      if (tool.class === 'refuse') expect(gate, tool.name).toBe('refuse')
      if (tool.class === 'read-only' || tool.class === 'auto') {
        expect(['auto', 'approval', 'refuse'], tool.name).toContain(gate)
      }
    }
  })
})

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '@/governance/policy'
import { scoreRisk } from '@/governance/risk'

const policy = loadPolicy(join(process.cwd(), 'policy'))

/**
 * Seven tools, not the nine the spec table sketches: import is an operator CLI
 * and merge is a pairwise review, so neither is a bulk tool. `crm.merge_prospects`
 * is deliberately absent — resolution goes through `crm.resolve_merge_candidate`,
 * which merges one reviewed pair or dismisses it.
 */
const PROSPECT_TOOLS = [
  'crm.list_prospects',
  'crm.get_prospect',
  'crm.draft_outreach',
  'crm.send_outreach',
  'crm.save_prospect_snapshot',
  'crm.list_merge_candidates',
  'crm.resolve_merge_candidate',
]

describe('prospect tool policy', () => {
  it('declares every implemented prospect tool', () => {
    for (const name of PROSPECT_TOOLS) {
      expect(policy.toolByName.get(name), name).toBeDefined()
    }
  })

  it('declares no prospect tool without an implementation', () => {
    for (const name of ['crm.import_prospects', 'crm.merge_prospects']) {
      expect(policy.toolByName.get(name), name).toBeUndefined()
    }
  })

  it('forces a send through approval', () => {
    const assessment = scoreRisk(
      { body: 'hello', channel: 'instagram' },
      policy.risk,
      'crm.send_outreach',
    )
    expect(policy.gateFor('crm.send_outreach', assessment)).toBe('approval')
  })

  it('forces a merge resolution through approval', () => {
    const assessment = scoreRisk(
      { candidateId: 'x', survivorId: 'y', decision: 'merge' },
      policy.risk,
      'crm.resolve_merge_candidate',
    )
    expect(policy.gateFor('crm.resolve_merge_candidate', assessment)).toBe('approval')
  })

  it('keeps reads automatic', () => {
    const assessment = scoreRisk({ country: 'AU' }, policy.risk, 'crm.list_prospects')
    expect(policy.gateFor('crm.list_prospects', assessment)).toBe('auto')
  })

  it('keeps drafting and snapshots automatic', () => {
    for (const name of ['crm.draft_outreach', 'crm.save_prospect_snapshot']) {
      const assessment = scoreRisk({ correlationId: 'corr-1' }, policy.risk, name)
      expect(policy.gateFor(name, assessment), name).toBe('auto')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { toScoreRow } from '../../../src/prospects/persist-score'

describe('toScoreRow', () => {
  it('flattens a score into the column shape prospect_scores expects', () => {
    const row = toScoreRow({
      prospectId: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      audience: { count: 12000, basis: 'followers' },
      offers: { priceVisible: false, sellsSomething: true },
      weaknessSignals: ['no_website'],
      reachability: 'dm',
    })
    expect(row.prospectId).toBe('11111111-1111-1111-1111-111111111111')
    expect(row.weightsVersion).toBe('2026-10-30.1')
    expect(row.band).toBe('small')
    expect(row.total).toBeGreaterThan(0)
  })
})

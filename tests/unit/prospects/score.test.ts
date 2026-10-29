import { describe, expect, it } from 'vitest'
import { scoreProspect, WEIGHTS_VERSION } from '../../../src/prospects/score'

const base = {
  audience: { count: 8000, basis: 'followers' as const },
  offers: { priceVisible: false, sellsSomething: true },
  weaknessSignals: ['no_website', 'no_lead_magnet'],
  reachability: 'dm' as const,
}

describe('scoreProspect', () => {
  it('returns a score with the current weights version', () => {
    const s = scoreProspect(base)
    expect(s.weightsVersion).toBe(WEIGHTS_VERSION)
    expect(s.total).toBeGreaterThan(0)
    expect(s.total).toBeLessThanOrEqual(100)
  })

  it('rates 500 connections below 500 followers', () => {
    const connections = scoreProspect({ ...base, audience: { count: 500, basis: 'linkedin_connections' } })
    const followers = scoreProspect({ ...base, audience: { count: 500, basis: 'followers' } })
    expect(connections.audience).toBeLessThan(followers.audience)
  })

  it('penalises audiences above fifty thousand', () => {
    const big = scoreProspect({ ...base, audience: { count: 60000, basis: 'followers' } })
    const mid = scoreProspect({ ...base, audience: { count: 45000, basis: 'followers' } })
    expect(big.total).toBeLessThan(mid.total)
  })

  it('rewards a hidden price and a missing funnel', () => {
    const weak = scoreProspect({ ...base, weaknessSignals: ['no_website', 'no_lead_magnet', 'no_email_capture', 'no_funnel'] })
    const strong = scoreProspect({ ...base, weaknessSignals: [] })
    expect(weak.funnelGap).toBeGreaterThan(strong.funnelGap)
  })

  it('bands on audience size', () => {
    expect(scoreProspect({ ...base, audience: { count: 900, basis: 'followers' } }).band).toBe('micro')
    expect(scoreProspect({ ...base, audience: { count: 9000, basis: 'followers' } }).band).toBe('small')
    expect(scoreProspect({ ...base, audience: { count: 30000, basis: 'followers' } }).band).toBe('mid')
    expect(scoreProspect({ ...base, audience: { count: 90000, basis: 'followers' } }).band).toBe('big')
  })

  it('never returns a negative total', () => {
    const s = scoreProspect({ audience: { count: 500000, basis: 'followers' }, offers: { priceVisible: false, sellsSomething: false }, weaknessSignals: [], reachability: 'none' })
    expect(s.total).toBeGreaterThanOrEqual(0)
  })
})

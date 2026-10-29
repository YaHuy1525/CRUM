import { describe, expect, it } from 'vitest'
import { checkSendCaps, type SendLedgerEntry } from '../../../src/prospects/caps'

const now = new Date('2026-10-30T02:00:00Z')

function entry(prospectId: string, hoursAgo = 1, channel: SendLedgerEntry['channel'] = 'instagram'): SendLedgerEntry {
  return { prospectId, channel, sentAt: new Date(now.getTime() - hoursAgo * 3600_000) }
}

const base = {
  prospectId: 'p1',
  channel: 'instagram' as const,
  kind: 'dm' as const,
  now,
  timeZone: 'Australia/Sydney',
  consented: false,
  ledger: [] as SendLedgerEntry[],
}

describe('checkSendCaps', () => {
  it('allows the first DM', () => {
    expect(checkSendCaps(base).allowed).toBe(true)
  })

  it('blocks the twenty first DM of the day', () => {
    const ledger = Array.from({ length: 20 }, (_, i) => entry(`other-${i}`, 0.5))
    const decision = checkSendCaps({ ...base, ledger })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('daily_cap')
  })

  it('blocks a second touch inside the cooldown', () => {
    const decision = checkSendCaps({ ...base, ledger: [entry('p1', 24 * 3)] })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('blocks a fourth touch', () => {
    const ledger = [entry('p1', 24 * 40), entry('p1', 24 * 30), entry('p1', 24 * 20)]
    const decision = checkSendCaps({ ...base, ledger })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('touch_limit')
  })

  it('blocks automated email without consent', () => {
    const decision = checkSendCaps({ ...base, channel: 'email', kind: 'email' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('no_consent')
  })

  it('allows automated email with consent', () => {
    expect(checkSendCaps({ ...base, channel: 'email', kind: 'email', consented: true }).allowed).toBe(true)
  })

  it('blocks during local quiet hours', () => {
    const midnight = new Date('2026-10-30T13:00:00Z')
    const decision = checkSendCaps({ ...base, now: midnight })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('quiet_hours')
  })
})

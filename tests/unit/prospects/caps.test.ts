import { describe, expect, it } from 'vitest'
import { checkSendCaps, type SendLedgerEntry } from '../../../src/prospects/caps'

const now = new Date('2026-10-30T02:00:00Z')

function entry(
  prospectId: string,
  hoursAgo = 1,
  channel: SendLedgerEntry['channel'] = 'instagram',
  kind: SendLedgerEntry['kind'] = 'dm',
): SendLedgerEntry {
  return { prospectId, channel, kind, sentAt: new Date(now.getTime() - hoursAgo * 3600_000) }
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

  it('counts the daily DM budget across channels, not per channel', () => {
    // Twenty Instagram DMs plus one LinkedIn DM is 21 DMs in one day. Counting
    // per channel would let each channel spend its own twenty and see this as
    // an allowed, nearly empty day.
    const ledger = [
      ...Array.from({ length: 20 }, (_, i) => entry(`ig-${i}`, 0.5, 'instagram', 'dm')),
      entry('li-1', 0.5, 'linkedin', 'dm'),
    ]
    expect(checkSendCaps({ ...base, channel: 'linkedin', ledger })).toEqual({
      allowed: false,
      reason: 'daily_cap',
    })
  })

  it('keeps each kind on its own daily budget', () => {
    // Twenty DMs exhaust only the DM budget; a consented email send is still
    // allowed, so the email budget is not spent by DM volume.
    const ledger = Array.from({ length: 20 }, (_, i) => entry(`ig-${i}`, 0.5, 'instagram', 'dm'))
    expect(checkSendCaps({ ...base, channel: 'email', kind: 'email', consented: true, ledger }).allowed).toBe(true)
  })

  it('blocks a second touch inside the cooldown', () => {
    const decision = checkSendCaps({ ...base, ledger: [entry('p1', 24 * 3)] })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('allows a second touch at exactly fourteen days', () => {
    const decision = checkSendCaps({ ...base, ledger: [entry('p1', 24 * 14)] })
    expect(decision).toEqual({ allowed: true, reason: 'ok' })
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

  it('blocks a manual send on the email channel without consent', () => {
    // Consent follows the channel, not the kind: a "manual" email still
    // messages an address.
    const decision = checkSendCaps({ ...base, channel: 'email', kind: 'manual' })
    expect(decision).toEqual({ allowed: false, reason: 'no_consent' })
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

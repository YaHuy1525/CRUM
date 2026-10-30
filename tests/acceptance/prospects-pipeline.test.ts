// tests/acceptance/prospects-pipeline.test.ts
//
// End-to-end acceptance for the prospect slice against the operator's real
// list: tests/fixtures/prospects-acceptance.csv is a byte copy of
// C:\Users\ASUS\Downloads\businesses_prospects.csv (312 data rows). Do not
// regenerate or trim it; the counts in this file are facts about that frozen
// fixture and a change in them means the pipeline changed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCsv, parseProspectRows, type ParsedRow } from '../../src/prospects/csv'
import { importRefusals, inspectImportRows, planImport } from '../../src/prospects/import'
import { scoreProspect, WEIGHTS_VERSION } from '../../src/prospects/score'
import { reachabilityFor } from '../../src/prospects/reachability'
import { checkSendCaps, type SendLedgerEntry } from '../../src/prospects/caps'
import { checkDraft } from '../../src/prospects/draft-rules'
import { formatMinor } from '../../console/lib/money'

const csv = readFileSync('tests/fixtures/prospects-acceptance.csv', 'utf8')
const raw = parseCsv(csv)
const rows = parseProspectRows(raw)

function toExisting(row: ParsedRow) {
  return {
    name: row.name,
    country: row.country,
    platform: row.platform,
    handleNormalized: row.handleNormalized,
  }
}

// Outreach channel, not the raw platform label: the mapping lives in
// src/prospects/reachability.ts so the score script and this file cannot drift.

describe('prospect pipeline acceptance', () => {
  it('reads every row in the file without rejecting any', () => {
    const inspection = inspectImportRows(raw)
    expect(inspection.dataRows).toBe(312)
    expect(inspection.rejected).toEqual([])
    expect(inspection.missingColumns).toEqual([])
    expect(importRefusals(inspection)).toEqual([])
    expect(rows.length).toBe(312)
    expect(rows.length).toBeGreaterThan(300)
  })

  it('parses both markets without losing the country', () => {
    const au = rows.filter((row) => row.country === 'AU').length
    const vn = rows.filter((row) => row.country === 'VN').length
    expect(au).toBe(169)
    expect(vn).toBe(143)
    expect(au + vn).toBe(rows.length)
  })

  it('gives every parsed row a non-empty nameNormalized', () => {
    const blank = rows.filter((row) => row.nameNormalized.trim() === '')
    expect(blank.map((row) => row.name)).toEqual([])
    expect(rows).toHaveLength(312)
  })

  it('keeps Vietnamese diacritics in the display name and strips them for matching', () => {
    const vn = rows.find((row) => row.name.includes('Trần'))
    expect(vn).toBeDefined()
    expect(vn?.country).toBe('VN')
    expect(vn?.name).not.toBe(vn?.nameNormalized)
    expect(vn?.nameNormalized).not.toMatch(/[àáảãạăâđêôơư]/)
    expect(vn?.nameNormalized).toContain('tran')
  })

  it('plans an import that accounts for every row and reports repeat channels', () => {
    const plan = planImport(rows, [])
    expect(plan.counts.rowsIn).toBe(312)
    expect(plan.counts.rowsNew).toBe(310)
    expect(plan.counts.rowsDuplicate).toBe(2)
    expect(plan.counts.rowsNew + plan.counts.rowsDuplicate).toBe(plan.counts.rowsIn)

    // The 2 remaining duplicates are genuine non-profile placeholder cells
    // ("https://shopee.vn (via partner links)"): normalizeHandle reads them as
    // the same handle. Root urls no longer collapse onto "/" — they use their
    // bare hostname — so the 43 distinct businesses that were previously lost as
    // duplicates of each other are inserted instead.
    const droppedWithRootHandle = rows.filter(
      (row) => plan.duplicates.includes(row.name) && row.handleNormalized === '/',
    )
    expect(droppedWithRootHandle.length).toBe(0)
  })

  it('is idempotent when the same file is imported twice', () => {
    const first = planImport(rows, [])
    const existing = first.inserts.map(toExisting)
    const second = planImport(rows, existing)
    expect(second.counts.rowsNew).toBe(0)
    // The first pass reported 2 channels as duplicates inside the file, so a
    // second pass over all 312 rows sees every row as already known or already
    // repeated. Replaying exactly the 310 rows that were inserted is the clean
    // invariant: zero new, and duplicates equal to the first import's new count.
    expect(second.counts.rowsDuplicate).toBe(first.counts.rowsNew + first.counts.rowsDuplicate)
    expect(second.counts.rowsDuplicate).toBe(rows.length)

    const replay = planImport(first.inserts, existing)
    expect(replay.counts.rowsNew).toBe(0)
    expect(replay.counts.rowsDuplicate).toBe(first.counts.rowsNew)
  })

  it('keeps both tradie coaches as separate prospects and only raises a candidate', () => {
    const paul = rows.find((row) => row.name.startsWith('Tradie Coach'))
    const joel = rows.find((row) => row.name.startsWith('Tech and Tradie Coach'))
    expect(paul).toBeDefined()
    expect(joel).toBeDefined()
    if (!paul || !joel) return

    // Two real rows, both inserted. The shared "tradie coach" tokens make the
    // pair a merge candidate for a human to reject, never an automatic merge.
    const plan = planImport([paul, joel], [])
    expect(plan.inserts.map((row) => row.name)).toEqual([paul.name, joel.name])
    expect(plan.counts.rowsNew).toBe(2)
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]).toMatchObject({
      leftName: paul.name,
      rightName: joel.name,
      reason: 'substring',
    })
  })

  it('scores every parsed row without a null', () => {
    for (const row of rows) {
      const score = scoreProspect({
        audience: { count: row.audience.count, basis: row.audience.basis },
        offers: { priceVisible: row.price.minMinor !== null, sellsSomething: row.whatTheySell !== null },
        weaknessSignals: [],
        reachability: reachabilityFor(row.platform),
      })
      expect(Number.isFinite(score.total)).toBe(true)
      expect(score.total).toBeGreaterThanOrEqual(0)
      expect(score.total).toBeLessThanOrEqual(100)
      expect(['micro', 'small', 'mid', 'big']).toContain(score.band)
      expect(score.weightsVersion).toBe(WEIGHTS_VERSION)
    }
  })

  // The score script used to map facebook, tiktok, shopee and youtube to 'none',
  // which scores 0.1 instead of 0.8 on this weight.
  it('maps a tiktok channel to a DM and scores the DM weight', () => {
    expect(reachabilityFor('tiktok')).toBe('dm')
    expect(reachabilityFor('facebook')).toBe('dm')
    expect(reachabilityFor('shopee')).toBe('dm')
    expect(reachabilityFor('youtube')).toBe('form')
    expect(reachabilityFor('website')).toBe('form')
    expect(reachabilityFor('email')).toBe('email')
    expect(reachabilityFor('linkedin')).toBe('linkedin')
    expect(reachabilityFor(null)).toBe('none')

    const score = scoreProspect({
      audience: { count: 10000, basis: 'followers' },
      offers: { priceVisible: true, sellsSomething: true },
      weaknessSignals: [],
      reachability: reachabilityFor('tiktok'),
    })
    expect(score.reachability).toBe(0.8)
  })

  // VND has no minor unit, so the console must not divide by 100: a 2,900,000
  // VND course showed as "29000.00".
  it('formats VND with exponent 0 and always names the currency', () => {
    expect(formatMinor(2900000, 'VND')).toBe('2900000 VND')
    expect(formatMinor(290000, 'AUD')).toBe('2900.00 AUD')
    expect(formatMinor(null, 'VND')).toBeNull()
  })

  it('applies send caps to a real prospect during Vietnam business hours', () => {
    const prospect = rows.find((row) => row.country === 'VN')
    expect(prospect).toBeDefined()
    const prospectId = `prospect:${prospect?.handleNormalized ?? 'unknown'}`
    const base = {
      prospectId,
      channel: 'instagram' as const,
      kind: 'dm' as const,
      now: new Date('2026-10-30T03:00:00Z'),
      timeZone: 'Asia/Ho_Chi_Minh',
      consented: false,
    }

    expect(checkSendCaps({ ...base, ledger: [] })).toEqual({ allowed: true, reason: 'ok' })

    const recent: SendLedgerEntry = {
      prospectId,
      channel: 'instagram',
      kind: 'dm',
      sentAt: new Date('2026-10-28T03:00:00Z'),
    }
    expect(checkSendCaps({ ...base, ledger: [recent] })).toEqual({ allowed: false, reason: 'cooldown' })

    const fullDay: SendLedgerEntry[] = Array.from({ length: 20 }, (_, i) => ({
      prospectId: `other-${i}`,
      channel: 'instagram' as const,
      kind: 'dm' as const,
      sentAt: new Date('2026-10-30T02:00:00Z'),
    }))
    expect(checkSendCaps({ ...base, ledger: fullDay })).toEqual({ allowed: false, reason: 'daily_cap' })

    expect(
      checkSendCaps({ ...base, channel: 'email', kind: 'email', consented: false, ledger: [] }),
    ).toEqual({ allowed: false, reason: 'no_consent' })
  })

  it('checks a first-touch DM drafted from a real row', () => {
    const row = rows.find((candidate) => candidate.name === 'Learn Ecommerce (Paul Waddy)')
    expect(row).toBeDefined()
    if (!row) return

    const body = `Hi ${row.name}, I noticed your ${row.category ?? 'coaching'} page and had one question about how you take on new clients this quarter.`
    expect(checkDraft({ body, channel: 'dm', stage: 'first_touch', evidenceSnapshotId: 'snapshot-1' })).toEqual([])
    expect(
      checkDraft({
        body: `${body} ${row.profileUrl}`,
        channel: 'dm',
        stage: 'first_touch',
        evidenceSnapshotId: 'snapshot-1',
      }),
    ).toEqual(['link_in_first_touch'])
    expect(
      checkDraft({ body, channel: 'dm', stage: 'first_touch', evidenceSnapshotId: null }),
    ).toEqual(['no_cited_fact'])
  })
})

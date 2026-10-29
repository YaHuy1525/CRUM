import { describe, expect, it } from 'vitest'
import { checkDraft, pickLanguage } from '../../../src/prospects/draft-rules'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('checkDraft', () => {
  it('rejects a DM over ninety words', () => {
    const violations = checkDraft({ body: words(95), channel: 'dm', stage: 'first_touch', evidenceSnapshotId: 'abc' })
    expect(violations).toContain('too_long')
  })

  it('allows an email up to a hundred and twenty words', () => {
    expect(checkDraft({ body: words(118), channel: 'email', stage: 'first_touch', evidenceSnapshotId: 'abc' })).toEqual([])
  })

  it('requires a cited fact', () => {
    expect(checkDraft({ body: 'hello there', channel: 'dm', stage: 'first_touch', evidenceSnapshotId: null })).toContain('no_cited_fact')
  })

  it('bans links in a first touch DM but allows them later', () => {
    const body = 'I watched your reel about pricing https://example.com'
    expect(checkDraft({ body, channel: 'dm', stage: 'first_touch', evidenceSnapshotId: 'abc' })).toContain('link_in_first_touch')
    expect(checkDraft({ body, channel: 'dm', stage: 'followup_1', evidenceSnapshotId: 'abc' })).not.toContain('link_in_first_touch')
  })

  it('flags an empty body', () => {
    expect(checkDraft({ body: '   ', channel: 'dm', stage: 'first_touch', evidenceSnapshotId: 'abc' })).toContain('empty')
  })
})

describe('pickLanguage', () => {
  it('returns Vietnamese for Vietnam', () => {
    expect(pickLanguage('VN', 'khoá học makeup cá nhân')).toBe('vi')
  })

  it('returns English for Australia', () => {
    expect(pickLanguage('AU', 'online fitness coaching')).toBe('en')
  })

  it('returns Vietnamese when the sample is mostly Vietnamese despite an AU country', () => {
    expect(pickLanguage('AU', 'khoá học trang điểm và chăm sóc da')).toBe('vi')
  })
})

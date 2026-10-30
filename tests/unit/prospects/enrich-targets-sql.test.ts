import { describe, expect, it } from 'vitest'
import { ENRICH_TARGETS_SQL } from '../../../scripts/prospects-enrich'

/**
 * These tests pin the shape of the shipped query, not Postgres behaviour: the
 * unit suite has no database. What can be proven here is that only website
 * channels are selected (a social profile cannot be read without
 * authentication), that the freshness gate counts only enrichment snapshots,
 * and that the removed unusable marker does not creep back in.
 */
function notExistsBlock(sql: string): string {
  const marker = 'NOT EXISTS ('
  const start = sql.indexOf(marker)
  if (start === -1) throw new Error('ENRICH_TARGETS_SQL has no NOT EXISTS guard')

  let depth = 0
  for (let i = start + marker.length - 1; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1
    else if (sql[i] === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(start + marker.length, i)
    }
  }
  throw new Error('unbalanced parentheses in ENRICH_TARGETS_SQL')
}

describe('ENRICH_TARGETS_SQL', () => {
  it('joins only website channels', () => {
    expect(ENRICH_TARGETS_SQL).toMatch(
      /JOIN prospect_channels c ON c\.prospect_id = p\.id\s+AND c\.platform = 'website'/,
    )
  })

  it('never mentions a social or marketplace platform', () => {
    for (const platform of ['instagram', 'linkedin', 'facebook', 'tiktok', 'shopee', 'youtube']) {
      expect(ENRICH_TARGETS_SQL.toLowerCase()).not.toContain(platform)
    }
  })

  it('keeps one target per prospect', () => {
    expect(ENRICH_TARGETS_SQL).toMatch(/SELECT DISTINCT ON \(p\.id\)/)
    expect(ENRICH_TARGETS_SQL).toMatch(/ORDER BY p\.id,/)
  })

  it('only counts enrichment snapshots towards freshness', () => {
    expect(notExistsBlock(ENRICH_TARGETS_SQL)).toMatch(
      /s\.extractor_version\s+LIKE\s+'enrich-%'/,
    )
  })

  it('does not count the import baseline as fresh', () => {
    const block = notExistsBlock(ENRICH_TARGETS_SQL)
    expect(block).not.toContain('import-v1')
    // Nothing may widen the freshness gate with an OR: only 'enrich-%' rows
    // count, so a prospect whose only snapshot came from the import stays
    // eligible.
    expect(block).not.toMatch(/\bOR\b/)
  })

  it('keeps the extractor guard and the age check in the same snapshot subquery', () => {
    const block = notExistsBlock(ENRICH_TARGETS_SQL)
    expect(block).toMatch(/FROM prospect_snapshots s/)
    expect(block).toMatch(/s\.fetched_at > now\(\) - \(\$2 \|\| ' days'\)::interval/)
  })

  it('does not treat every snapshot as fresh: the guard is a conjunct of the age check', () => {
    const block = notExistsBlock(ENRICH_TARGETS_SQL)
    // A recent fetched_at alone must not satisfy the subquery, so the extractor
    // filter has to be ANDed in and not sit in a comment or an OR branch
    // alongside the age check.
    expect(block).toMatch(/AND\s+s\.extractor_version\s+LIKE\s+'enrich-%'/)
    expect(ENRICH_TARGETS_SQL.match(/NOT EXISTS/g)).toHaveLength(1)
  })

  it('does not carry the removed unusable marker', () => {
    expect(ENRICH_TARGETS_SQL).not.toContain('enrich-unusable')
  })
})

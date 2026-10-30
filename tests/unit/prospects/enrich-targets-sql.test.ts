import { describe, expect, it } from 'vitest'
import { ENRICH_TARGETS_SQL } from '../../../scripts/prospects-enrich'

/**
 * These tests pin the shape of the shipped query, not Postgres behaviour: the
 * unit suite has no database. What can be proven here is that the freshness
 * gate carries the extractor_version guard, which is the part that was missing
 * when the CLI selected zero targets against a real tenant, and that an
 * unusable attempt counts as an attempt so a hopeless URL is not refetched on
 * every run.
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
  it('only counts enrichment snapshots towards freshness', () => {
    expect(notExistsBlock(ENRICH_TARGETS_SQL)).toMatch(
      /s\.extractor_version\s+LIKE\s+'enrich-%'/,
    )
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
    expect(block).toMatch(/AND\s+\(s\.extractor_version\s+LIKE\s+'enrich-%'/)
    expect(ENRICH_TARGETS_SQL.match(/NOT EXISTS/g)).toHaveLength(1)
  })

  it('counts an enrich-unusable attempt as fresh so a login wall is not retried', () => {
    const block = notExistsBlock(ENRICH_TARGETS_SQL)
    expect(block).toMatch(/s\.extractor_version\s+LIKE\s+'enrich-%'/)
    expect(block).toMatch(/s\.extractor_version\s*=\s*'enrich-unusable'/)
    // The marker is only useful if it sits in the same subquery as the age
    // check: that is what makes a recent unusable attempt exclude the prospect
    // from the next run for the whole stale window.
    expect(block).toMatch(/s\.fetched_at > now\(\) - \(\$2 \|\| ' days'\)::interval/)
  })
})

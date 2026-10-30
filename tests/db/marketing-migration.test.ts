import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 0018 is the next free prefix: 0017_crum_prospect_merge.sql was the last file,
 * scripts/db-migrate.ts keys crum_schema_migrations on the 4-digit prefix alone,
 * and tests/integration/migrations.test.ts rejects a duplicate version.
 */
const sql = readFileSync('migrations/0018_crum_marketing.sql', 'utf8')

function tableBlock(name: string): string {
  const header = `CREATE TABLE IF NOT EXISTS ${name} (`
  const start = sql.indexOf(header)
  expect(start, `${name} is not created`).toBeGreaterThan(-1)
  const end = sql.indexOf('\n);', start)
  expect(end, `${name} is not terminated`).toBeGreaterThan(start)
  return sql.slice(start, end)
}

const TABLES = ['marketing_bundles', 'marketing_artifacts', 'marketing_actions']

describe('0018 marketing migration', () => {
  it('creates all three marketing tables', () => {
    for (const table of TABLES) expect(tableBlock(table).length).toBeGreaterThan(0)
  })

  it('scopes every marketing table on a non-nullable tenant', () => {
    for (const table of TABLES) {
      expect(tableBlock(table), table).toMatch(/tenant_id\s+uuid\s+NOT NULL/)
    }
  })

  it('cascades children with their bundle so no orphan survives a deleted draft', () => {
    for (const table of ['marketing_artifacts', 'marketing_actions']) {
      expect(tableBlock(table), table).toMatch(
        /bundle_id\s+uuid\s+NOT NULL REFERENCES marketing_bundles\(id\) ON DELETE CASCADE/,
      )
    }
  })

  it('pins the bundle objective and status enums the design names', () => {
    const body = tableBlock('marketing_bundles')
    expect(body).toContain("CHECK (objective IN ('outreach_support','inbound_leads','proof_asset'))")
    expect(body).toContain(
      "CHECK (status IN ('draft','staged','approved','publishing','live','failed','archived'))",
    )
  })

  it('names exactly the six producing roles', () => {
    const body = tableBlock('marketing_artifacts')
    for (const role of [
      'offer-strategist',
      'marketer-copywriter',
      'creative-designer',
      'media-buyer',
      'funnel-builder',
      'campaign-analyst',
    ]) {
      expect(body, role).toContain(`'${role}'`)
    }
  })

  it('makes an image carry bytes and every other kind carry text', () => {
    // Content shape is enforced in the schema, not only in the tool, so a row
    // written by a future migration or a manual psql cannot be unrenderable.
    // Whitespace-tolerant on purpose: the SQL wraps this constraint across lines
    // to match the repo's formatting, and `toContain` cannot see past a newline.
    // Assert the shape, never the layout.
    expect(tableBlock('marketing_artifacts')).toMatch(
      /CHECK \(\(kind = 'image' AND document_id IS NOT NULL\)\s+OR \(kind <> 'image' AND text_content IS NOT NULL\)\)/,
    )
  })

  it('keeps the attempt ceiling in the schema', () => {
    expect(tableBlock('marketing_actions')).toContain('attempts >= 0 AND attempts <= 3')
  })

  it('touches updated_at when a bundle moves through its states', () => {
    // 0002 establishes crum_touch_updated_at() for every table that carries
    // updated_at, and 0016 exists only because prospects shipped with the column
    // and without the trigger. A bundle is UPDATEd on every status change, so the
    // same trap is live here unless something asserts the trigger.
    expect(sql).toMatch(
      /CREATE TRIGGER trg_marketing_bundles_touch\s+BEFORE UPDATE ON marketing_bundles\s+FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at\(\);/,
    )
  })

  it('indexes only the queued rows the drain query reads', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS marketing_actions_queued_idx\s+ON marketing_actions \(created_at\) WHERE status = 'queued';/,
    )
  })

  /**
   * Same all-or-nothing assertion style as tests/db/prospects-migration.test.ts:36-53:
   * a literal silently dropped from the ADD would not be caught by looking only
   * for the two new ones.
   */
  it('extends the pending_writes object type check to all fourteen types', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS pending_writes_object_type_check')
    const [, addClause = ''] = sql.split('ADD CONSTRAINT pending_writes_object_type_check')
    const end = addClause.indexOf(');')
    expect(end, 'the ADD CONSTRAINT statement is not terminated').toBeGreaterThan(-1)

    const literals = [...addClause.slice(0, end + 2).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    const expected = [
      'customer', 'contact', 'followup', 'task', 'schedule', 'knowledge_document', 'email',
      'prospect', 'prospect_channel', 'outreach_draft', 'outreach_send', 'prospect_merge',
      'marketing_bundle', 'marketing_stage',
    ]
    expect(literals.slice().sort()).toEqual(expected.slice().sort())
  })
})

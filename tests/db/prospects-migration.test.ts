// tests/db/prospects-migration.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The plan named this file 0013, but 0013_crum_sponsorship.sql and
// 0014_crum_billing.sql landed first. scripts/db-migrate.ts keys
// crum_schema_migrations on the 4-digit prefix alone, and
// tests/scripts/migrations.test.ts rejects a duplicate version, so the prospect
// migration takes the next free number.
const sql = readFileSync('migrations/0015_crum_prospects.sql', 'utf8')

describe('0015 prospect migration', () => {
  it('creates every prospect table', () => {
    for (const table of [
      'prospects', 'prospect_channels', 'prospect_snapshots', 'prospect_scores',
      'outreach_drafts', 'outreach_threads', 'outreach_replies',
      'prospect_consents', 'prospect_import_batches', 'prospect_merge_candidates',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  /**
   * The migration DROPs the old check before ADDing the new one, so a literal
   * that was silently dropped from the ADD would not fail a test that only
   * looks for the four new types. Assert the ADD statement's full literal list,
   * as a set: all eleven types, no more, no fewer.
   */
  it('extends the pending_writes object type check to all eleven types', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS pending_writes_object_type_check')

    const [, addClause = ''] = sql.split('ADD CONSTRAINT pending_writes_object_type_check')
    const end = addClause.indexOf(');')
    expect(end, 'the ADD CONSTRAINT statement is not terminated').toBeGreaterThan(-1)

    const literals = [
      ...addClause.slice(0, end + 2).matchAll(/'([a-z_]+)'/g),
    ].map((match) => match[1])
    const expected = [
      // the seven that existed before this migration
      'customer', 'contact', 'followup', 'task', 'schedule', 'knowledge_document', 'email',
      // the four the prospect lane adds
      'prospect', 'prospect_channel', 'outreach_draft', 'outreach_send',
    ]
    expect([...literals].sort()).toEqual([...expected].sort())
  })

  it('scopes every prospect table on tenant_id', () => {
    for (const table of ['prospects', 'prospect_channels', 'outreach_drafts']) {
      const body = sql.split(`CREATE TABLE IF NOT EXISTS ${table}`)[1] ?? ''
      expect(body.slice(0, 600)).toContain('tenant_id')
    }
  })

  it('makes channel handles unique per tenant and platform', () => {
    expect(sql).toContain('prospect_channels_tenant_platform_handle_key')
  })

  // The import batch row is this slice's audit record, so it must say who ran
  // the import even though a signed receipt is deferred to a later slice.
  it('records who ran the import on the batch audit row', () => {
    const body = sql.split('CREATE TABLE IF NOT EXISTS prospect_import_batches')[1] ?? ''
    expect(body.slice(0, 600)).toContain('requested_by')
  })

  // Every other table with updated_at in this repo carries the shared touch
  // trigger; without it prospects.updated_at would stay at its insert value.
  it('touches prospects.updated_at on update', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_prospects_touch ON prospects;')
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'CREATE TRIGGER trg_prospects_touch BEFORE UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();',
    )
  })

  // A cascading delete walks each referencing column; without an index on it
  // PostgreSQL seq-scans the child table for every parent row deleted.
  it('indexes every cascade path so deletes do not seq-scan', () => {
    const compact = sql.replace(/\s+/g, ' ')
    for (const definition of [
      'CREATE INDEX IF NOT EXISTS outreach_drafts_channel_idx ON outreach_drafts (channel_id);',
      'CREATE INDEX IF NOT EXISTS outreach_threads_prospect_idx ON outreach_threads (prospect_id);',
      'CREATE INDEX IF NOT EXISTS outreach_threads_channel_idx ON outreach_threads (channel_id);',
      'CREATE INDEX IF NOT EXISTS outreach_replies_thread_idx ON outreach_replies (thread_id);',
      'CREATE INDEX IF NOT EXISTS prospect_merge_candidates_right_prospect_idx ON prospect_merge_candidates (right_prospect_id);',
    ]) {
      expect(compact).toContain(definition)
    }
  })
})

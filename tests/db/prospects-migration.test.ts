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

  it('extends the pending_writes object type check', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS pending_writes_object_type_check')
    for (const type of ['prospect', 'prospect_channel', 'outreach_draft', 'outreach_send']) {
      expect(sql).toContain(`'${type}'`)
    }
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
})

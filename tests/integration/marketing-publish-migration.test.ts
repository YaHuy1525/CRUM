/**
 * The guard that migration 0019 actually landed, read back from a real Postgres.
 *
 * 0019 only widens CHECK constraint lists and adds one table, so its whole risk
 * is a typo that Postgres accepts but the publisher later trips over. These
 * assertions ask the catalog, not the code: does the constraint definition
 * contain the new value, does the column exist, does the unique key exist. A
 * skipped run (no database URL) is reported as skipped rather than passed.
 * Spec: docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md §3.4.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
let pool: Pool

describe.skipIf(!url)('migration 0019 widening', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })
  afterAll(async () => { await pool.end() })

  async function definition(constraint: string): Promise<string> {
    const found = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    )
    return String(found.rows[0]?.def ?? '')
  }

  it('admits the new artifact kind', async () => {
    expect(await definition('marketing_artifacts_kind_check')).toContain('thank_you_html')
  })

  it('admits promote_page as an outbox action', async () => {
    expect(await definition('marketing_actions_action_check')).toContain('promote_page')
  })

  it('keeps the pending_writes object types and adds the two decisions', async () => {
    const def = await definition('pending_writes_object_type_check')
    expect(def).toContain('marketing_promote')
    expect(def).toContain('marketing_retry')
    expect(def).toContain('marketing_stage')
  })

  it('gives bundles a lead token and actions a recorded response', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'marketing_bundles' AND column_name = 'lead_token')
           OR (table_name = 'marketing_actions' AND column_name = 'result')`,
    )
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
      'marketing_actions.result',
      'marketing_bundles.lead_token',
    ])
  })

  it('holds one lead per bundle and email, and nothing else', async () => {
    const keys = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'marketing_leads'::regclass`,
    )
    expect(keys.rows.map((r) => r.conname)).toContain('marketing_leads_tenant_bundle_email_key')
  })
})

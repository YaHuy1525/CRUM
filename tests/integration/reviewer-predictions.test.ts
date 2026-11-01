// tests/integration/reviewer-predictions.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

let pool: Pool

describe.skipIf(!url)('reviewer_predictions on Postgres', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
    await pool.query('BEGIN')
  })

  afterAll(async () => {
    await pool.query('ROLLBACK')
    await pool.end()
  })

  async function openDraft(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO pending_writes
         (tenant_id, run_id, object_type, operation, target_id, payload,
          risk_score, gate, draft_hash, requested_by, expires_at)
       VALUES ($1, 'pending', 'marketing_stage', 'update', $2, '{}'::jsonb,
               10, 'approval', $3, $1, now() + interval '1 hour')
       RETURNING id`,
      [TENANT, BUNDLE, `pred-itest:${BUNDLE}:${Date.now()}`],
    )
    return rows[0]!.id
  }

  it('refuses a second prediction for the same draft', async () => {
    const draftId = await openDraft()
    await pool.query(
      `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, 'six booked calls a week')`,
      [TENANT, draftId],
    )
    await expect(
      pool.query(
        `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, 'actually forty')`,
        [TENANT, draftId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('lets two drafts of two bundles each hold one prediction', async () => {
    const first = await openDraft()
    const second = await openDraft()
    for (const draftId of [first, second]) {
      await pool.query(
        `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, 'ten replies')`,
        [TENANT, draftId],
      )
    }
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reviewer_predictions WHERE tenant_id = $1`,
      [TENANT],
    )
    // Two rows, because the constraint is per draft and not per bundle. A
    // re-staged bundle has to be predictable again, which is why the column
    // points at pending_writes at all.
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2)
  })

  it('drops the prediction when the draft goes', async () => {
    const draftId = await openDraft()
    await pool.query(
      `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, 'eleven calls')`,
      [TENANT, draftId],
    )
    await pool.query(`DELETE FROM pending_writes WHERE id = $1`, [draftId])
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM reviewer_predictions WHERE pending_write_id = $1`,
      [draftId],
    )
    expect(rows).toHaveLength(0)
  })

  it('finds the open stage draft and ignores an expired one', async () => {
    const { getOpenStageDraft } = await import('../../src/db/pending-writes')
    const live = await openDraft()
    const found = await getOpenStageDraft(TENANT, BUNDLE)
    expect(found?.id).toBe(live)
    await pool.query(`UPDATE pending_writes SET expires_at = now() - interval '1 minute'`)
    expect(await getOpenStageDraft(TENANT, BUNDLE)).toBeNull()
  })
})

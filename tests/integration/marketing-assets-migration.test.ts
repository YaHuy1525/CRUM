// tests/integration/marketing-assets-migration.test.ts
// Proves migration 0021 widens the document lane for generated assets, gives the
// daily spend ceiling a ledger to read, and makes one written prediction a fact
// the database enforces per staged draft.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
// pending_writes_update_needs_target (0002) requires a target_id whenever the
// operation is 'update', and target_id carries no foreign key, so the staged
// drafts below point at this placeholder bundle rather than a real one.
const TARGET = '22222222-2222-4222-8222-222222222222'

let pool: Pool

// This file shares a database with every other migration test and documents.id
// is a uuid primary key, so each insert needs a fresh uuid.
async function unique(): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(`SELECT gen_random_uuid() AS n`)
  return rows[0]!.n
}

describe.skipIf(!url)('migration 0021: marketing assets, spend and predictions', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('admits a marketing_asset document from a generated source', async () => {
    const id = await unique()
    await pool.query(
      `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                              content_text, mime, status, raw_extract)
       VALUES ($1, $2, $3, 'marketing_asset', 'hero-image', 'generated', $4,
               'a prompt', 'image/png', 'needs_review', '{}'::jsonb)`,
      [id, TENANT, OTHER, `hash-${id}`],
    )
    const { rows } = await pool.query<{ kind: string; source: string }>(
      `SELECT kind, source FROM documents WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ kind: 'marketing_asset', source: 'generated' })
    await pool.query(`DELETE FROM documents WHERE id = $1`, [id])
  })

  it('still rejects a kind nobody asked for', async () => {
    const id = await unique()
    await expect(
      pool.query(
        `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                                content_text, mime, status, raw_extract)
         VALUES ($1, $2, $3, 'quote', 'x', 'upload', $4, 'y', 'text/plain', 'ready', '{}'::jsonb)`,
        [id, TENANT, OTHER, `hash-${id}`],
      ),
    ).rejects.toThrow(/documents_kind_check/)
  })

  it('leaves an existing invoice row valid under the re-added constraint', async () => {
    const id = await unique()
    await pool.query(
      `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                              content_text, mime, status, raw_extract)
       VALUES ($1, $2, $3, 'invoice', 'bill', 'upload', $4, 'text', 'application/pdf', 'ready', '{}'::jsonb)`,
      [id, TENANT, OTHER, `hash-${id}`],
    )
    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM documents WHERE id = $1 AND kind = 'invoice'`,
      [id],
    )
    expect(rows).toHaveLength(1)
    await pool.query(`DELETE FROM documents WHERE id = $1`, [id])
  })

  it('creates the partial index over the asset kind only', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'documents' AND indexname = 'idx_documents_assets'`,
    )
    expect(rows).toHaveLength(1)
    // The backticks are load-bearing: the assertion text carries single quotes.
    expect(rows[0]!.indexdef).toContain(`WHERE (kind = 'marketing_asset'::text)`)
  })

  it('records a spend with no document, because a failed prediction still cost money', async () => {
    const id = await unique()
    await pool.query(
      `INSERT INTO marketing_image_spend (id, tenant_id, document_id, provider, cost_minor, raw_extract)
       VALUES ($1, $2, NULL, 'replicate', 4, $3::jsonb)`,
      [id, TENANT, JSON.stringify({ predictionId: 'p1', model: 'flux', costUsd: '0.04' })],
    )
    const { rows } = await pool.query<{
      document_id: string | null
      spent_on: string
      raw_extract: { predictionId: string } | null
    }>(`SELECT document_id, spent_on::text AS spent_on, raw_extract FROM marketing_image_spend WHERE id = $1`, [id])
    expect(rows[0]!.document_id).toBeNull()
    // The plan's draft compared spent_on to the UTC ISO date; twice wrong on a
    // machine east of UTC: node-pg hands a date column back as a Date object, and
    // CURRENT_DATE is the database's local day. Read the column as text (the
    // house pattern for non-string columns) and compare it to the server's own
    // today — which is exactly what the DEFAULT CURRENT_DATE must equal.
    const { rows: todayRows } = await pool.query<{ d: string }>(`SELECT current_date::text AS d`)
    expect(rows[0]!.spent_on).toBe(todayRows[0]!.d)
    // Spec section 9's re-fetch handle: the row that points at no document still
    // names the prediction that cost the money.
    expect(rows[0]!.raw_extract?.predictionId).toBe('p1')
    await pool.query(`DELETE FROM marketing_image_spend WHERE id = $1`, [id])
  })

  it('has no updated_at on the spend ledger: a spend that happened is never edited', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'marketing_image_spend'`,
    )
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'bundle_id',
      'cost_minor',
      'created_at',
      'document_id',
      'id',
      'provider',
      'raw_extract',
      'spent_on',
      'tenant_id',
    ])
  })

  it('rejects a second prediction for one draft, which is the whole device', async () => {
    const draftA = await unique()
    const draftB = await unique()
    const runId = `pred-test-${Date.now()}`
    for (const id of [draftA, draftB]) {
      await pool.query(
        `INSERT INTO pending_writes (id, tenant_id, run_id, object_type, operation, target_id, payload,
                                     risk_score, gate, draft_hash, requested_by, expires_at)
         VALUES ($1, $2, $3, 'marketing_stage', 'update', $6, '{}'::jsonb, 10, 'approval', $4,
                 $5, now() + interval '1 hour')`,
        [id, TENANT, runId, `pred-hash-${id}`, OTHER, TARGET],
      )
    }
    const prediction = await unique()
    await pool.query(
      `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, $3, 'about 6 booked calls a week')`,
      [prediction, TENANT, draftA],
    )
    await expect(
      pool.query(
        `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, $3, 'no idea')`,
        [await unique(), TENANT, draftA],
      ),
    ).rejects.toThrow(/uq_prediction_draft/)

    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM reviewer_predictions WHERE pending_write_id = $1`,
      [draftA],
    )
    expect(rows).toHaveLength(1)
    await pool.query(`DELETE FROM pending_writes WHERE id = ANY($1::uuid[])`, [[draftA, draftB]])
  })

  it('drops a prediction when its draft goes, so a re-staged bundle starts clean', async () => {
    const draft = await unique()
    const prediction = await unique()
    await pool.query(
      `INSERT INTO pending_writes (id, tenant_id, run_id, object_type, operation, target_id, payload,
                                   risk_score, gate, draft_hash, requested_by, expires_at)
       VALUES ($1, $2, 'cascade-test', 'marketing_stage', 'update', $5, '{}'::jsonb, 10, 'approval', $3,
               $4, now() + interval '1 hour')`,
      [draft, TENANT, `cascade-hash-${draft}`, OTHER, TARGET],
    )
    await pool.query(
      `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, $3, 'eleven calls')`,
      [prediction, TENANT, draft],
    )
    await pool.query(`DELETE FROM pending_writes WHERE id = $1`, [draft])
    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM reviewer_predictions WHERE id = $1`,
      [prediction],
    )
    expect(rows).toHaveLength(0)
  })
})

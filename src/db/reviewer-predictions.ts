// src/db/reviewer-predictions.ts
/**
 * The record behind the cognitive forcing gate.
 *
 * A reviewer who reads the copy first cannot predict honestly afterwards, so
 * slice 4 asks for the prediction before it shows anything, and this table is
 * what makes that more than a screen trick. The `uq_prediction_draft` unique
 * constraint from migration 0021 is the device: one row per draft, so a
 * prediction cannot be revised once the reviewer has seen the bundle, and the
 * row points at the `pending_writes` draft rather than the bundle so a
 * re-staged bundle starts clean.
 *
 * No prose rule applies here. The standing rule that approval payloads carry
 * identifiers and numbers only is about what `pending_writes.payload` holds; a
 * prediction is reviewer prose stored in its own table, and `predicted_outcome`
 * is free text by design (spec section 8.4: the gate is not a validator).
 */
import { getDbClient } from './client'
import { getOpenStageDraft } from './pending-writes'
import { toIsoString } from './timestamps'

export interface ReviewerPrediction {
  id: string
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
  createdAt: string
}

interface PredictionSqlRow {
  id: string
  tenant_id: string
  pending_write_id: string
  predicted_outcome: string
  // `unknown`, not `string`, because the driver answers a `timestamptz` with a
  // `Date`. An annotation saying `string` here is the fiction `rowToPrediction`
  // used to complete with a cast, and it is also why the `RETURNING` list and
  // this shape have to be read together: `insertPrediction` maps the same column
  // through the same normaliser.
  created_at: unknown
}

function rowToPrediction(row: PredictionSqlRow): ReviewerPrediction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    pendingWriteId: row.pending_write_id,
    predictedOutcome: row.predicted_outcome,
    createdAt: toIsoString(row.created_at, 'reviewer_predictions.created_at'),
  }
}

export type PredictionGate =
  | { required: true; pendingWriteId: string; prediction: ReviewerPrediction | null }
  | { required: false; pendingWriteId: null; prediction: null }

export async function getPredictionForDraft(
  tenantId: string,
  pendingWriteId: string,
): Promise<ReviewerPrediction | null> {
  const db = getDbClient()
  const result = await db.query<PredictionSqlRow>(
    `SELECT id, tenant_id, pending_write_id, predicted_outcome, created_at
       FROM reviewer_predictions
      WHERE tenant_id = $1 AND pending_write_id = $2`,
    [tenantId, pendingWriteId],
  )
  const row = result.rows[0]
  return row ? rowToPrediction(row) : null
}

/**
 * Write the prediction, or read the one that beat this call to it.
 *
 * The return is `{ created, prediction }` rather than the id because the route
 * has to tell a second reviewer what is already there, and the only way to know
 * that without a second round trip is to ask the insert. `RETURNING` on `ON
 * CONFLICT DO NOTHING` answers with nothing when the row existed, which is the
 * signal; the re-read then answers *whose* prediction it was. A reviewer should
 * never be told "your prediction was not saved" without also being shown the one
 * that was.
 */
export async function insertPrediction(params: {
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
}): Promise<{ created: boolean; prediction: ReviewerPrediction }> {
  const outcome = params.predictedOutcome.trim()
  if (outcome === '') {
    throw new Error('predicted_outcome: a blank prediction predicts nothing and is not stored')
  }
  const db = getDbClient()
  const inserted = await db.query<PredictionSqlRow>(
    `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
     VALUES ($1, $2, $3)
     ON CONFLICT (pending_write_id) DO NOTHING
     RETURNING id, tenant_id, pending_write_id, predicted_outcome, created_at`,
    [params.tenantId, params.pendingWriteId, outcome],
  )
  const row = inserted.rows[0]
  if (row) return { created: true, prediction: rowToPrediction(row) }

  const existing = await getPredictionForDraft(params.tenantId, params.pendingWriteId)
  if (existing === null) {
    throw new Error(
      `predicted_outcome: draft ${params.pendingWriteId} refused the insert and has no row to read back`,
    )
  }
  return { created: false, prediction: existing }
}

/**
 * Is this bundle gated, and has anyone committed to a number on it yet?
 *
 * Two reads, and the second only when the first says there is a decision
 * waiting: a `draft` bundle with no open stage draft is not gated at all, which
 * is what keeps the screen readable by the person who has to stage it (spec
 * section 4.3). Returning one answer rather than two route-side calls is the
 * point: the withhold decision, the write target and the render decision must
 * read the same row or they will disagree. `pendingWriteId` is in the answer
 * because Task 11's POST needs it and must not go looking for it a second time.
 */
export async function bundlePredictionGate(
  tenantId: string,
  bundleId: string,
): Promise<PredictionGate> {
  const draft = await getOpenStageDraft(tenantId, bundleId)
  if (draft === null) return { required: false, pendingWriteId: null, prediction: null }
  const prediction = await getPredictionForDraft(tenantId, draft.id)
  return { required: true, pendingWriteId: draft.id, prediction }
}

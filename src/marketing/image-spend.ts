// src/marketing/image-spend.ts
// CRUM_IMAGE_SPEND_CEILING_MINOR is only real if there is a number to compare
// against, so this module owns both halves: the arithmetic, kept pure so the
// boundary is testable without a database, and the append-only ledger behind it
// (spec section 4.2).

import { getDbClient } from '../db/client'

export const REPLICATE_PROVIDER = 'replicate'

export function headroomMinor(params: { ceilingMinor: number; committedMinor: number }): number {
  return Math.max(0, params.ceilingMinor - params.committedMinor)
}

/**
 * One predicate, used twice: before the run with the whole asset count, and
 * before every asset with a count of one. The second use is what makes a run
 * that would cross the ceiling stop at the boundary instead of finishing and
 * overrunning it.
 *
 * `<=`, not `<`: spending exactly to the ceiling is spending to the ceiling, and
 * an owner who writes 2000 means $20.00 rather than $19.96.
 */
export function admitsRun(params: {
  ceilingMinor: number
  committedMinor: number
  costMinorPerImage: number
  assetCount: number
}): boolean {
  if (params.assetCount <= 0) return false
  if (params.costMinorPerImage < 0 || params.committedMinor < 0) return false
  return params.committedMinor + params.costMinorPerImage * params.assetCount <= params.ceilingMinor
}

/**
 * The one place that decides what a readable ledger total is. Both ceiling reads
 * answer `SUM(cost_minor)`, which node-pg hands back as a string because Postgres
 * widens an integer sum to bigint, and 0 is the answer that admits unlimited
 * spend. So an unreadable total throws rather than defaulting, and there is exactly
 * one function that knows this rule.
 */
function totalMinorOrThrow(rows: { total: string | null }[], label: string): number {
  const total = rows[0]?.total ?? null
  if (total === null || !/^\d+$/.test(String(total))) {
    throw new Error(
      `marketing_image_spend: the ${label} read answered ${JSON.stringify(rows)} instead of one non-negative integer total`,
    )
  }
  return Number(total)
}

export async function committedSpendMinor(tenantId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND spent_on = CURRENT_DATE`,
    [tenantId],
  )
  return totalMinorOrThrow(result.rows, 'daily spend')
}

/**
 * What one bundle has cost, over every day it has ever run. Spec section 7.1: the
 * window is lifetime on purpose, because the job of this number is to stop one
 * runaway loop on one bundle, and a bundle that already had forty images paid for
 * does not deserve forty more tomorrow.
 */
export async function committedBundleSpendMinor(tenantId: string, bundleId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND bundle_id = $2`,
    [tenantId, bundleId],
  )
  return totalMinorOrThrow(result.rows, 'bundle spend')
}

export interface SpendRawExtract {
  predictionId: string
  model: string
  costUsd: string
}

/**
 * Append-only, and deliberately not in one transaction with the document insert
 * beside it: an invoice for an image we failed to save is a real cost and must
 * show up (spec section 9).
 */
export async function recordImageSpend(params: {
  tenantId: string
  bundleId: string | null
  documentId: string | null
  costMinor: number
  provider?: string
  rawExtract?: SpendRawExtract | null
}): Promise<string> {
  if (!Number.isInteger(params.costMinor) || params.costMinor < 0) {
    throw new Error(`cost_minor: ${params.costMinor} is not a non-negative integer of cents`)
  }
  const result = await getDbClient().query<{ id: string }>(
    // $6::jsonb, not a bare $6: every other jsonb write in src/ names the type
    // (src/db/pending-writes.ts:626, src/db/documents.ts:299, src/db/alerts.ts:113).
    // Postgres infers it correctly at a VALUES position today, and an explicit
    // cast is what keeps it correct the day this INSERT grows a SELECT.
    `INSERT INTO marketing_image_spend (tenant_id, bundle_id, document_id, provider, cost_minor, raw_extract)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      params.tenantId,
      // Required rather than optional, on the same principle as the document id
      // below it: a caller that has not answered "which bundle" is a caller that
      // should have to write null and mean it. A NULL row still counts toward the
      // tenant's day and toward no bundle's lifetime.
      params.bundleId,
      params.documentId,
      params.provider ?? REPLICATE_PROVIDER,
      params.costMinor,
      // Stringified rather than handed over as an object: `pg` serialises a plain
      // object to a JSON string anyway, and doing it here means the unit test
      // above can assert the exact text that reaches the column.
      params.rawExtract ? JSON.stringify(params.rawExtract) : null,
    ],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('image_spend: the ledger insert returned no row')
  return id
}

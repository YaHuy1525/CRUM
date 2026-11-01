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
 * `SUM(integer)` comes back from node-pg as a string, because Postgres widens an
 * integer sum to bigint, so Number() is the whole conversion. The COALESCE in the
 * query means an empty ledger answers '0' rather than null.
 *
 * Anything else the database could answer throws. This number is the only thing
 * standing between an agent loop and a real bill, and 0 is the answer that
 * admits unlimited spend, so an unreadable ledger must fail closed and let the
 * caller refuse rather than spend.
 */
export async function committedSpendMinor(tenantId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND spent_on = CURRENT_DATE`,
    [tenantId],
  )
  const total = result.rows[0]?.total ?? null
  if (total === null || !/^\d+$/.test(String(total))) {
    throw new Error(
      `marketing_image_spend: the ceiling read answered ${JSON.stringify(result.rows)} instead of one non-negative integer total`,
    )
  }
  return Number(total)
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
  documentId: string | null
  costMinor: number
  provider?: string
  rawExtract?: SpendRawExtract | null
}): Promise<string> {
  if (!Number.isInteger(params.costMinor) || params.costMinor < 0) {
    throw new Error(`cost_minor: ${params.costMinor} is not a non-negative integer of cents`)
  }
  const result = await getDbClient().query<{ id: string }>(
    // $5::jsonb, not a bare $5: every other jsonb write in src/ names the type
    // (src/db/pending-writes.ts:626, src/db/documents.ts:299, src/db/alerts.ts:113).
    // Postgres infers it correctly at a VALUES position today, and an explicit
    // cast is what keeps it correct the day this INSERT grows a SELECT.
    `INSERT INTO marketing_image_spend (tenant_id, document_id, provider, cost_minor, raw_extract)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      params.tenantId,
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

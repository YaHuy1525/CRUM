import { getDbClient } from './client'

// ── Prospect merge resolution ────────────────────────────────────────────────
//
// The import CLI writes prospect_merge_candidates for every pair whose names are
// equal or one contains the other. Until this module existed nothing read those
// rows, so a duplicate pair could never be closed out. There are two operations:
// read the pending pairs, and collapse one pair into a single prospect.
//
// A merge touches five child tables plus the candidate table, so it cannot be
// expressed as one row update. The approval commit calls mergeProspects on the
// client it already holds, which keeps the whole merge and the receipt in a
// single transaction.

export interface MergeCandidateSide {
  id: string
  name: string
  country: 'AU' | 'VN'
  score: number | null
}

export interface MergeCandidate {
  id: string
  reason: string
  similarity: number
  left: MergeCandidateSide
  right: MergeCandidateSide
}

export interface MergeQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>
}

export interface MergeConnection extends MergeQueryable {
  release?(): void
}

/**
 * A pool hands out a different backend per query, so it is detected by
 * `connect` and given a transaction of its own. The client commitWithReceipt
 * passes in is already inside its transaction: issuing BEGIN there would be a
 * no-op and the merge's COMMIT would commit the receipt early.
 */
export interface MergeClient extends MergeQueryable {
  connect?(): Promise<MergeConnection>
}

export interface MergeProspectsInput {
  tenantId: string
  survivorId: string
  duplicateId: string
}

interface CandidateRow {
  id: string
  reason: string
  similarity: string | number
  left_id: string
  left_name: string
  left_country: 'AU' | 'VN'
  left_score: string | number | null
  right_id: string
  right_name: string
  right_country: 'AU' | 'VN'
  right_score: string | number | null
}

function scoreOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

// Both prospects are joined on the candidate's own tenant, not just on the FK:
// a candidate row and a prospect row can only ever be read together when they
// belong to the same tenant.
const LIST_SQL = `
  SELECT m.id, m.reason, m.similarity,
         l.id AS left_id, l.name AS left_name, l.country AS left_country,
         ls.total AS left_score,
         r.id AS right_id, r.name AS right_name, r.country AS right_country,
         rs.total AS right_score
    FROM prospect_merge_candidates m
    JOIN prospects l ON l.id = m.left_prospect_id AND l.tenant_id = m.tenant_id
    JOIN prospects r ON r.id = m.right_prospect_id AND r.tenant_id = m.tenant_id
    LEFT JOIN prospect_scores ls ON ls.prospect_id = l.id AND ls.tenant_id = m.tenant_id
    LEFT JOIN prospect_scores rs ON rs.prospect_id = r.id AND rs.tenant_id = m.tenant_id
   WHERE m.tenant_id = $1 AND m.status = 'pending'
   ORDER BY m.similarity DESC, m.created_at ASC`

export async function listMergeCandidates(tenantId: string): Promise<MergeCandidate[]> {
  const result = await getDbClient().query<CandidateRow>(LIST_SQL, [tenantId])
  return result.rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    similarity: Number(row.similarity),
    left: {
      id: row.left_id,
      name: row.left_name,
      country: row.left_country,
      score: scoreOrNull(row.left_score),
    },
    right: {
      id: row.right_id,
      name: row.right_name,
      country: row.right_country,
      score: scoreOrNull(row.right_score),
    },
  }))
}

/**
 * Collapse `duplicateId` into `survivorId` and return the survivor id.
 *
 * Every statement is tenant-scoped and the first one refuses the merge unless
 * both rows are visible, so a caller cannot pair its own prospect with somebody
 * else's. The duplicate is deleted last; anything still hanging off it goes with
 * it by cascade.
 */
export async function mergeProspects(
  client: MergeClient,
  input: MergeProspectsInput,
): Promise<string> {
  if (input.survivorId === input.duplicateId) {
    throw new Error('survivor_and_duplicate_are_the_same_prospect')
  }

  if (typeof client.connect !== 'function') {
    return mergeWithin(client, input)
  }

  const connection = await client.connect()
  try {
    await connection.query('BEGIN')
    const survivorId = await mergeWithin(connection, input)
    await connection.query('COMMIT')
    return survivorId
  } catch (error) {
    await connection.query('ROLLBACK')
    throw error
  } finally {
    connection.release?.()
  }
}

async function mergeWithin(
  client: MergeQueryable,
  input: MergeProspectsInput,
): Promise<string> {
  const { tenantId, survivorId, duplicateId } = input

  const owned = await client.query<{ id: string }>(
    `SELECT id FROM prospects WHERE tenant_id = $1 AND id IN ($2, $3)`,
    [tenantId, survivorId, duplicateId],
  )
  if (owned.rows.length !== 2) throw new Error('not_found')

  // Channels move only where the survivor does not already hold the same
  // (platform, handle_normalized): that pair is unique per tenant, so an
  // unconditional UPDATE would abort the whole merge on the first collision.
  await client.query(
    `UPDATE prospect_channels c
        SET prospect_id = $2
      WHERE c.tenant_id = $1
        AND c.prospect_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM prospect_channels s
           WHERE s.tenant_id = c.tenant_id
             AND s.prospect_id = $2
             AND s.platform = c.platform
             AND s.handle_normalized = c.handle_normalized
        )`,
    [tenantId, survivorId, duplicateId],
  )

  // A draft or thread on a channel that is about to be dropped is moved to the
  // survivor's channel for the same handle instead of following the channel into
  // the cascade. Only rows still on the duplicate are left at this point: the
  // UPDATE above already repointed every channel that had no conflict.
  await client.query(
    `UPDATE outreach_drafts d
        SET channel_id = s.id
       FROM prospect_channels c
       JOIN prospect_channels s
         ON s.tenant_id = c.tenant_id
        AND s.prospect_id = $2
        AND s.platform = c.platform
        AND s.handle_normalized = c.handle_normalized
      WHERE d.tenant_id = $1
        AND d.prospect_id = $3
        AND d.channel_id = c.id
        AND c.prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )
  await client.query(
    `UPDATE outreach_threads t
        SET channel_id = s.id
       FROM prospect_channels c
       JOIN prospect_channels s
         ON s.tenant_id = c.tenant_id
        AND s.prospect_id = $2
        AND s.platform = c.platform
        AND s.handle_normalized = c.handle_normalized
      WHERE t.tenant_id = $1
        AND t.prospect_id = $3
        AND t.channel_id = c.id
        AND c.prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )

  await client.query(
    `DELETE FROM prospect_channels WHERE tenant_id = $1 AND prospect_id = $2`,
    [tenantId, duplicateId],
  )

  // draft_hash is unique per tenant, so a draft that would collide with one the
  // survivor already holds is dropped before the repoint. Equal hashes mean the
  // same generated message, and the survivor's copy is the one that stays.
  await client.query(
    `DELETE FROM outreach_drafts d
      WHERE d.tenant_id = $1
        AND d.prospect_id = $3
        AND EXISTS (
          SELECT 1 FROM outreach_drafts s
           WHERE s.tenant_id = d.tenant_id
             AND s.prospect_id = $2
             AND s.draft_hash = d.draft_hash
        )`,
    [tenantId, survivorId, duplicateId],
  )

  await client.query(
    `UPDATE outreach_drafts SET prospect_id = $2 WHERE tenant_id = $1 AND prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )
  await client.query(
    `UPDATE outreach_threads SET prospect_id = $2 WHERE tenant_id = $1 AND prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )
  await client.query(
    `UPDATE prospect_snapshots SET prospect_id = $2 WHERE tenant_id = $1 AND prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )

  // prospect_consents is keyed on prospect_id, so exactly one row may survive.
  // Three statements keep the earliest record: drop the survivor's row when the
  // duplicate's is older, drop the duplicate's row when a survivor row remains,
  // then move whatever is left onto the survivor.
  await client.query(
    `DELETE FROM prospect_consents s
      WHERE s.tenant_id = $1
        AND s.prospect_id = $2
        AND EXISTS (
          SELECT 1 FROM prospect_consents d
           WHERE d.tenant_id = $1
             AND d.prospect_id = $3
             AND d.recorded_at < s.recorded_at
        )`,
    [tenantId, survivorId, duplicateId],
  )
  await client.query(
    `DELETE FROM prospect_consents d
      WHERE d.tenant_id = $1
        AND d.prospect_id = $2
        AND EXISTS (
          SELECT 1 FROM prospect_consents s
           WHERE s.tenant_id = $1 AND s.prospect_id = $3
        )`,
    [tenantId, duplicateId, survivorId],
  )
  await client.query(
    `UPDATE prospect_consents SET prospect_id = $2 WHERE tenant_id = $1 AND prospect_id = $3`,
    [tenantId, survivorId, duplicateId],
  )

  // Every pending pair that names either prospect is closed, not just the one
  // the caller resolved: otherwise a chain A~B, B~C would offer B again after
  // B was already folded into A. Pairs naming the duplicate disappear with it;
  // the ones naming the survivor stay behind marked 'merged'.
  await client.query(
    `UPDATE prospect_merge_candidates
        SET status = 'merged'
      WHERE tenant_id = $1
        AND status = 'pending'
        AND (left_prospect_id IN ($2, $3) OR right_prospect_id IN ($2, $3))`,
    [tenantId, survivorId, duplicateId],
  )

  const deleted = await client.query<{ id: string }>(
    `DELETE FROM prospects WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [duplicateId, tenantId],
  )
  if (!deleted.rows[0]) throw new Error('not_found')

  return survivorId
}

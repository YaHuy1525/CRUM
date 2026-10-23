import { getDbClient } from './client'
import { signReceipt, computeActionHash } from '../governance/receipt'

export interface PendingWrite {
  id: string
  tenantId: string
  runId: string
  threadId: string | null
  objectType: string
  operation: string
  targetId: string | null
  payload: unknown
  riskScore: number
  gate: string
  draftHash: string
  receiptId: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  requestedBy: string
  createdAt: string
  expiresAt: string
}

export interface CreateDraftParams {
  tenantId: string
  runId: string
  threadId?: string
  objectType: 'customer' | 'contact' | 'followup' | 'task' | 'schedule' | 'knowledge_document'
  operation: 'create' | 'update' | 'delete'
  targetId?: string
  payload: unknown
  riskScore: number
  gate: 'auto' | 'approval' | 'refuse'
  requestedBy: string
  idempotencyKey: string
}

function rowToPendingWrite(row: Record<string, unknown>): PendingWrite {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    runId: row.run_id as string,
    threadId: row.thread_id as string | null,
    objectType: row.object_type as string,
    operation: row.operation as string,
    targetId: row.target_id as string | null,
    payload: row.payload,
    riskScore: row.risk_score as number,
    gate: row.gate as string,
    draftHash: row.draft_hash as string,
    receiptId: row.receipt_id as string | null,
    rejectedAt: row.rejected_at as string | null,
    rejectionReason: row.rejection_reason as string | null,
    requestedBy: row.requested_by as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  }
}

/**
 * Insert a draft or return the existing one with the same idempotency key.
 * Uses ON CONFLICT on the partial unique index uq_pending_draft_hash.
 * The TTL for expires_at uses RUNS_RECEIPT_RECORD_TTL_SECONDS (default 86400s).
 */
export async function getOrCreateDraft(params: CreateDraftParams): Promise<PendingWrite> {
  const db = getDbClient()
  const ttlSeconds = parseInt(process.env.RUNS_RECEIPT_RECORD_TTL_SECONDS ?? '86400', 10)

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO pending_writes
       (tenant_id, run_id, thread_id, object_type, operation, target_id,
        payload, risk_score, gate, draft_hash, requested_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + interval '1 second' * $12)
     ON CONFLICT (tenant_id, draft_hash) WHERE receipt_id IS NULL AND rejected_at IS NULL
     DO UPDATE SET pending_writes.run_id = pending_writes.run_id
     RETURNING *`,
    [
      params.tenantId,
      params.runId,
      params.threadId ?? null,
      params.objectType,
      params.operation,
      params.targetId ?? null,
      JSON.stringify(params.payload),
      params.riskScore,
      params.gate,
      params.idempotencyKey,
      params.requestedBy,
      ttlSeconds,
    ],
  )
  return rowToPendingWrite(result.rows[0]!)
}

export interface CommitResult {
  committedId: string
  receiptId: string
}

/**
 * Commit a draft and write the audit receipt in one transaction.
 * The receipt signature binds pendingWriteId + runId + scope + actionHash + approvedBy.
 */
export async function commitWithReceipt(
  draft: PendingWrite,
  scope: { approvedBy: string; scope: string },
): Promise<CommitResult> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Re-check: has this draft already been decided?
    const existing = await client.query<{ receipt_id: string | null; rejected_at: string | null }>(
      `SELECT receipt_id, rejected_at FROM pending_writes WHERE id = $1`,
      [draft.id],
    )
    if (existing.rows[0]?.receipt_id) {
      throw new Error(`Draft ${draft.id} already committed`)
    }
    if (existing.rows[0]?.rejected_at) {
      throw new Error(`Draft ${draft.id} was rejected`)
    }

    // Insert the target record based on object_type + operation.
    // Phase 3 starts with customer create; other types follow the same pattern.
    let committedId: string
    const payload = draft.payload as Record<string, unknown>

    if (draft.objectType === 'customer' && draft.operation === 'create') {
      const r = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, company, email, phone, city, tags, owner_id, team_member_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          draft.tenantId,
          payload.name,
          payload.company ?? null,
          payload.email ?? null,
          payload.phone ?? null,
          payload.city ?? null,
          payload.tags ?? [],
          payload.owner_id ?? draft.requestedBy,
          payload.team_member_ids ?? [],
        ],
      )
      committedId = r.rows[0]!.id
    } else {
      throw new Error(`commitWithReceipt: unsupported type ${draft.objectType}/${draft.operation}`)
    }

    // Sign and write the receipt.
    const actionHash = computeActionHash(draft.payload)
    const signature = signReceipt({
      pendingWriteId: draft.id,
      runId: draft.runId,
      scope: scope.scope,
      actionHash,
      approvedBy: scope.approvedBy,
    })

    const receiptResult = await client.query<{ id: string }>(
      `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, committed_record_id, approved_by, decision)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved')
       RETURNING id`,
      [draft.tenantId, draft.id, draft.runId, signature, committedId, scope.approvedBy],
    )
    const receiptId = receiptResult.rows[0]!.id

    // Link receipt to the pending write.
    await client.query(
      `UPDATE pending_writes SET receipt_id = $1 WHERE id = $2`,
      [receiptId, draft.id],
    )

    await client.query('COMMIT')
    return { committedId, receiptId }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Reject a pending write. Writes an audit_receipt with decision='rejected'.
 */
export async function rejectPendingWrite(
  draftId: string,
  tenantId: string,
  runId: string,
  approvedBy: string,
  reason: string,
): Promise<string> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `UPDATE pending_writes SET rejected_at = now(), rejection_reason = $1 WHERE id = $2`,
      [reason, draftId],
    )

    const actionHash = computeActionHash({ rejected: true, draftId })
    const signature = signReceipt({
      pendingWriteId: draftId,
      runId,
      scope: 'crm:write',
      actionHash,
      approvedBy,
    })

    const r = await client.query<{ id: string }>(
      `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, approved_by, decision, reason)
       VALUES ($1, $2, $3, $4, $5, 'rejected', $6)
       RETURNING id`,
      [tenantId, draftId, runId, signature, approvedBy, reason],
    )

    await client.query('COMMIT')
    return r.rows[0]!.id
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export interface HumanTaskParams {
  tenantId: string
  runId: string
  threadId?: string
  toolName: string
  riskScore: number
  title: string
  body?: string
  requestedBy: string
}

/**
 * Create a human task for a refused write. §4.6.1 refuse path.
 */
export async function createHumanTask(
  params: HumanTaskParams,
  kind: 'refusal' | 'escalation' | 'review',
): Promise<string> {
  const db = getDbClient()
  const r = await db.query<{ id: string }>(
    `INSERT INTO human_tasks (tenant_id, run_id, thread_id, kind, title, body, tool_name, risk_score, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      params.tenantId,
      params.runId,
      params.threadId ?? null,
      kind,
      params.title,
      params.body ?? null,
      params.toolName,
      params.riskScore,
      params.requestedBy,
    ],
  )
  return r.rows[0]!.id
}

/**
 * List undecided pending writes for a tenant, highest risk first.
 * This is the data source for the approval queue (§11.3).
 */
export async function listPendingWrites(tenantId: string): Promise<PendingWrite[]> {
  const db = getDbClient()
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM pending_writes
     WHERE tenant_id = $1 AND receipt_id IS NULL AND rejected_at IS NULL
     ORDER BY risk_score DESC, created_at ASC`,
    [tenantId],
  )
  return r.rows.map(rowToPendingWrite)
}

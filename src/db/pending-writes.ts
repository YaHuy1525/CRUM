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
  committedAt: string | null
  committedRecordId: string | null
  requestedBy: string
  createdAt: string
  expiresAt: string
}

export interface CreateDraftParams {
  tenantId: string
  runId: string
  threadId?: string
  objectType:
    | 'customer'
    | 'contact'
    | 'followup'
    | 'task'
    | 'schedule'
    | 'knowledge_document'
    | 'email'
    | 'prospect'
    | 'prospect_channel'
    | 'outreach_draft'
    | 'outreach_send'
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
    committedAt: (row.committed_at as string | null | undefined) ?? null,
    committedRecordId: (row.committed_record_id as string | null | undefined) ?? null,
    requestedBy: row.requested_by as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  }
}

export async function getOrCreateDraft(params: CreateDraftParams): Promise<PendingWrite> {
  const db = getDbClient()
  const ttlSeconds = parseInt(process.env.RUNS_APPROVAL_TOKEN_TTL_SECONDS ?? '3600', 10)

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO pending_writes
       (tenant_id, run_id, thread_id, object_type, operation, target_id,
        payload, risk_score, gate, draft_hash, requested_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + interval '1 second' * $12)
     ON CONFLICT (tenant_id, draft_hash) WHERE receipt_id IS NULL AND rejected_at IS NULL
     DO UPDATE SET run_id = pending_writes.run_id
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
  committedId: string | null
  receiptId: string
}

interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export class UnsupportedCommitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCommitError'
  }
}

const COMMIT_TARGETS: Record<
  string,
  {
    table: string
    columns: Record<string, string>
    softDelete?: boolean
    ownerIdFrom?: string
    ownerColumn?: boolean
  }
> = {
  customer: {
    table: 'customers',
    softDelete: true,
    ownerIdFrom: 'newOwnerId',
    columns: {
      name: 'name',
      company: 'company',
      email: 'email',
      phone: 'phone',
      city: 'city',
      tags: 'tags',
      teamMemberIds: 'team_member_ids',
    },
  },
  contact: {
    table: 'contacts',
    ownerColumn: false,
    columns: {
      customerId: 'customer_id',
      name: 'name',
      role: 'role',
      email: 'email',
      phone: 'phone',
      notes: 'notes',
      isPrimary: 'is_primary',
    },
  },
  followup: {
    table: 'followups',
    columns: {
      customerId: 'customer_id',
      contactId: 'contact_id',
      type: 'type',
      status: 'status',
      scheduledAt: 'scheduled_at',
      completedAt: 'completed_at',
      notes: 'notes',
    },
  },
  task: {
    table: 'tasks',
    columns: {
      customerId: 'customer_id',
      title: 'title',
      description: 'description',
      deadline: 'deadline',
      priority: 'priority',
      status: 'status',
      assignedTo: 'assigned_to',
    },
  },
  schedule: {
    table: 'schedules',
    columns: {
      customerId: 'customer_id',
      title: 'title',
      startTime: 'start_time',
      endTime: 'end_time',
      location: 'location',
      attendees: 'attendees',
      status: 'status',
    },
  },
  // Channel and outreach rows carry no owner_id column, so the default owner
  // injection in mapColumns would name a column that does not exist.
  prospect: {
    table: 'prospects',
    columns: {
      name: 'name',
      nameNormalized: 'name_normalized',
      country: 'country',
      city: 'city',
      category: 'category',
      status: 'status',
    },
  },
  prospect_channel: {
    table: 'prospect_channels',
    ownerColumn: false,
    columns: {
      prospectId: 'prospect_id',
      platform: 'platform',
      handle: 'handle',
      handleNormalized: 'handle_normalized',
      profileUrl: 'profile_url',
      audienceCount: 'audience_count',
      audienceBasis: 'audience_basis',
      audienceConfidence: 'audience_confidence',
    },
  },
  outreach_draft: {
    table: 'outreach_drafts',
    ownerColumn: false,
    columns: {
      prospectId: 'prospect_id',
      channelId: 'channel_id',
      stage: 'stage',
      body: 'body',
      language: 'language',
      angle: 'angle',
      status: 'status',
      evidenceSnapshotId: 'evidence_snapshot_id',
      promptVersion: 'prompt_version',
      draftHash: 'draft_hash',
    },
  },
  // A send is a state change on an existing draft row, not a new table, so it
  // reuses the update path every other staged update uses.
  outreach_send: {
    table: 'outreach_drafts',
    ownerColumn: false,
    columns: {
      status: 'status',
      sentAt: 'sent_at',
    },
  },
}

function requireTarget(objectType: string): (typeof COMMIT_TARGETS)[string] {
  const target = COMMIT_TARGETS[objectType]
  if (!target) {
    throw new UnsupportedCommitError(
      `no CRM table commits object_type "${objectType}"; the mail lane owns its own delivery and knowledge documents commit through the ingest workflow`,
    )
  }
  return target
}

function placeholder(index: number): string {
  return `$${index}`
}

async function insertRow(
  client: Queryable,
  table: string,
  draft: PendingWrite,
  columns: Record<string, unknown>,
): Promise<string> {
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined)
  const names = ['tenant_id', ...entries.map(([column]) => column)]
  const values = [draft.tenantId, ...entries.map(([, value]) => value)]
  const placeholders = names.map((_, i) => placeholder(i + 1)).join(', ')
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values,
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error(`insert into ${table} returned no id`)
  return id
}

async function updateRow(
  client: Queryable,
  table: string,
  draft: PendingWrite,
  changes: Record<string, unknown>,
  extraPredicate?: string,
): Promise<string> {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined)
  if (entries.length === 0) {
    throw new UnsupportedCommitError(`staged update of ${table} carries no writable fields`)
  }
  const setClauses = entries.map(([column], i) => `${column} = ${placeholder(i + 1)}`)
  const values = entries.map(([, value]) => value)
  const idIdx = entries.length + 1
  const tenantIdx = entries.length + 2
  const where = extraPredicate
    ? `id = ${placeholder(idIdx)} AND tenant_id = ${placeholder(tenantIdx)} AND ${extraPredicate}`
    : `id = ${placeholder(idIdx)} AND tenant_id = ${placeholder(tenantIdx)}`
  const result = await client.query<{ id: string }>(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${where} RETURNING id`,
    [...values, draft.targetId, draft.tenantId],
  )
  const id = result.rows[0]?.id
  if (!id) {
    throw new UnsupportedCommitError(
      `${table} ${draft.targetId} is not visible to this tenant, or was removed after the draft was staged`,
    )
  }
  return id
}

async function deleteRow(
  client: Queryable,
  table: string,
  draft: PendingWrite,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `DELETE FROM ${table} WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [draft.targetId, draft.tenantId],
  )
  const id = result.rows[0]?.id
  if (!id) {
    throw new UnsupportedCommitError(`${table} ${draft.targetId} is not visible to this tenant`)
  }
  return id
}

function mapColumns(
  target: (typeof COMMIT_TARGETS)[string],
  payload: Record<string, unknown>,
  draft: PendingWrite,
  mode: 'create' | 'update',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const hasOwner = target.ownerColumn !== false
  for (const [key, column] of Object.entries(target.columns)) {
    if (payload[key] !== undefined) out[column] = payload[key]
  }
  if (mode === 'create') {
    if (hasOwner) out.owner_id = payload.ownerId ?? draft.requestedBy
    if (
      target.table === 'followups'
      && out.status === 'completed'
      && out.completed_at === undefined
    ) {
      throw new UnsupportedCommitError('followup status completed requires completedAt')
    }
  } else if (hasOwner && target.ownerIdFrom && payload[target.ownerIdFrom] !== undefined) {
    out.owner_id = payload[target.ownerIdFrom]
  }
  return out
}

async function applyDraft(
  client: Queryable,
  draft: PendingWrite,
): Promise<string | null> {
  const payload = (draft.payload ?? {}) as Record<string, unknown>

  if (draft.objectType === 'email') {
    if (draft.operation !== 'create') {
      throw new UnsupportedCommitError(`email supports only the create operation, not ${draft.operation}`)
    }
    if (draft.gate !== 'auto') {
      throw new UnsupportedCommitError(
        'mail.send is staged but not deliverable: the Gmail connector has a draft scope only, so approving it would emit a receipt for an email that was never sent',
      )
    }
    return null
  }

  const target = requireTarget(draft.objectType)

  switch (draft.operation) {
    case 'create':
      return insertRow(client, target.table, draft, mapColumns(target, payload, draft, 'create'))
    case 'update':
      return updateRow(
        client,
        target.table,
        draft,
        mapColumns(target, payload, draft, 'update'),
        target.softDelete ? 'deleted_at IS NULL' : undefined,
      )
    case 'delete':
      if (target.softDelete) {
        return updateRow(client, target.table, draft, { deleted_at: new Date() }, 'deleted_at IS NULL')
      }
      return deleteRow(client, target.table, draft)
    default:
      throw new UnsupportedCommitError(`unknown operation "${draft.operation}" for ${draft.objectType}`)
  }
}

export async function commitWithReceipt(
  draft: PendingWrite,
  scope: { approvedBy: string; scope: string },
): Promise<CommitResult> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query<{ receipt_id: string | null; rejected_at: string | null; committed_at: string | null }>(
      `SELECT receipt_id, rejected_at, committed_at FROM pending_writes WHERE id = $1`,
      [draft.id],
    )
    if (existing.rows[0]?.receipt_id) {
      throw new Error(`Draft ${draft.id} already committed`)
    }
    if (existing.rows[0]?.rejected_at) {
      throw new Error(`Draft ${draft.id} was rejected`)
    }

    const committedId = await applyDraft(client, draft)

    const actionHash = computeActionHash(draft.payload)
    const signature = signReceipt({
      pendingWriteId: draft.id,
      runId: draft.runId,
      scope: scope.scope,
      actionHash,
      approvedBy: scope.approvedBy,
    })

    const receiptResult = await client.query<{ id: string }>(
      `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, scope, committed_record_id, approved_by, decision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')
       RETURNING id`,
      [draft.tenantId, draft.id, draft.runId, signature, scope.scope, committedId, scope.approvedBy],
    )
    const receiptId = receiptResult.rows[0]!.id

    await client.query(
      `UPDATE pending_writes SET receipt_id = $1, committed_at = now(), committed_record_id = $2 WHERE id = $3`,
      [receiptId, committedId, draft.id],
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

export async function commitAutoWrite(draft: PendingWrite): Promise<PendingWrite> {
  if (draft.committedAt) return draft

  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const current = await client.query<Record<string, unknown>>(
      `SELECT * FROM pending_writes WHERE id = $1 AND tenant_id = $2`,
      [draft.id, draft.tenantId],
    )
    const fresh = current.rows[0] ? rowToPendingWrite(current.rows[0]) : draft
    if (fresh.committedAt) {
      await client.query('COMMIT')
      return fresh
    }
    if (fresh.rejectedAt) {
      throw new Error(`Draft ${fresh.id} was rejected and cannot be auto-committed`)
    }

    const committedId = await applyDraft(client, fresh)

    await client.query(
      `UPDATE pending_writes SET committed_at = now(), committed_record_id = $1 WHERE id = $2`,
      [committedId, fresh.id],
    )
    await client.query('COMMIT')

    return { ...fresh, committedAt: new Date().toISOString(), committedRecordId: committedId }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function getPendingWrite(id: string, tenantId: string): Promise<PendingWrite | null> {
  const db = getDbClient()
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM pending_writes WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )
  const row = result.rows[0]
  return row ? rowToPendingWrite(row) : null
}

export interface Receipt {
  id: string
  tenantId: string
  pendingWriteId: string
  runId: string
  signature: string
  committedRecordId: string | null
  approvedBy: string
  scope: string
  decision: 'approved' | 'rejected'
  reason: string | null
  createdAt: string
  payload: unknown
}

export async function getReceipt(id: string, tenantId: string): Promise<Receipt | null> {
  const db = getDbClient()
  const result = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.tenant_id, r.pending_write_id, r.run_id, r.signature,
            r.committed_record_id, r.approved_by, r.scope, r.decision, r.reason, r.created_at,
            p.payload, p.run_id AS draft_run_id
       FROM audit_receipts r
       JOIN pending_writes p ON p.id = r.pending_write_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    pendingWriteId: row.pending_write_id as string,
    runId: row.run_id as string,
    signature: row.signature as string,
    committedRecordId: (row.committed_record_id as string | null) ?? null,
    approvedBy: row.approved_by as string,
    scope: row.scope as string,
    decision: row.decision as 'approved' | 'rejected',
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
    payload: row.payload,
  }
}

export async function rejectPendingWrite(
  draftId: string,
  tenantId: string,
  runId: string,
  approvedBy: string,
  reason: string,
): Promise<string | null> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const mark = await client.query(
      `UPDATE pending_writes SET rejected_at = now(), rejection_reason = $1
        WHERE id = $2 AND tenant_id = $3`,
      [reason, draftId, tenantId],
    )
    if (mark.rowCount === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const actionHash = computeActionHash({ rejected: true, draftId })
    const signature = signReceipt({
      pendingWriteId: draftId,
      runId,
      scope: 'crm:write',
      actionHash,
      approvedBy,
    })

    const r = await client.query<{ id: string }>(
      `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, scope, approved_by, decision, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'rejected', $7)
       RETURNING id`,
      [tenantId, draftId, runId, signature, 'crm:write', approvedBy, reason],
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

export async function listPendingWrites(tenantId: string): Promise<PendingWrite[]> {
  const db = getDbClient()
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM pending_writes
     WHERE tenant_id = $1 AND receipt_id IS NULL AND rejected_at IS NULL AND committed_at IS NULL
     ORDER BY risk_score DESC, created_at ASC`,
    [tenantId],
  )
  return r.rows.map(rowToPendingWrite)
}

export async function listDecidedWrites(tenantId: string, limit = 50): Promise<PendingWrite[]> {
  const db = getDbClient()
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM pending_writes
     WHERE tenant_id = $1
       AND (receipt_id IS NOT NULL OR rejected_at IS NOT NULL OR committed_at IS NOT NULL)
     ORDER BY GREATEST(COALESCE(committed_at, '-infinity'::timestamptz),
                       COALESCE(rejected_at, '-infinity'::timestamptz),
                       created_at) DESC
     LIMIT $2`,
    [tenantId, limit],
  )
  return r.rows.map(rowToPendingWrite)
}

/** Test-only view of the object-type to table mapping. */
export const __testing = { COMMIT_TARGETS }

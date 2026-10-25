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
  /**
   * Set when an `auto`-gate draft has been applied to its target table. Auto
   * writes have no receipt (they are idempotent, not human-approved, §12.4), so
   * without this column an auto draft would look undecided forever and flood the
   * approval queue. Also the replay guard: a retry of the same correlationId
   * recovers this row instead of applying the write twice.
   */
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
  objectType: 'customer' | 'contact' | 'followup' | 'task' | 'schedule' | 'knowledge_document' | 'email'
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
  committedId: string | null
  receiptId: string
}

/**
 * A client that is already inside a transaction. `commitWithReceipt` opens the
 * transaction, so the committers below must not connect or release.
 */
interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

/**
 * Thrown when a draft describes work this module cannot perform: an object type
 * with no table, an operation with no column mapping, or a staged change whose
 * target row is gone. The approval route answers 422 for these rather than 500,
 * because a bad draft is a data problem the approver can act on, not a server
 * fault.
 */
export class UnsupportedCommitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCommitError'
  }
}

/**
 * One entry per object type: the table, and the payload key -> column map.
 *
 * The staged payload is the staging tool's Zod input (`tools/approval-writes.ts`,
 * `tools/customer-writes.ts`, `tools/auto-writes.ts`), so the keys are camelCase
 * while the columns are snake_case (`isPrimary` -> `is_primary`). `draftHash` and
 * `correlationId` are idempotency metadata and deliberately have no column.
 *
 * `ownerIdFrom` names the payload key that supplies `owner_id` on an update:
 * `crm.transfer_owner` stages `{ newOwnerId }` and nothing else, so a plain
 * column map cannot express it.
 *
 * `ownerColumn: false` marks a table that has no `owner_id` to write. Contacts
 * are the only one: migration 0002:47 deliberately omits it, because a contact's
 * visibility is its customer's visibility and a second owner column could
 * disagree with the first. Stamping an owner there would not just be redundant —
 * the INSERT would fail on an unknown column, so an approved contact could never
 * be committed at all.
 */
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
    // No owner_id: contacts inherit visibility from the parent customer
    // (migration 0002:47), so a transfer cannot be applied here at all.
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

/** Inserts one row, always with the draft's tenant. Returns the new id. */
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

/**
 * Applies a partial update by id. Every column name comes from the reviewed map
 * above, never from the payload, so a staged payload cannot name a column it has
 * not earned (`owner_id`, `tenant_id`, `receipt_id`). The tenant predicate is
 * unconditional: an update keyed only on id would cross tenants the moment a
 * targetId leaked.
 */
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

/**
 * Maps a staged payload onto one table's columns.
 *
 * `mode` decides how the owner is chosen: a create owns the record for the
 * requester (or an explicit `ownerId` in the payload), an update must never
 * invent an owner, and a transfer moves it from the payload key the target names.
 */
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
    // followups and tasks default their status in the schema, but the CHECK on
    // followups ties 'completed' to completed_at, so a payload that claims
    // completion without a timestamp must not reach the INSERT.
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

/**
 * Applies a staged draft to its business table. This is the only place that
 * turns a `pending_writes` row into a real record, and it switches on the draft's
 * own `object_type`/`operation` rather than on a caller's assumption: the queue
 * holds five object types, and a committer that only understood customers made
 * every other approval a silent no-op.
 */
async function applyDraft(
  client: Queryable,
  draft: PendingWrite,
): Promise<string | null> {
  const payload = (draft.payload ?? {}) as Record<string, unknown>

  // An auto email draft is the artifact itself; there is no CRM row to create.
  // An APPROVAL-gated email is a different promise — approving `mail.send` means
  // the message goes out — and this layer cannot deliver it: sending needs a
  // connected mailbox and the Gmail send scope CRUM does not request today.
  // Refusing here is the honest answer; returning null would emit an approved
  // receipt for an email nobody sent.
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
        // Soft delete: contacts/followups are ON DELETE CASCADE (migration
        // 0002), so a hard delete would wipe a customer's entire history. The
        // read layer filters `deleted_at IS NULL`.
        return updateRow(client, target.table, draft, { deleted_at: new Date() }, 'deleted_at IS NULL')
      }
      return deleteRow(client, target.table, draft)
    default:
      throw new UnsupportedCommitError(`unknown operation "${draft.operation}" for ${draft.objectType}`)
  }
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

/**
 * Applies an `auto`-gate draft to its business table, with no receipt.
 *
 * The auto tools used to stop at `getOrCreateDraft` and then tell the user
 * "Followup logged" / "Task created" — the row existed only as a draft, and the
 * queue filled with writes nobody would ever approve. This is the other half of
 * that path. It is replay-safe by construction: `getOrCreateDraft` returns the
 * existing row for a repeated correlationId, and a draft already marked
 * `committed_at` is returned as-is instead of being applied a second time.
 *
 * Returns the draft with `committedAt`/`committedRecordId` reflecting reality.
 */
export async function commitAutoWrite(draft: PendingWrite): Promise<PendingWrite> {
  if (draft.committedAt) return draft

  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Read the row back inside the transaction: the draft we were handed may be
    // a stale copy of one another request already committed.
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

/**
 * Loads one draft, scoped to the tenant that owns it. A decision route must not
 * be able to act on another tenant's draft by guessing a uuid, so this filters on
 * tenant_id in the same predicate that finds the id.
 */
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
  decision: 'approved' | 'rejected'
  reason: string | null
  createdAt: string
  /** The draft payload, joined in so the signature can be re-computed. */
  payload: unknown
}

/**
 * Reads a receipt with the draft payload attached. `verifyReceipt` needs the
 * canonical payload to recompute the action hash, and a receipt read without it
 * can only echo its own signature back — which proves nothing.
 */
export async function getReceipt(id: string, tenantId: string): Promise<Receipt | null> {
  const db = getDbClient()
  const result = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.tenant_id, r.pending_write_id, r.run_id, r.signature,
            r.committed_record_id, r.approved_by, r.decision, r.reason, r.created_at,
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
    decision: row.decision as 'approved' | 'rejected',
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
    payload: row.payload,
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
 * List undecided, unapplied pending writes for a tenant, highest risk first.
 * This is the data source for the approval queue (§11.3).
 *
 * `committed_at IS NULL` is what keeps the queue honest: an `auto`-gate draft is
 * applied the moment the tool runs, so without this predicate every low-risk
 * followup and task would sit in the approval queue looking like a decision
 * nobody has made yet.
 */
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

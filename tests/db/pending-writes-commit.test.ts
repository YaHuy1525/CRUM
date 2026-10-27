// tests/db/pending-writes-commit.test.ts
import { afterEach, beforeEach, describe, expect, it, beforeAll, vi } from 'vitest'

/**
 * The commit layer turns a `pending_writes` row into a real business record.
 * Its integration test (`tests/integration/pending-writes.test.ts`) skips
 * without a live database, so without this file the whole of `applyDraft` —
 * every object type, the tenant predicate, the soft-delete rule — would be
 * verified only by hand. This drives the SQL through a fake pool and asserts on
 * the statements themselves, because the statements ARE the contract: a column
 * name that came from the payload instead of the reviewed map, or an UPDATE
 * missing its `tenant_id`, is a defect no row-level assertion would catch.
 */
const env = vi.hoisted(() => {
  interface Step {
    text: string
    values: unknown[]
  }
  const state = {
    steps: [] as Step[],
    /** Rows for the `SELECT receipt_id, rejected_at, committed_at` re-check. */
    recheck: [{ receipt_id: null, rejected_at: null, committed_at: null }] as Record<string, unknown>[],
    /** Row for `SELECT * FROM pending_writes WHERE id = $1 AND tenant_id = $2`. */
    draftRow: null as Record<string, unknown> | null,
    /** Rows for the tenant-scoped queue select. */
    queueRows: [] as Record<string, unknown>[],
    /** Rows for the receipt join select. */
    receiptRow: null as Record<string, unknown> | null,
    /** Rows for `INSERT INTO pending_writes ... RETURNING *`. */
    draftInsertRow: null as Record<string, unknown> | null,
    /** rowCount for a statement with no RETURNING, so a no-op can be simulated. */
    updateRowCount: 1,
    /** Id an INSERT/UPDATE/DELETE ... RETURNING id hands back; null = no row. */
    returnedId: 'aaaaaaaa-0000-0000-0000-000000000001' as string | null,
    released: 0,
    rolledBack: false,
  }

  function norm(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  function rows(id: string | null) {
    return id === null ? [] : [{ id }]
  }

  /**
   * pg hands back `rows` AND `rowCount`, and the two are not the same thing: an
   * UPDATE without RETURNING produces zero rows but a meaningful rowCount, which
   * is exactly how the reject path detects a draft owned by a different tenant.
   * So the fake computes both rather than deriving one from the other.
   */
  function resolve(text: string, values: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    const t = norm(text)
    state.steps.push({ text: t, values })

    if (/^BEGIN$/.test(t) || /^COMMIT$/.test(t)) return { rows: [], rowCount: 0 }
    if (/^ROLLBACK$/.test(t)) {
      state.rolledBack = true
      return { rows: [], rowCount: 0 }
    }
    if (t.startsWith('SELECT receipt_id, rejected_at, committed_at')) {
      return { rows: state.recheck, rowCount: state.recheck.length }
    }
    if (t.startsWith('SELECT * FROM pending_writes WHERE id =')) {
      const rows = state.draftRow ? [state.draftRow] : []
      return { rows, rowCount: rows.length }
    }
    if (t.startsWith('SELECT * FROM pending_writes WHERE tenant_id =')) {
      return { rows: state.queueRows, rowCount: state.queueRows.length }
    }
    if (t.startsWith('SELECT r.id,')) {
      const rows = state.receiptRow ? [state.receiptRow] : []
      return { rows, rowCount: rows.length }
    }
    // The reject path marks the draft before it signs anything, and must be able
    // to see that it marked nothing.
    if (t.startsWith('UPDATE pending_writes SET rejected_at')) {
      return { rows: [], rowCount: state.updateRowCount }
    }
    if (t.startsWith('INSERT INTO pending_writes')) {
      const rows = state.draftInsertRow ? [state.draftInsertRow] : []
      return { rows, rowCount: rows.length }
    }
    if (t.startsWith('INSERT INTO') || t.startsWith('UPDATE') || t.startsWith('DELETE')) {
      const out = rows(state.returnedId)
      return { rows: out, rowCount: out.length }
    }
    throw new Error(`pending-writes test fake received unhandled SQL: ${t}`)
  }

  // Deliberately not `async`: the fake has nothing to await, and an empty await
  // would only make the resolver look busier than it is.
  const query = (text: string, values: unknown[] = []) => Promise.resolve(resolve(text, values))

  const client = {
    query,
    release: () => {
      state.released += 1
    },
  }

  const pool = { query, connect: () => Promise.resolve(client) }

  return { state, pool, norm }
})

vi.mock('../../src/db/client', () => ({
  getDbClient: () => env.pool,
  closeDbClient: async () => {},
}))

import {
  commitAutoWrite,
  commitWithReceipt,
  getOrCreateDraft,
  getPendingWrite,
  getReceipt,
  listDecidedWrites,
  listPendingWrites,
  rejectPendingWrite,
  UnsupportedCommitError,
  type PendingWrite,
} from '../../src/db/pending-writes'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_TENANT = '550e8400-e29b-41d4-a716-4466554400ff'
const USER = '660e8400-e29b-41d4-a716-446655440001'
const APPROVER = '660e8400-e29b-41d4-a716-446655440009'
const DRAFT_ID = '770e8400-e29b-41d4-a716-446655440003'
const TARGET_ID = '880e8400-e29b-41d4-a716-446655440004'

function draft(over: Partial<PendingWrite> = {}): PendingWrite {
  return {
    id: DRAFT_ID,
    tenantId: TENANT,
    runId: 'pending',
    threadId: null,
    objectType: 'customer',
    operation: 'create',
    targetId: null,
    payload: { name: 'Acme Industrial', company: 'Acme' },
    riskScore: 55,
    gate: 'approval',
    draftHash: 'deadbeef',
    receiptId: null,
    rejectedAt: null,
    rejectionReason: null,
    committedAt: null,
    committedRecordId: null,
    requestedBy: USER,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  }
}

/** All statements whose text matches, in execution order. */
function steps(match: RegExp) {
  return env.state.steps.filter((s) => match.test(s.text))
}

/**
 * The one statement that must have run. Fails with the whole transcript, which
 * is far quicker to read than an `undefined` assertion error two lines later.
 */
function onlyStep(match: RegExp) {
  const hits = steps(match)
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one statement matching ${match}, got ${hits.length}.\n` +
        env.state.steps.map((s) => s.text).join('\n'),
    )
  }
  return hits[0]!
}

/** The column list of the single INSERT into `table`. */
function insertColumns(table: string): string[] {
  const step = onlyStep(new RegExp(`^INSERT INTO ${table} \\(`))
  return step.text.slice(step.text.indexOf('(') + 1, step.text.indexOf(')')).split(', ')
}

function approve(d = draft()) {
  return commitWithReceipt(d, { approvedBy: APPROVER, scope: 'crm:write' })
}

/**
 * One case per object type the approval queue can hold. Typed rather than
 * inferred so the case table is read as schema documentation, not as four
 * anonymous tuples.
 */
interface RouteCase {
  objectType: string
  table: string
  /** The exact column list the INSERT must use, tenant first. */
  columns: string[]
  payload: Record<string, unknown>
}

const ROUTE_CASES: RouteCase[] = [
  {
    objectType: 'contact',
    table: 'contacts',
    // No owner_id: migration 0002:47 omits it on purpose, and Postgres
    // rejects the INSERT outright if one is supplied.
    columns: ['tenant_id', 'customer_id', 'name', 'is_primary'],
    payload: { customerId: TARGET_ID, name: 'Dana', isPrimary: true },
  },
  {
    objectType: 'followup',
    table: 'followups',
    columns: ['tenant_id', 'customer_id', 'type', 'scheduled_at', 'owner_id'],
    payload: { customerId: TARGET_ID, type: 'call', scheduledAt: '2026-10-30T10:00:00.000Z' },
  },
  {
    objectType: 'task',
    table: 'tasks',
    columns: ['tenant_id', 'customer_id', 'title', 'priority', 'owner_id'],
    payload: { customerId: TARGET_ID, title: 'Renew', priority: 'high' },
  },
  {
    objectType: 'schedule',
    table: 'schedules',
    columns: ['tenant_id', 'customer_id', 'title', 'start_time', 'end_time', 'owner_id'],
    payload: {
      customerId: TARGET_ID,
      title: 'QBR',
      startTime: '2026-11-02T09:00:00.000Z',
      endTime: '2026-11-02T10:00:00.000Z',
    },
  },
]

beforeAll(() => {
  process.env.APPROVAL_HMAC_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!'
})

beforeEach(() => {
  env.state.steps = []
  env.state.recheck = [{ receipt_id: null, rejected_at: null, committed_at: null }]
  env.state.draftRow = null
  env.state.queueRows = []
  env.state.receiptRow = null
  env.state.draftInsertRow = null
  env.state.updateRowCount = 1
  env.state.returnedId = 'aaaaaaaa-0000-0000-0000-000000000001'
  env.state.released = 0
  env.state.rolledBack = false
})

describe('commitWithReceipt — object types the queue actually holds', () => {
  it('creates a customer owned by the requester, in the draft tenant', async () => {
    const result = await approve()

    expect(insertColumns('customers')).toEqual(['tenant_id', 'name', 'company', 'owner_id'])
    expect(onlyStep(/^INSERT INTO customers/).values).toEqual([TENANT, 'Acme Industrial', 'Acme', USER])
    expect(result.committedId).toBe('aaaaaaaa-0000-0000-0000-000000000001')
  })

  /**
   * The defect this guards: `commitWithReceipt` used to hard-code a customer
   * INSERT regardless of the draft, so approving a contact/task/schedule/
   * followup silently wrote a customer row (or threw on the NOT NULL columns)
   * while still emitting a receipt that claimed the approved object existed.
   *
   * The expected column list is written out in full because the schema is the
   * contract: an extra column is an INSERT that fails at `audit_receipts` time,
   * and a missing NOT NULL column (`owner_id`, `scheduled_at`) fails sooner.
   */
  it.each(ROUTE_CASES)(
    'routes a $objectType draft to its own table with its own columns',
    async ({ objectType, table, columns: expected, payload }) => {
      await approve(draft({ objectType, payload }))

      expect(steps(/^INSERT INTO customers/)).toHaveLength(0)
      const columns = insertColumns(table)
      expect(columns[0]).toBe('tenant_id')
      expect(columns).toEqual(expected)
      expect(onlyStep(new RegExp(`^INSERT INTO ${table}`)).values[0]).toBe(TENANT)
    },
  )

  it('writes exactly one receipt and stamps the draft as committed', async () => {
    await approve()

    const receipt = onlyStep(/^INSERT INTO audit_receipts/)
    expect(receipt.values[0]).toBe(TENANT)
    expect(receipt.values[1]).toBe(DRAFT_ID)
    // The scope is half of the HMAC input, so it has to travel with the signature
    // or `GET /receipts/:id` cannot recompute it without guessing.
    expect(receipt.values[4]).toBe('crm:write')
    expect(receipt.values[6]).toBe(APPROVER)
    expect(receipt.text).toMatch(/'approved'/)

    const stamp = onlyStep(/^UPDATE pending_writes SET receipt_id/)
    expect(stamp.text).toMatch(/committed_at = now\(\)/)
    expect(stamp.values).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000001',
      DRAFT_ID,
    ])
    expect(env.state.steps.at(-1)!.text).toBe('COMMIT')
    expect(env.state.released).toBe(1)
  })

  it('rolls back and releases when the target row vanished', async () => {
    env.state.returnedId = null

    await expect(
      approve(draft({ operation: 'update', targetId: TARGET_ID, payload: { name: 'Renamed' } })),
    ).rejects.toThrow(UnsupportedCommitError)

    expect(env.state.rolledBack).toBe(true)
    expect(env.state.released).toBe(1)
    expect(steps(/^INSERT INTO audit_receipts/)).toHaveLength(0)
  })

  it('refuses a draft that already has a receipt', async () => {
    env.state.recheck = [{ receipt_id: 'already', rejected_at: null, committed_at: null }]

    await expect(approve()).rejects.toThrow(/already committed/i)
    expect(steps(/^INSERT INTO/)).toHaveLength(0)
  })

  it('refuses a rejected draft', async () => {
    env.state.recheck = [{ receipt_id: null, rejected_at: '2026-10-24T00:00:00.000Z', committed_at: null }]

    await expect(approve()).rejects.toThrow(/was rejected/i)
    expect(steps(/^INSERT INTO/)).toHaveLength(0)
  })
})

describe('commitWithReceipt — column and tenant governance', () => {
  /**
   * The staged payload is model/tool input. If a key could name a column, a
   * prompt-injected `{"owner_id": "..."}` would move a record between owners
   * through the approval path, and `tenant_id`/`receipt_id` would be next.
   */
  it('ignores payload keys that are not in the reviewed column map', async () => {
    const payload = {
      name: 'Acme Industrial',
      owner_id: OTHER_TENANT,
      tenant_id: OTHER_TENANT,
      receipt_id: 'ffffffff-0000-0000-0000-00000000000f',
      id: TARGET_ID,
      deleted_at: null,
    }
    await approve(draft({ payload }))

    const columns = insertColumns('customers')
    expect(columns).toEqual(['tenant_id', 'name', 'owner_id'])
    const values = onlyStep(/^INSERT INTO customers/).values
    expect(values).not.toContain(OTHER_TENANT)
    expect(values).not.toContain('ffffffff-0000-0000-0000-00000000000f')
  })

  it('keys every update on id AND tenant', async () => {
    await approve(
      draft({
        operation: 'update',
        targetId: TARGET_ID,
        payload: { customerId: TARGET_ID, name: 'Renamed' },
      }),
    )

    const update = onlyStep(/^UPDATE customers/)
    expect(update.text).toMatch(/WHERE id = \$\d+ AND tenant_id = \$\d+/)
    expect(update.values.slice(-2)).toEqual([TARGET_ID, TENANT])
  })

  it('refuses an update that stages nothing to write', async () => {
    await expect(
      approve(draft({ operation: 'update', targetId: TARGET_ID, payload: { draftHash: 'x' } })),
    ).rejects.toThrow(/no writable fields/)
  })

  it('transfers ownership only from the key the target declares', async () => {
    await approve(
      draft({ operation: 'update', targetId: TARGET_ID, payload: { newOwnerId: APPROVER } }),
    )

    const update = onlyStep(/^UPDATE customers/)
    expect(update.text).toMatch(/owner_id = \$1/)
    expect(update.values).toContain(APPROVER)
  })

  it('adds a live-row predicate to a customer update but not to a contact one', async () => {
    await approve(draft({ operation: 'update', targetId: TARGET_ID, payload: { name: 'Renamed' } }))
    expect(onlyStep(/^UPDATE customers/).text).toMatch(/deleted_at IS NULL/)

    await approve(
      draft({ objectType: 'contact', operation: 'update', targetId: TARGET_ID, payload: { name: 'Renamed' } }),
    )
    expect(onlyStep(/^UPDATE contacts/).text).not.toMatch(/deleted_at/)
  })
})

describe('applyDraft — deletes, soft deletes, and unsupported work', () => {
  it('soft deletes a customer instead of cascading away its history', async () => {
    await approve(draft({ operation: 'delete', targetId: TARGET_ID, payload: { customerId: TARGET_ID } }))

    expect(steps(/^DELETE FROM customers/)).toHaveLength(0)
    const update = onlyStep(/^UPDATE customers/)
    expect(update.text).toMatch(/^UPDATE customers SET deleted_at = \$1/)
    expect(update.values.at(-2)).toBe(TARGET_ID)
    expect(update.values.at(-1)).toBe(TENANT)
  })

  it('hard deletes a contact, which has no deleted_at column', async () => {
    await approve(draft({ objectType: 'contact', operation: 'delete', targetId: TARGET_ID }))

    const del = onlyStep(/^DELETE FROM contacts/)
    expect(del.text).toMatch(/WHERE id = \$1 AND tenant_id = \$2/)
    expect(del.values).toEqual([TARGET_ID, TENANT])
  })

  /**
   * `pending_writes.object_type` accepts types with no CRM table. Approving one
   * must not mint a receipt, because a receipt is the proof that the approved
   * thing happened.
   */
  it('refuses an object type with no table', async () => {
    await expect(
      approve(draft({ objectType: 'knowledge_document' })),
    ).rejects.toThrow(/no CRM table commits object_type/)
    expect(steps(/^INSERT INTO audit_receipts/)).toHaveLength(0)
  })

  it('refuses an unknown operation', async () => {
    await expect(approve(draft({ operation: 'upsert' }))).rejects.toThrow(/unknown operation/)
  })

  it('settles an auto email draft with no CRM row and no fabricated record id', async () => {
    const result = await approve(draft({ objectType: 'email', gate: 'auto', payload: { to: 'a@b.c' } }))

    expect(result.committedId).toBeNull()
    expect(steps(/^INSERT INTO/).map((s) => s.text)).toEqual([
      expect.stringMatching(/^INSERT INTO audit_receipts/),
    ])
  })

  /**
   * Honesty over completeness: the Gmail connector can create drafts but the
   * project does not request the send scope, so approving `mail.send` would
   * sign a receipt for an email nobody sent. Refusing is the correct answer
   * until a real transport exists.
   */
  it('refuses to approve an email send', async () => {
    await expect(
      approve(draft({ objectType: 'email', gate: 'approval', payload: { to: 'a@b.c' } })),
    ).rejects.toThrow(/not deliverable/)
    expect(steps(/^INSERT INTO audit_receipts/)).toHaveLength(0)
  })

  it('refuses a non-create email', async () => {
    await expect(
      approve(draft({ objectType: 'email', gate: 'auto', operation: 'update' })),
    ).rejects.toThrow(/only the create operation/)
  })

  it('refuses a completed followup with no completion time', async () => {
    await expect(
      approve(draft({ objectType: 'followup', payload: { customerId: TARGET_ID, type: 'call', status: 'completed' } })),
    ).rejects.toThrow(/requires completedAt/)
  })
})

describe('commitAutoWrite', () => {
  /**
   * The bug this exists for: the auto tools stopped at the staged draft and
   * answered "Followup logged", so the business table stayed empty and the
   * approval queue filled with writes that were never going to be approved.
   */
  it('applies the write and never touches audit_receipts', async () => {
    const d = draft({
      gate: 'auto',
      runId: 'auto',
      objectType: 'followup',
      payload: { customerId: TARGET_ID, type: 'call', scheduledAt: '2026-10-30T10:00:00.000Z' },
    })

    const applied = await commitAutoWrite(d)

    expect(steps(/^INSERT INTO followups/)).toHaveLength(1)
    expect(steps(/^INSERT INTO audit_receipts/)).toHaveLength(0)
    const stamp = onlyStep(/^UPDATE pending_writes SET committed_at/)
    expect(stamp.values).toEqual(['aaaaaaaa-0000-0000-0000-000000000001', DRAFT_ID])
    expect(applied.committedRecordId).toBe('aaaaaaaa-0000-0000-0000-000000000001')
    expect(applied.committedAt).toBeTruthy()
  })

  it('is a no-op when the row is already committed', async () => {
    const d = draft({ gate: 'auto', runId: 'auto', objectType: 'task', payload: { title: 'Renew' } })
    env.state.draftRow = {
      id: DRAFT_ID,
      tenant_id: TENANT,
      run_id: 'auto',
      object_type: 'task',
      operation: 'create',
      payload: d.payload,
      risk_score: 10,
      gate: 'auto',
      draft_hash: 'deadbeef',
      receipt_id: null,
      rejected_at: null,
      committed_at: '2026-10-24T09:00:00.000Z',
      committed_record_id: TARGET_ID,
      requested_by: USER,
      created_at: d.createdAt,
      expires_at: d.expiresAt,
    }

    const applied = await commitAutoWrite(d)

    // A retried correlationId must not create a second task.
    expect(steps(/^INSERT INTO tasks/)).toHaveLength(0)
    expect(steps(/^UPDATE pending_writes/)).toHaveLength(0)
    expect(applied.committedRecordId).toBe(TARGET_ID)
    expect(env.state.steps.at(-1)!.text).toBe('COMMIT')
  })

  it('refuses to auto-commit a rejected draft', async () => {
    const d = draft({ gate: 'auto', runId: 'auto' })
    env.state.draftRow = {
      id: DRAFT_ID, tenant_id: TENANT, run_id: 'auto', object_type: 'customer',
      operation: 'create', payload: d.payload, risk_score: 55, gate: 'auto',
      draft_hash: 'deadbeef', receipt_id: null, rejected_at: '2026-10-24T09:00:00.000Z',
      committed_at: null, requested_by: USER, created_at: d.createdAt, expires_at: d.expiresAt,
    }

    await expect(commitAutoWrite(d)).rejects.toThrow(/was rejected/)
    expect(env.state.rolledBack).toBe(true)
  })
})

describe('queue readers', () => {
  it('hides applied drafts, rejected drafts and receipts, and stays in the tenant', async () => {
    await listPendingWrites(TENANT)

    const select = onlyStep(/^SELECT \* FROM pending_writes WHERE tenant_id =/)
    expect(select.text).toMatch(/receipt_id IS NULL/)
    expect(select.text).toMatch(/rejected_at IS NULL/)
    expect(select.text).toMatch(/committed_at IS NULL/)
    expect(select.text).toMatch(/ORDER BY risk_score DESC/)
    expect(select.values).toEqual([TENANT])
  })

  it('hides nothing from the decided history that the pending list hides, and bounds the window', async () => {
    env.state.queueRows = [
      {
        id: DRAFT_ID, tenant_id: TENANT, run_id: 'pending', object_type: 'customer',
        operation: 'create', payload: {}, risk_score: 55, gate: 'approval', draft_hash: 'x',
        receipt_id: 'aaaaaaaa-0000-0000-0000-000000000009', rejected_at: null,
        committed_at: '2026-10-24T09:30:00.000Z', committed_record_id: TARGET_ID,
        requested_by: USER, created_at: '2026-10-24T09:00:00.000Z',
        expires_at: '2026-10-24T10:00:00.000Z',
      },
    ]

    const decided = await listDecidedWrites(TENANT, 25)

    const select = onlyStep(/^SELECT \* FROM pending_writes WHERE tenant_id =/)
    // The exact inverse of the pending predicate: any one of the three markers
    // puts a draft in history, so all three have to be ORed.
    expect(select.text).toMatch(/receipt_id IS NOT NULL OR rejected_at IS NOT NULL OR committed_at IS NOT NULL/)
    expect(select.text).not.toMatch(/receipt_id IS NULL/)
    expect(select.text).toMatch(/LIMIT \$2/)
    expect(select.values).toEqual([TENANT, 25])
    expect(decided).toHaveLength(1)
  })

  it('reads one draft scoped to the tenant in the same predicate as the id', async () => {
    env.state.draftRow = {
      id: DRAFT_ID, tenant_id: TENANT, run_id: 'pending', object_type: 'customer',
      operation: 'create', payload: {}, risk_score: 55, gate: 'approval', draft_hash: 'x',
      receipt_id: null, rejected_at: null, committed_at: null, requested_by: USER,
      created_at: '2026-10-24T09:00:00.000Z', expires_at: '2026-10-24T10:00:00.000Z',
    }

    const found = await getPendingWrite(DRAFT_ID, TENANT)

    const select = onlyStep(/^SELECT \* FROM pending_writes WHERE id =/)
    expect(select.text).toMatch(/id = \$1 AND tenant_id = \$2/)
    expect(select.values).toEqual([DRAFT_ID, TENANT])
    expect(found!.id).toBe(DRAFT_ID)
    expect(found!.committedAt).toBeNull()
    expect(found!.committedRecordId).toBeNull()
  })

  it('returns null for another tenant draft and for a missing one', async () => {
    env.state.draftRow = null
    expect(await getPendingWrite(DRAFT_ID, OTHER_TENANT)).toBeNull()
  })

  it('joins the draft payload into the receipt so the signature can be recomputed', async () => {
    env.state.receiptRow = {
      id: 'rr000000-0000-0000-0000-000000000000', tenant_id: TENANT, pending_write_id: DRAFT_ID,
      run_id: 'pending', signature: 'sig', committed_record_id: TARGET_ID, approved_by: APPROVER,
      scope: 'crm:write',
      decision: 'approved', reason: null, created_at: '2026-10-24T09:00:00.000Z',
      payload: { name: 'Acme Industrial' },
    }

    const receipt = await getReceipt('rr000000-0000-0000-0000-000000000000', TENANT)

    const select = onlyStep(/^SELECT r\.id,/)
    expect(select.text).toMatch(/JOIN pending_writes p ON p\.id = r\.pending_write_id/)
    expect(select.text).toMatch(/r\.id = \$1 AND r\.tenant_id = \$2/)
    expect(receipt!.payload).toEqual({ name: 'Acme Industrial' })
    expect(receipt!.committedRecordId).toBe(TARGET_ID)
    expect(receipt!.scope).toBe('crm:write')
    expect(receipt!.reason).toBeNull()
  })

  it('returns null for a receipt the tenant cannot see', async () => {
    env.state.receiptRow = null
    expect(await getReceipt('rr000000-0000-0000-0000-000000000000', OTHER_TENANT)).toBeNull()
  })
})

/**
 * The other half of the decision surface. A rejection is signed and recorded just
 * like an approval, so it carries the same two hazards: a receipt that cannot be
 * re-verified, and a draft addressed by uuid with no tenant in the predicate.
 */
describe('rejectPendingWrite', () => {
  function reject(tenant = TENANT) {
    return rejectPendingWrite(DRAFT_ID, tenant, 'run-1', APPROVER, 'Wrong company')
  }

  it('records the rejection with the scope its signature covers', async () => {
    expect(await reject()).toBe('aaaaaaaa-0000-0000-0000-000000000001')

    const receipt = onlyStep(/^INSERT INTO audit_receipts/)
    expect(receipt.values[0]).toBe(TENANT)
    expect(receipt.values[1]).toBe(DRAFT_ID)
    expect(receipt.values[4]).toBe('crm:write')
    expect(receipt.values[5]).toBe(APPROVER)
    expect(receipt.text).toMatch(/'rejected'/)
  })

  /**
   * The isolation hole this closes: the mark-by-uuid UPDATE used to carry no
   * `tenant_id`, so tenant A could park tenant B's draft out of the queue by
   * guessing the id. Now the UPDATE matches nothing and no receipt is signed.
   */
  it('marks nothing and signs nothing for another tenant draft', async () => {
    env.state.updateRowCount = 0

    expect(await reject(OTHER_TENANT)).toBeNull()

    expect(onlyStep(/^UPDATE pending_writes SET rejected_at/).values)
      .toEqual(['Wrong company', DRAFT_ID, OTHER_TENANT])
    expect(onlyStep(/^UPDATE pending_writes SET rejected_at/).text).toMatch(/tenant_id = \$3/)
    expect(steps(/^INSERT INTO audit_receipts/)).toHaveLength(0)
    expect(env.state.rolledBack).toBe(true)
    expect(env.state.released).toBe(1)
  })
})

/**
 * §12.3 keeps two clocks apart: how long a human may still approve a draft, and
 * how long the record of the effect is kept so the effect cannot happen twice.
 * `getOrCreateDraft` used to read the 86400s record TTL for the approval window,
 * which left drafts approvable for a full day after the run that made them had
 * become irrelevant.
 */
describe('getOrCreateDraft — the approval window', () => {
  function seed(ttl?: string) {
    if (ttl === undefined) delete process.env.RUNS_APPROVAL_TOKEN_TTL_SECONDS
    else process.env.RUNS_APPROVAL_TOKEN_TTL_SECONDS = ttl

    env.state.draftInsertRow = {
      id: DRAFT_ID, tenant_id: TENANT, run_id: 'pending', object_type: 'customer',
      operation: 'create', payload: {}, risk_score: 55, gate: 'approval', draft_hash: 'x',
      receipt_id: null, rejected_at: null, committed_at: null, requested_by: USER,
      created_at: '2026-10-24T09:00:00.000Z', expires_at: '2026-10-24T10:00:00.000Z',
    }
    return getOrCreateDraft({
      tenantId: TENANT, runId: 'pending', objectType: 'customer', operation: 'create',
      payload: { name: 'Acme' }, riskScore: 55, gate: 'approval',
      requestedBy: USER, idempotencyKey: 'hash-1',
    })
  }

  afterEach(() => {
    delete process.env.RUNS_APPROVAL_TOKEN_TTL_SECONDS
  })

  it('defaults the window to the approval-token TTL, not the record TTL', async () => {
    // The other knob is deliberately set to a different number, so a route that
    // reads the wrong one cannot pass by coincidence.
    process.env.RUNS_RECEIPT_RECORD_TTL_SECONDS = '86400'

    const created = await seed()

    const insert = onlyStep(/^INSERT INTO pending_writes/)
    expect(insert.values[11]).toBe(3600)
    expect(created.id).toBe(DRAFT_ID)
  })

  it('honours an explicit window', async () => {
    await seed('600')
    expect(onlyStep(/^INSERT INTO pending_writes/).values[11]).toBe(600)
  })
})

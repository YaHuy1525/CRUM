// tests/api/approvals.test.ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The approval surface, exercised over real HTTP through the Hono app rather than
 * by asserting the router "is defined". What is asserted here is the part that
 * cannot be checked by reading: which identity a route acts as, whether a decision
 * reaches the commit layer at all, and whether a receipt read back is honestly
 * labelled as verifiable.
 *
 * The DB layer is mocked (its SQL is pinned in tests/db/pending-writes-commit.test.ts),
 * so these tests are hermetic — no DATABASE_URL, no Supabase.
 */
const db = vi.hoisted(() => ({
  listPendingWrites: vi.fn(),
  listDecidedWrites: vi.fn(),
  getPendingWrite: vi.fn(),
  getReceipt: vi.fn(),
  commitWithReceipt: vi.fn(),
  rejectPendingWrite: vi.fn(),
}))

vi.mock('../../src/db/pending-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pending-writes')>()
  return { ...actual, ...db }
})

import { UnsupportedCommitError, type PendingWrite } from '../../src/db/pending-writes'
import { computeActionHash, signReceipt } from '../../src/governance/receipt'
import { createApprovalRouter } from '../../src/api/approvals'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const APPROVER = '660e8400-e29b-41d4-a716-446655440009'
const DRAFT_ID = '770e8400-e29b-41d4-a716-446655440003'
const RECORD_ID = '880e8400-e29b-41d4-a716-446655440004'
const RUN_ID = 'run-live-1'

/** dev-mode identity: all three headers, because `resolveIdentity` has no defaults. */
const AUTH = {
  'x-tenant-id': TENANT,
  'x-user-id': APPROVER,
  'x-user-role': 'admin',
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString()
const PAST = new Date(Date.now() - 1_000).toISOString()

/**
 * `Response.json()` is `unknown` under this tsconfig, and `app.request()` is
 * typed as possibly-sync. One helper absorbs both, so each test names the fields
 * it actually reads instead of casting inline.
 */
async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

/** POST bodies always carry the identity headers and a JSON content type. */
function post(body: unknown): { method: string; headers: Record<string, string>; body: string } {
  return { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

interface ErrorBody {
  error?: string
  reason?: string
  detail?: string
}

interface Suspension {
  run_id: string
  thread_id?: string | null
  tool_call_ids: string[]
}

interface QueueRow {
  id: string
  object_type: string
  operation: string
  risk_score: number
  action_hash: string
  run_id: string
  expires_at: string
  suspension: Suspension | null
  /** Deliberately never returned; asserted absent. */
  tenant_id?: string
}

interface SuspendedRunRow {
  run_id: string
  thread_id?: string | null
  suspended_at?: string | null
}

function draft(over: Partial<PendingWrite> = {}): PendingWrite {
  return {
    id: DRAFT_ID,
    tenantId: TENANT,
    runId: 'pending',
    threadId: null,
    objectType: 'contact',
    operation: 'create',
    targetId: null,
    payload: { customerId: RECORD_ID, name: 'Dana' },
    riskScore: 60,
    gate: 'approval',
    draftHash: 'hash-1',
    receiptId: null,
    rejectedAt: null,
    rejectionReason: null,
    committedAt: null,
    committedRecordId: null,
    requestedBy: APPROVER,
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  }
}

/**
 * A stand-in for crmAssistant exposing only what these routes call. Structural,
 * exactly like the router's own view of the agent.
 */
interface FakeAgent {
  listSuspendedRuns: ReturnType<typeof vi.fn>
  approveToolCallGenerate: ReturnType<typeof vi.fn>
  declineToolCallGenerate: ReturnType<typeof vi.fn>
}

function fakeAgent(): FakeAgent {
  return {
    listSuspendedRuns: vi.fn().mockResolvedValue({
      runs: [
        {
          runId: RUN_ID,
          status: 'suspended',
          threadId: 'thread-1',
          resourceId: TENANT,
          suspendedAt: new Date(PAST),
          toolCalls: [{ toolName: 'crm.create_contact' }],
        },
      ],
      total: 1,
    }),
    approveToolCallGenerate: vi.fn().mockResolvedValue({ text: 'Contact created.', finishReason: 'stop' }),
    declineToolCallGenerate: vi.fn().mockResolvedValue({ text: 'Okay, I left it alone.', finishReason: 'stop' }),
  }
}

function router(getAgent?: () => FakeAgent): Hono {
  return createApprovalRouter({ env: parseEnv({}), ...(getAgent ? { getAgent } : {}) })
}

beforeAll(() => {
  process.env.APPROVAL_HMAC_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!'
})

beforeEach(() => {
  vi.clearAllMocks()
  db.listPendingWrites.mockResolvedValue([])
  db.getPendingWrite.mockResolvedValue(null)
  db.getReceipt.mockResolvedValue(null)
  db.commitWithReceipt.mockResolvedValue({ committedId: RECORD_ID, receiptId: 'receipt-1' })
  db.rejectPendingWrite.mockResolvedValue('receipt-2')
})

describe('identity gate', () => {
  it('refuses a bare x-tenant-id header instead of trusting it', async () => {
    const res = await router().request('/api/approvals/pending', {
      headers: { 'x-tenant-id': TENANT },
    })

    expect(res.status).toBe(401)
    /**
     * `invalid-claim`, not the `missing-claim` the reason vocabulary suggests:
     * zod 4.6.7 reports an absent enum as `invalid_value`, while
     * `validateContext` only classifies `invalid_type` as missing, so a missing
     * `x-user-role` is always labelled invalid. Both are a fail-closed 401, so
     * nothing about the authorisation decision changes — only the reported reason.
     * Pinned here rather than smoothed over; see src/mastra/identity.ts.
     */
    expect((await json<ErrorBody>(res)).reason).toBe('invalid-claim')
    // Nothing was read, so a forged header cannot even enumerate a queue.
    expect(db.listPendingWrites).not.toHaveBeenCalled()
  })

  it('accepts a complete dev identity and queries as that tenant', async () => {
    db.listPendingWrites.mockResolvedValue([draft()])

    const res = await router().request('/api/approvals/pending', { headers: AUTH })

    expect(res.status).toBe(200)
    expect(db.listPendingWrites).toHaveBeenCalledWith(TENANT)
  })
})

describe('GET /api/approvals/pending', () => {
  it('serves the queue in column names with the fields the console needs', async () => {
    db.listPendingWrites.mockResolvedValue([draft()])

    const body = await json<{ items: QueueRow[]; total: number }>(
      router().request('/api/approvals/pending', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({
      id: DRAFT_ID,
      object_type: 'contact',
      operation: 'create',
      risk_score: 60,
      action_hash: 'hash-1',
      run_id: 'pending',
      expires_at: FUTURE,
    })
    // The tenant is never echoed back; it is the caller's, already proven.
    expect(body.items[0]!.tenant_id).toBeUndefined()
  })

  /**
   * The honesty case for the §11.3 two-source join. Approval tools cannot see
   * their own agent runId, so they stage `run_id = 'pending'`; matching that
   * sentinel against a live suspended run would tag every draft with the same run
   * and make the queue look more informed than it is.
   */
  it('does not invent a suspension for the run_id sentinel', async () => {
    db.listPendingWrites.mockResolvedValue([draft()])

    const body = await json<{ items: QueueRow[] }>(
      router(() => fakeAgent()).request('/api/approvals/pending', { headers: AUTH }),
    )

    expect(body.items[0]!.suspension).toBeNull()
  })

  it('joins the suspended run when a draft carries a real run id', async () => {
    db.listPendingWrites.mockResolvedValue([draft({ runId: RUN_ID })])

    const body = await json<{ items: QueueRow[] }>(
      router(() => fakeAgent()).request('/api/approvals/pending', { headers: AUTH }),
    )

    expect(body.items[0]!.suspension).toMatchObject({ run_id: RUN_ID, thread_id: 'thread-1' })
  })

  it('still answers when the agent cannot be reached', async () => {
    db.listPendingWrites.mockResolvedValue([draft({ runId: RUN_ID })])
    const agent = fakeAgent()
    agent.listSuspendedRuns.mockRejectedValue(new Error('storage down'))

    const body = await json<{ items: QueueRow[]; total: number }>(
      router(() => agent).request('/api/approvals/pending', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(body.items[0]!.suspension).toBeNull()
  })
})

describe('GET /api/approvals/resolved', () => {
  it('reads the decided half of the queue as the caller\'s tenant', async () => {
    db.listDecidedWrites.mockResolvedValue([draft({ receiptId: RECORD_ID, committedAt: FUTURE })])

    const res = await router().request('/api/approvals/resolved', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await json<{ items: QueueRow[]; total: number }>(res)
    expect(body.total).toBe(1)
    expect(db.listDecidedWrites).toHaveBeenCalledWith(TENANT, 50)
  })

  it('never claims a suspension for something already decided', async () => {
    db.listDecidedWrites.mockResolvedValue([draft({ runId: RUN_ID, receiptId: RECORD_ID })])

    const res = await router(() => fakeAgent()).request('/api/approvals/resolved', { headers: AUTH })
    const body = await json<{ items: QueueRow[] }>(res)
    // A decided draft is no longer a live pause, so the join column stays null
    // even when the run id looks matchable.
    expect(body.items[0]!.suspension).toBeNull()
  })

  it('refuses a window larger than the cap instead of scanning the table', async () => {
    const res = await router().request('/api/approvals/resolved?limit=500', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.listDecidedWrites).not.toHaveBeenCalled()
  })
})

describe('GET /api/approvals/suspended-runs', () => {
  it('says it cannot look rather than reporting an empty queue', async () => {
    const res = await router().request('/api/approvals/suspended-runs', { headers: AUTH })

    expect(res.status).toBe(503)
    expect((await json<ErrorBody>(res)).error).toBe('agent-not-wired')
  })

  it('proxies the filter and the page', async () => {
    const agent = fakeAgent()

    const body = await json<{ items: SuspendedRunRow[]; total: number }>(
      router(() => agent).request('/api/approvals/suspended-runs?threadId=thread-1', { headers: AUTH }),
    )

    expect(agent.listSuspendedRuns).toHaveBeenCalledWith({ threadId: 'thread-1', page: 1, perPage: 50 })
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ run_id: RUN_ID, thread_id: 'thread-1', suspended_at: PAST })
  })

  it('rejects a page size above the cap', async () => {
    const res = await router(() => fakeAgent()).request('/api/approvals/suspended-runs?perPage=500', { headers: AUTH })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/approvals/drafts/:id/decision', () => {
  it('commits the draft it read from the database, as the caller', async () => {
    const d = draft()
    db.getPendingWrite.mockResolvedValue(d)

    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(201)
    expect(await json<Record<string, unknown>>(res)).toEqual({
      status: 'approved',
      pending_write_id: DRAFT_ID,
      receipt_id: 'receipt-1',
      committed_record_id: RECORD_ID,
    })
    // The approver named on the receipt is the verified identity, never a body field.
    expect(db.commitWithReceipt).toHaveBeenCalledWith(d, { approvedBy: APPROVER, scope: 'crm:write' })
    expect(db.getPendingWrite).toHaveBeenCalledWith(DRAFT_ID, TENANT)
  })

  it('404s another tenant draft without distinguishing it from a missing one', async () => {
    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(404)
    expect(db.commitWithReceipt).not.toHaveBeenCalled()
  })

  it('409s a draft that already has a receipt', async () => {
    db.getPendingWrite.mockResolvedValue(draft({ receiptId: 'old-receipt' }))

    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(409)
    expect((await json<ErrorBody>(res)).error).toBe('already_decided')
  })

  it('409s an auto draft that was already applied', async () => {
    db.getPendingWrite.mockResolvedValue(draft({ committedAt: PAST }))

    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(409)
  })

  /**
   * 410 rather than 409: the window closing is a different fact from a decision
   * having been made, and §12.3 keeps the two lifetimes apart on purpose.
   */
  it('410s an expired approval window', async () => {
    db.getPendingWrite.mockResolvedValue(draft({ expiresAt: PAST }))

    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(410)
    expect((await json<ErrorBody>(res)).error).toBe('expired')
  })

  /**
   * The 422 is the point: `mail.send` is staged but not deliverable, so approving
   * it would sign a receipt for an email nobody sent. That is reported as the
   * caller's problem to resolve, not as a server fault.
   */
  it('422s a draft this build cannot commit', async () => {
    db.getPendingWrite.mockResolvedValue(draft({ objectType: 'email' }))
    db.commitWithReceipt.mockRejectedValue(new UnsupportedCommitError('mail.send is staged but not deliverable'))

    const res = await router().request(`/api/approvals/drafts/${DRAFT_ID}/decision`, post({ approved: true }))

    expect(res.status).toBe(422)
    expect((await json<ErrorBody>(res)).error).toBe('not_committable')
  })

  it('records a rejection with the caller as the decider', async () => {
    db.getPendingWrite.mockResolvedValue(draft())

    const res = await router().request(
      `/api/approvals/drafts/${DRAFT_ID}/decision`,
      post({ approved: false, reason: 'Wrong company' }),
    )

    expect(res.status).toBe(201)
    expect(db.rejectPendingWrite).toHaveBeenCalledWith(DRAFT_ID, TENANT, 'pending', APPROVER, 'Wrong company')
    expect(db.commitWithReceipt).not.toHaveBeenCalled()
  })

  it('refuses a body without a boolean decision', async () => {
    const res = await router().request(
      `/api/approvals/drafts/${DRAFT_ID}/decision`,
      post({ reason: 'just a vibe' }),
    )
    expect(res.status).toBe(400)
  })

  it('does not treat the route as a run id when the draft path is misspelled', async () => {
    // Guards the ordering of `/drafts/:id/decision` against `/:runId/decision`:
    // a two-segment path is a run decision and must 503 rather than touch a draft.
    const res = await router().request('/api/approvals/drafts/decision', post({ approved: true }))

    expect(res.status).toBe(503)
    expect(db.commitWithReceipt).not.toHaveBeenCalled()
  })
})

describe('POST /api/approvals/:runId/decision', () => {
  it('resumes the native gate and returns the resumed text', async () => {
    const agent = fakeAgent()

    const res = await router(() => agent).request(
      `/api/approvals/${RUN_ID}/decision`,
      post({ approved: true, toolCallId: 'tc-1' }),
    )

    expect(res.status).toBe(200)
    expect(agent.approveToolCallGenerate).toHaveBeenCalledWith({ runId: RUN_ID, toolCallId: 'tc-1' })
    expect(await json<Record<string, unknown>>(res)).toMatchObject({
      approved: true,
      text: 'Contact created.',
      still_suspended: false,
    })
  })

  it('flags a turn that suspends again instead of reporting completion', async () => {
    const agent = fakeAgent()
    agent.approveToolCallGenerate.mockResolvedValue({ text: '', finishReason: 'suspended' })

    const body = await json<Record<string, unknown>>(
      router(() => agent).request(`/api/approvals/${RUN_ID}/decision`, post({ approved: true })),
    )

    expect(body.still_suspended).toBe(true)
  })

  it('carries the decline reason to the framework', async () => {
    const agent = fakeAgent()

    await router(() => agent).request(
      `/api/approvals/${RUN_ID}/decision`,
      post({ approved: false, toolCallId: 'tc-1', reason: 'Not this quarter' }),
    )

    expect(agent.declineToolCallGenerate).toHaveBeenCalledWith({
      runId: RUN_ID,
      toolCallId: 'tc-1',
      reason: 'Not this quarter',
    })
  })

  it('503s when the agent is not wired, rather than pretending to approve', async () => {
    const res = await router().request(
      `/api/approvals/${RUN_ID}/decision`,
      post({ approved: true, toolCallId: 'tc-1' }),
    )

    expect(res.status).toBe(503)
    expect((await json<ErrorBody>(res)).error).toBe('agent-not-wired')
  })
})

describe('GET /api/approvals/receipts/:id', () => {
  /** Rebuilds a receipt the way the commit layer signs one, so verification has something true to check. */
  function approvedReceipt(over: Record<string, unknown> = {}) {
    const payload = { customerId: RECORD_ID, name: 'Dana' }
    return {
      id: 'receipt-1',
      tenantId: TENANT,
      pendingWriteId: DRAFT_ID,
      runId: 'pending',
      scope: 'crm:write',
      approvedBy: APPROVER,
      decision: 'approved',
      committedRecordId: RECORD_ID,
      reason: null,
      createdAt: PAST,
      payload,
      signature: signReceipt({
        pendingWriteId: DRAFT_ID,
        runId: 'pending',
        scope: 'crm:write',
        actionHash: computeActionHash(payload),
        approvedBy: APPROVER,
      }),
      ...over,
    }
  }

  interface ReceiptBody {
    signature_valid: boolean | null
    verification: string
    receipt: { scope: string }
  }

  it('verifies a genuine signature over the stored scope', async () => {
    db.getReceipt.mockResolvedValue(approvedReceipt())

    const body = await json<ReceiptBody>(
      router().request('/api/approvals/receipts/receipt-1', { headers: AUTH }),
    )

    expect(body.signature_valid).toBe(true)
    expect(body.verification).toBe('valid')
    expect(body.receipt.scope).toBe('crm:write')
    expect(db.getReceipt).toHaveBeenCalledWith('receipt-1', TENANT)
  })

  it('calls a tampered payload tampered', async () => {
    db.getReceipt.mockResolvedValue(approvedReceipt({ payload: { customerId: RECORD_ID, name: 'Someone Else' } }))

    const body = await json<ReceiptBody>(
      router().request('/api/approvals/receipts/receipt-1', { headers: AUTH }),
    )

    expect(body.signature_valid).toBe(false)
    expect(body.verification).toBe('invalid')
  })

  /**
   * A rejection is signed over `{rejected, draftId}`, not the draft payload, so
   * verifying it the way an approval is verified would report every genuine
   * rejection as forged.
   */
  it('verifies a rejection against the envelope it was actually signed over', async () => {
    db.getReceipt.mockResolvedValue(
      approvedReceipt({
        decision: 'rejected',
        reason: 'Wrong company',
        committedRecordId: null,
        payload: null,
        signature: signReceipt({
          pendingWriteId: DRAFT_ID,
          runId: 'pending',
          scope: 'crm:write',
          actionHash: computeActionHash({ rejected: true, draftId: DRAFT_ID }),
          approvedBy: APPROVER,
        }),
      }),
    )

    const body = await json<ReceiptBody>(
      router().request('/api/approvals/receipts/receipt-1', { headers: AUTH }),
    )

    expect(body.signature_valid).toBe(true)
  })

  /**
   * The regression migration 0008 exists for: with no stored scope the route would
   * have to guess one, and a wrong guess flags a perfectly good receipt as invalid.
   */
  it('does not guess the scope when the row carries a different one', async () => {
    db.getReceipt.mockResolvedValue(approvedReceipt({ scope: 'other:scope' }))

    const body = await json<ReceiptBody>(
      router().request('/api/approvals/receipts/receipt-1', { headers: AUTH }),
    )

    expect(body.signature_valid).toBe(false)
    expect(body.verification).toBe('invalid')
  })

  it('404s a receipt belonging to another tenant', async () => {
    const res = await router().request('/api/approvals/receipts/receipt-1', { headers: AUTH })
    expect(res.status).toBe(404)
  })
})

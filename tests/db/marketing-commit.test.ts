import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWrite } from '../../src/db/pending-writes'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  connect: vi.fn(() => Promise.resolve(mockClient)),
  end: vi.fn(),
}

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
    // commitWithReceipt signs the receipt, and signReceipt refuses to run
    // without this. Without it the two happy-path commits below throw at the
    // signature, before they ever reach the audit insert or the pending_writes
    // update, so the assertions would test nothing.
    APPROVAL_HMAC_SECRET: 'test-secret',
  }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

function stubQueries(handlers: Record<string, Record<string, unknown>[]>) {
  mockQuery.mockImplementation((sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return Promise.resolve({ rows: [] })
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function stageDraft(payload: Record<string, unknown>): PendingWrite {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT,
    runId: 'pending',
    threadId: null,
    objectType: 'marketing_stage',
    operation: 'update',
    targetId: BUNDLE,
    payload,
    riskScore: 10,
    gate: 'approval',
    draftHash: 'stage-key',
    receiptId: null,
    rejectedAt: null,
    rejectionReason: null,
    committedAt: null,
    committedRecordId: null,
    requestedBy: APPROVER,
    createdAt: '2026-10-30T00:00:00.000Z',
    expiresAt: '2026-10-30T01:00:00.000Z',
  }
}

// No auditRow helper here: all three tests stub 'INSERT INTO audit_receipts' by
// SQL fragment, so a full receipt row is never constructed, and an unused helper
// function is an `@typescript-eslint/no-unused-vars` error (eslint.config.js:47).

beforeEach(() => {
  mockQuery.mockReset()
})

describe('approving a marketing stage draft', () => {
  it('refuses a bundle whose plan asks for an unadapted action, and signs nothing', async () => {
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
      'FROM marketing_bundles': [
        { id: BUNDLE, status: 'staged', objective: 'inbound_leads', funnel_plan: { page: { slug: '/free-scan' } }, media_plan: null },
      ],
    })
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    await expect(
      commitWithReceipt(stageDraft({ bundleId: BUNDLE }), { approvedBy: APPROVER, scope: 'crm:write' }),
    ).rejects.toThrow(UnsupportedCommitError)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO audit_receipts'))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('ROLLBACK'))).toBe(true)
  })

  it('approves a content-only bundle and writes the receipt against the bundle id', async () => {
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
      'FROM marketing_bundles': [
        { id: BUNDLE, status: 'staged', objective: 'outreach_support', funnel_plan: null, media_plan: null },
      ],
      "UPDATE marketing_bundles SET status = 'approved'": [{ id: BUNDLE }],
      'INSERT INTO audit_receipts': [{ id: 'receipt-1' }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const { commitWithReceipt } = await import('../../src/db/pending-writes')
    const result = await commitWithReceipt(stageDraft({ bundleId: BUNDLE }), {
      approvedBy: APPROVER,
      scope: 'crm:write',
    })
    expect(result.committedId).toBe(BUNDLE)
    expect(result.receiptId).toBe('receipt-1')
  })

  it('passes a null receipt id to the outbox, because the receipt does not exist yet', async () => {
    // A content-only bundle derives no actions, so its receiptId is never
    // observable. To see the value the branch actually passes, the bundle must
    // ask for an action and an adapter must exist, or commitBundleApproval
    // refuses before it reaches the INSERT.
    const { registerActionAdapter } = await import('../../src/marketing/outbox')
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'unused' }),
    })
    try {
      stubQueries({
        'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
        'FROM marketing_bundles': [
          { id: BUNDLE, status: 'staged', objective: 'inbound_leads', funnel_plan: { page: { slug: '/free-scan' } }, media_plan: null },
        ],
        "UPDATE marketing_bundles SET status = 'approved'": [{ id: BUNDLE }],
        'INSERT INTO marketing_actions': [{ id: 'action-1' }],
        'INSERT INTO audit_receipts': [{ id: 'receipt-1' }],
        'UPDATE pending_writes SET receipt_id': [],
      })
      const { commitWithReceipt } = await import('../../src/db/pending-writes')
      await commitWithReceipt(stageDraft({ bundleId: BUNDLE }), {
        approvedBy: APPROVER,
        scope: 'crm:write',
      })
      const enqueue = mockQuery.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO marketing_actions'))
      expect(enqueue).toBeDefined()
      // ['queued', receipt_id] is the tail. The last param is the receipt id the
      // branch hands over, and it must be null: commitWithReceipt signs its
      // receipt only after applyDraft returns, so no real id exists to write.
      expect(enqueue?.[1]).toEqual([TENANT, BUNDLE, 'publish_page', JSON.stringify({ slug: '/free-scan' }), null])
    } finally {
      unregister()
    }
  })
})

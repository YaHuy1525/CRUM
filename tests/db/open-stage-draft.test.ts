// tests/db/open-stage-draft.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'

function draftRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DRAFT,
    tenant_id: TENANT,
    run_id: 'pending',
    thread_id: null,
    object_type: 'marketing_stage',
    operation: 'update',
    target_id: BUNDLE,
    payload: {},
    risk_score: 10,
    gate: 'approval',
    draft_hash: 'hash',
    receipt_id: null,
    rejected_at: null,
    rejection_reason: null,
    committed_at: null,
    committed_record_id: null,
    requested_by: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-02T00:00:00.000Z',
    ...over,
  }
}

async function load() {
  return await import('../../src/db/pending-writes')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('getOpenStageDraft', () => {
  it('asks for the five conditions spec section 4.3 names, scoped to this tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [draftRow()] })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft?.id).toBe(DRAFT)
    const sql = String((mockQuery.mock.calls as unknown[][])[0]![0])
    const params = (mockQuery.mock.calls as unknown[][])[0]![1] as unknown[]
    expect(sql).toContain("object_type = 'marketing_stage'")
    expect(sql).toContain('target_id = $1')
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('receipt_id IS NULL')
    expect(sql).toContain('rejected_at IS NULL')
    expect(sql).toContain('expires_at > now()')
    expect(sql).toContain('ORDER BY created_at DESC')
    expect(params).toEqual([BUNDLE, TENANT])
  })

  it('maps the row through the module\'s own PendingWrite shape', async () => {
    mockQuery.mockResolvedValue({ rows: [draftRow()] })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft).toMatchObject({
      tenantId: TENANT,
      objectType: 'marketing_stage',
      targetId: BUNDLE,
      gate: 'approval',
      receiptId: null,
    })
  })

  it('returns null rather than an empty object when nothing is open', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getOpenStageDraft } = await load()
    expect(await getOpenStageDraft(TENANT, BUNDLE)).toBeNull()
  })

  it('does not widen to promote, retry or campaign-status drafts', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getOpenStageDraft } = await load()
    await getOpenStageDraft(TENANT, BUNDLE)
    const sql = String((mockQuery.mock.calls as unknown[][])[0]![0])
    for (const other of ['marketing_promote', 'marketing_retry', 'marketing_set_campaign_status']) {
      expect(sql).not.toContain(other)
    }
    // One draft, newest first: `LIMIT 1` is what stops a re-staged bundle making
    // the caller guess which row the predicate meant.
    expect(sql).toContain('LIMIT 1')
  })
})

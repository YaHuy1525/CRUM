// tests/db/open-stage-draft.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }

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

  it('normalises the three timestamps the driver actually returns as Dates', async () => {
    // A `timestamptz` column arrives as a `Date`, and the mapper used to write
    // `row.created_at as string` over it. That pair only agrees by accident, so
    // this row is the driver's real shape rather than the builder's default.
    mockQuery.mockResolvedValue({
      rows: [
        draftRow({
          rejected_at: new Date('2026-11-01T12:00:00.000Z'),
          created_at: new Date('2026-11-01T00:00:00.000Z'),
          expires_at: new Date('2026-11-02T00:00:00.000Z'),
        }),
      ],
    })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft?.rejectedAt).toBe('2026-11-01T12:00:00.000Z')
    expect(draft?.createdAt).toBe('2026-11-01T00:00:00.000Z')
    expect(draft?.expiresAt).toBe('2026-11-02T00:00:00.000Z')
  })

  it('keeps a null rejected_at null rather than the string "null"', async () => {
    // The one nullable column in this set is null for the row the gate cares
    // about, which is also the row's whole meaning: an un-rejected approval.
    mockQuery.mockResolvedValue({ rows: [draftRow()] })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft?.rejectedAt).toBeNull()
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

describe('invalidateOpenStageDraft', () => {
  it('rejects the open stage draft for this bundle and nothing else', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).includes('UPDATE pending_writes') ? [{ id: DRAFT }] : [], rowCount: 1 }),
    )
    const { invalidateOpenStageDraft } = await load()
    expect(await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')).toBe(DRAFT)

    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE pending_writes'))![0])
    expect(sql).toContain("object_type = 'marketing_stage'")
    expect(sql).toContain('target_id = $2')
    // The two nulls are the whole definition of an open draft, the same ones
    // getOpenStageDraft reads (`:782-785`). A committed approval has a receipt and
    // a refused one already has a reason: neither is this function's to overwrite.
    expect(sql).toContain('receipt_id IS NULL')
    expect(sql).toContain('rejected_at IS NULL')
    expect(sql).toContain('RETURNING id')
    const params = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE pending_writes'))![1] as unknown[]
    expect(params).toEqual([TENANT, BUNDLE, 'assets_changed_after_staging'])
  })

  it('returns the bundle to draft, and only from staged', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: DRAFT }], rowCount: 1 })
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')
    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE marketing_bundles'))![0])
    // `staged` means an approval is waiting. An `approved` or `live` bundle is not
    // walked backwards: its bytes are already published, and the drain-time
    // `site_hash_moved` refusal in page-host.ts is what guards that path.
    expect(sql).toContain("status = 'staged'")
  })

  it('is idempotent: a second invalidation finds no open draft and reports null', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve(String(sql).includes('UPDATE pending_writes') && mockQuery.mock.calls.length === 1
        ? { rows: [{ id: DRAFT }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
    )
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')).toBeNull()
  })

  it('opens and closes one transaction, and rolls back on a failed write', async () => {
    const release = vi.fn()
    mockClient.release = release
    mockQuery.mockResolvedValue({ rows: [{ id: DRAFT }], rowCount: 1 })
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'reason')
    const verbs = mockQuery.mock.calls.map((c) => String(c[0]).trim())
    expect(verbs[0]).toBe('BEGIN')
    expect(verbs).toContain('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)

    mockQuery.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockRejectedValueOnce(new Error('boom'))
    await expect(invalidateOpenStageDraft(TENANT, BUNDLE, 'reason')).rejects.toThrow('boom')
    expect(mockQuery.mock.calls.map((c) => String(c[0]).trim())).toContain('ROLLBACK')
  })
})

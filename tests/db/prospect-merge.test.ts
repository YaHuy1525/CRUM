import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  // commitWithReceipt opens a transaction client; mergeProspects called with a
  // plain query object stays on whatever transaction the caller already holds.
  connect: vi.fn(() => Promise.resolve(mockClient)),
  end: vi.fn(),
}

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
    // commitWithReceipt signs the receipt, and signReceipt refuses to run without it.
    APPROVAL_HMAC_SECRET: 'test-secret',
  }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '11111111-1111-4111-8111-11111111111f'
const SURVIVOR = '22222222-2222-4222-8222-222222222222'
const DUPLICATE = '33333333-3333-4333-8333-333333333333'
const CANDIDATE = '44444444-4444-4444-8444-444444444444'
const RECEIPT = '55555555-5555-4555-8555-555555555555'

type Row = Record<string, unknown>

function stubQueries(handlers: Record<string, Row[]>): void {
  mockQuery.mockImplementation((sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return Promise.resolve({ rows: [] })
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

function queryCall(fragment: string): { sql: string; params: unknown[] } {
  const found = calls(fragment)[0]
  if (!found) throw new Error(`no query containing "${fragment}" was issued`)
  return found
}

/** Position of the first statement containing `fragment`, for ordering claims. */
function stepIndex(fragment: string): number {
  return (mockQuery.mock.calls as unknown[][]).findIndex((call) =>
    (call[0] as string).includes(fragment),
  )
}

/** The merge reaches the database through a client, not through a pool. */
function mergeClient(): { query: typeof mockQuery } {
  return { query: mockQuery }
}

const MERGE_HANDLERS: Record<string, Row[]> = {
  'SELECT id FROM prospects WHERE tenant_id': [{ id: SURVIVOR }, { id: DUPLICATE }],
  'UPDATE prospect_channels c': [],
  'UPDATE outreach_drafts d': [],
  'UPDATE outreach_threads t': [],
  'DELETE FROM prospect_channels': [],
  'DELETE FROM outreach_drafts d': [],
  'UPDATE outreach_drafts SET prospect_id': [],
  'UPDATE outreach_threads SET prospect_id': [],
  'UPDATE prospect_snapshots': [],
  'DELETE FROM prospect_consents s': [],
  'DELETE FROM prospect_consents d': [],
  'UPDATE prospect_consents': [],
  'UPDATE prospect_merge_candidates': [],
  'DELETE FROM prospects': [{ id: DUPLICATE }],
}

async function runMerge(): Promise<string> {
  const { mergeProspects } = await import('../../src/db/prospect-merge')
  return mergeProspects(mergeClient(), {
    tenantId: TENANT,
    survivorId: SURVIVOR,
    duplicateId: DUPLICATE,
  })
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockClient.release.mockReset()
})

describe('mergeProspects', () => {
  it('repoints channels onto the survivor and drops handles the survivor already holds', async () => {
    stubQueries(MERGE_HANDLERS)

    await expect(runMerge()).resolves.toBe(SURVIVOR)

    const repoint = queryCall('UPDATE prospect_channels c')
    expect(repoint.params).toEqual([TENANT, SURVIVOR, DUPLICATE])
    // The conflict test is what keeps the (tenant, platform, handle) unique
    // constraint from aborting the merge when the two prospects share a handle.
    expect(repoint.sql).toContain('NOT EXISTS')
    expect(repoint.sql).toContain('s.platform = c.platform')
    expect(repoint.sql).toContain('s.handle_normalized = c.handle_normalized')

    const drop = queryCall('DELETE FROM prospect_channels')
    expect(drop.params).toEqual([TENANT, DUPLICATE])

    // Skipped channels are removed, but only after any draft or thread sitting
    // on them has been moved to the survivor's equivalent channel.
    expect(stepIndex('UPDATE prospect_channels c')).toBeLessThan(
      stepIndex('UPDATE outreach_drafts d'),
    )
    expect(stepIndex('UPDATE outreach_drafts d')).toBeLessThan(
      stepIndex('DELETE FROM prospect_channels'),
    )
    expect(stepIndex('UPDATE outreach_threads t')).toBeLessThan(
      stepIndex('DELETE FROM prospect_channels'),
    )
  })

  it('keeps the survivor consent when both prospects have one', async () => {
    stubQueries(MERGE_HANDLERS)

    await runMerge()

    // Only an older duplicate row displaces the survivor's consent; on a tie the
    // survivor's row stays, which is what the strict `<` pins.
    const dropSurvivor = queryCall('DELETE FROM prospect_consents s')
    expect(dropSurvivor.sql).toContain('d.recorded_at < s.recorded_at')
    expect(dropSurvivor.params).toEqual([TENANT, SURVIVOR, DUPLICATE])

    // Once a survivor row remains, the duplicate's row is what goes, so the
    // primary key on prospect_id is never violated by the move below.
    const dropDuplicate = queryCall('DELETE FROM prospect_consents d')
    expect(dropDuplicate.sql).toContain('s.prospect_id = $3')
    expect(dropDuplicate.params).toEqual([TENANT, DUPLICATE, SURVIVOR])

    const move = queryCall('UPDATE prospect_consents')
    expect(move.sql).toContain('SET prospect_id = $2')
    expect(move.params).toEqual([TENANT, SURVIVOR, DUPLICATE])

    expect(stepIndex('DELETE FROM prospect_consents s')).toBeLessThan(
      stepIndex('DELETE FROM prospect_consents d'),
    )
    expect(stepIndex('DELETE FROM prospect_consents d')).toBeLessThan(
      stepIndex('UPDATE prospect_consents'),
    )
  })

  it('marks every pending candidate that references either prospect as merged', async () => {
    stubQueries(MERGE_HANDLERS)

    await runMerge()

    const mark = queryCall('UPDATE prospect_merge_candidates')
    expect(mark.sql).toContain("SET status = 'merged'")
    expect(mark.sql).toContain("status = 'pending'")
    // A chain A~B, B~C must not offer B again after B was folded into A, so the
    // predicate covers both columns, not just the resolved pair.
    expect(mark.sql).toContain('left_prospect_id IN ($2, $3)')
    expect(mark.sql).toContain('right_prospect_id IN ($2, $3)')
    expect(mark.params).toEqual([TENANT, SURVIVOR, DUPLICATE])

    // Marking comes before the delete: rows naming the duplicate disappear with
    // the cascade, and the ones naming the survivor stay behind marked merged.
    expect(stepIndex('UPDATE prospect_merge_candidates')).toBeLessThan(
      stepIndex('DELETE FROM prospects'),
    )
  })

  it('refuses when the survivor and the duplicate are the same prospect', async () => {
    stubQueries(MERGE_HANDLERS)
    const { mergeProspects } = await import('../../src/db/prospect-merge')

    await expect(
      mergeProspects(mergeClient(), {
        tenantId: TENANT,
        survivorId: SURVIVOR,
        duplicateId: SURVIVOR,
      }),
    ).rejects.toThrow('survivor_and_duplicate')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('refuses a prospect that belongs to another tenant', async () => {
    stubQueries({
      ...MERGE_HANDLERS,
      'SELECT id FROM prospects WHERE tenant_id': [{ id: SURVIVOR }],
    })

    await expect(runMerge()).rejects.toThrow('not_found')

    const verify = queryCall('SELECT id FROM prospects WHERE tenant_id')
    expect(verify.sql).toContain('tenant_id = $1')
    expect(verify.params).toEqual([TENANT, SURVIVOR, DUPLICATE])
    expect(calls('DELETE FROM prospects')).toHaveLength(0)
  })
})

describe('listMergeCandidates', () => {
  const ROW = {
    id: CANDIDATE,
    reason: 'substring',
    similarity: '0.667',
    left_id: SURVIVOR,
    left_name: 'Tradie Coach',
    left_country: 'AU',
    left_score: '71.50',
    right_id: DUPLICATE,
    right_name: 'Tradie Coach (Paul Rogers)',
    right_country: 'AU',
    right_score: null,
  }

  it('returns both sides with names, countries, scores, reason and similarity', async () => {
    mockQuery.mockResolvedValue({ rows: [ROW] })
    const { listMergeCandidates } = await import('../../src/db/prospect-merge')

    const candidates = await listMergeCandidates(TENANT)

    expect(candidates).toEqual([
      {
        id: CANDIDATE,
        reason: 'substring',
        similarity: 0.667,
        left: { id: SURVIVOR, name: 'Tradie Coach', country: 'AU', score: 71.5 },
        right: {
          id: DUPLICATE,
          name: 'Tradie Coach (Paul Rogers)',
          country: 'AU',
          score: null,
        },
      },
    ])
  })

  it('scopes the candidate and both prospect joins to the tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listMergeCandidates } = await import('../../src/db/prospect-merge')

    await listMergeCandidates(OTHER_TENANT)

    const { sql, params } = queryCall('FROM prospect_merge_candidates')
    expect(sql).toContain('m.tenant_id = $1')
    expect(sql).toContain("m.status = 'pending'")
    expect(sql).toContain('l.tenant_id = m.tenant_id')
    expect(sql).toContain('r.tenant_id = m.tenant_id')
    expect(params).toEqual([OTHER_TENANT])
  })
})

describe('approval commit of a prospect_merge draft', () => {
  it('runs the merge inside the receipt transaction and reports the survivor', async () => {
    stubQueries({
      ...MERGE_HANDLERS,
      'SELECT receipt_id, rejected_at, committed_at': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      'INSERT INTO audit_receipts': [{ id: RECEIPT }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const { commitWithReceipt } = await import('../../src/db/pending-writes')

    const result = await commitWithReceipt(
      {
        id: '66666666-6666-4666-8666-666666666666',
        tenantId: TENANT,
        runId: 'pending',
        threadId: null,
        objectType: 'prospect_merge',
        operation: 'update',
        targetId: CANDIDATE,
        payload: { candidateId: CANDIDATE, survivorId: SURVIVOR, duplicateId: DUPLICATE },
        riskScore: 55,
        gate: 'approval',
        draftHash: 'merge:corr-1',
        receiptId: null,
        rejectedAt: null,
        rejectionReason: null,
        committedAt: null,
        committedRecordId: null,
        requestedBy: '77777777-7777-4777-8777-777777777777',
        createdAt: '2026-11-03T12:00:00.000Z',
        expiresAt: '2026-11-03T13:00:00.000Z',
      },
      { approvedBy: '77777777-7777-4777-8777-777777777777', scope: 'crm:write' },
    )

    expect(result).toEqual({ committedId: SURVIVOR, receiptId: RECEIPT })
    expect(stepIndex('BEGIN')).toBeLessThan(stepIndex('SELECT id FROM prospects WHERE tenant_id'))
    expect(stepIndex('DELETE FROM prospects')).toBeLessThan(
      stepIndex('INSERT INTO audit_receipts'),
    )
    expect(stepIndex('INSERT INTO audit_receipts')).toBeLessThan(stepIndex('COMMIT'))
    expect(mockClient.release).toHaveBeenCalled()
  })
})

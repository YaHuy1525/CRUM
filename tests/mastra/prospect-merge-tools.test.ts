import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const rc = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  userRole: 'admin' as const,
}

const CANDIDATE = '33333333-3333-4333-8333-333333333333'
const SURVIVOR = '44444444-4444-4444-8444-444444444444'
const DUPLICATE = '55555555-5555-4555-8555-555555555555'
const OTHER = '66666666-6666-4666-8666-666666666666'
const PENDING = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, unknown>

function stubQueries(handlers: Record<string, Row[]>): void {
  mockQuery.mockImplementation((sql: string) => {
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function queryCall(fragment: string): { sql: string; params: unknown[] } | undefined {
  for (const call of mockQuery.mock.calls as unknown[][]) {
    const sql = call[0] as string
    if (sql.includes(fragment)) return { sql, params: (call[1] ?? []) as unknown[] }
  }
  return undefined
}

function candidateRow(): Row {
  return {
    id: CANDIDATE,
    status: 'pending',
    left_prospect_id: SURVIVOR,
    right_prospect_id: DUPLICATE,
    left_name: 'Tradie Coach',
    right_name: 'Tradie Coach (Paul Rogers)',
    reason: 'substring',
    similarity: '0.667',
  }
}

type ExecuteFn = (input: Record<string, unknown>, context: unknown) => Promise<{
  status: string
  pendingWriteId: string | null
  survivorId: string
  duplicateId: string | null
  message: string
}>

function toolContext(): unknown {
  return {
    requestContext: { all: rc },
    observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
  }
}

async function runResolve(input: Record<string, unknown>): Promise<Awaited<ReturnType<ExecuteFn>>> {
  const { resolveMergeCandidateTool } = await import('../../src/mastra/tools/prospect-merge')
  const execute = resolveMergeCandidateTool.execute as unknown as ExecuteFn
  return execute(input, toolContext())
}

function resolution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { candidateId: CANDIDATE, survivorId: SURVIVOR, decision: 'dismiss', correlationId: 'corr-1', ...overrides }
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('crm.resolve_merge_candidate', () => {
  it('dismisses the candidate without staging a pending write', async () => {
    stubQueries({
      'FROM prospect_merge_candidates m': [candidateRow()],
      'UPDATE prospect_merge_candidates': [{ id: CANDIDATE }],
    })

    const result = await runResolve(resolution())

    expect(result.status).toBe('dismissed')
    expect(result.pendingWriteId).toBeNull()
    const update = queryCall('UPDATE prospect_merge_candidates')
    expect(update?.sql).toContain("SET status = 'dismissed'")
    expect(update?.params).toEqual([CANDIDATE, rc.tenantId])
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('stages a merge as a prospect_merge update keyed on the correlation id', async () => {
    stubQueries({
      'FROM prospect_merge_candidates m': [candidateRow()],
      'INSERT INTO pending_writes': [{ id: PENDING }],
    })

    const result = await runResolve(resolution({ decision: 'merge' }))

    expect(result.status).toBe('pending')
    expect(result.pendingWriteId).toBe(PENDING)
    expect(result.duplicateId).toBe(DUPLICATE)
    const insert = queryCall('INSERT INTO pending_writes')
    expect(insert?.params[3]).toBe('prospect_merge')
    expect(insert?.params[4]).toBe('update')
    expect(insert?.params[5]).toBe(CANDIDATE)
    expect(insert?.params[9]).toBe('merge:corr-1')
    // The same four keys the REST staging route writes, so one approval
    // handler serves both paths.
    expect(JSON.parse(insert?.params[6] as string)).toEqual({
      candidateId: CANDIDATE,
      survivorId: SURVIVOR,
      duplicateId: DUPLICATE,
      decision: 'merge',
    })
  })

  it('derives the duplicate when the survivor is the right-hand prospect', async () => {
    stubQueries({
      'FROM prospect_merge_candidates m': [candidateRow()],
      'INSERT INTO pending_writes': [{ id: PENDING }],
    })

    const result = await runResolve(resolution({ survivorId: DUPLICATE, decision: 'merge' }))

    expect(result.duplicateId).toBe(SURVIVOR)
    const insert = queryCall('INSERT INTO pending_writes')
    expect(JSON.parse(insert?.params[6] as string)).toEqual({
      candidateId: CANDIDATE,
      survivorId: DUPLICATE,
      duplicateId: SURVIVOR,
      decision: 'merge',
    })
  })

  it('refuses a candidate that is no longer pending', async () => {
    stubQueries({
      'FROM prospect_merge_candidates m': [{ ...candidateRow(), status: 'dismissed' }],
    })

    await expect(runResolve(resolution())).rejects.toThrow('candidate_not_pending')
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
    expect(queryCall('UPDATE prospect_merge_candidates')).toBeUndefined()
  })

  it('refuses a survivor that is not one of the candidate pair', async () => {
    stubQueries({ 'FROM prospect_merge_candidates m': [candidateRow()] })

    await expect(runResolve(resolution({ survivorId: OTHER, decision: 'merge' }))).rejects.toThrow(
      'survivor_not_in_candidate',
    )
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('replays a committed merge instead of staging it twice', async () => {
    stubQueries({
      // The merge deleted the duplicate, which cascaded this candidate away.
      'FROM prospect_merge_candidates m': [],
      'FROM pending_writes': [{ id: PENDING, committed_at: '2026-11-03T12:05:00.000Z' }],
    })

    const result = await runResolve(resolution({ decision: 'merge' }))

    expect(result.status).toBe('merged')
    expect(result.pendingWriteId).toBe(PENDING)
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a candidate that belongs to another tenant', async () => {
    stubQueries({
      'FROM prospect_merge_candidates m': [],
      'FROM pending_writes': [],
    })

    await expect(runResolve(resolution())).rejects.toThrow('candidate_not_found')
    const lookup = queryCall('FROM prospect_merge_candidates m')
    expect(lookup?.sql).toContain('m.tenant_id = $2')
    expect(lookup?.params).toEqual([CANDIDATE, rc.tenantId])
  })
})

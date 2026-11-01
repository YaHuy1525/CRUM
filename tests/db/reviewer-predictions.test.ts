// tests/db/reviewer-predictions.test.ts
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
const PREDICTION = '55555555-5555-4555-8555-555555555555'

function predictionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PREDICTION,
    tenant_id: TENANT,
    pending_write_id: DRAFT,
    predicted_outcome: 'about 6 booked calls a week',
    created_at: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/reviewer-predictions')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('insertPrediction', () => {
  it('writes the outcome text against the draft, not the bundle', async () => {
    mockQuery.mockResolvedValue({ rows: [predictionRow()] })
    const { insertPrediction } = await load()
    const result = await insertPrediction({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'about 6 booked calls a week',
    })
    expect(result.created).toBe(true)
    const [insert] = calls('INSERT INTO reviewer_predictions')
    expect(insert?.sql).toContain('ON CONFLICT (pending_write_id) DO NOTHING')
    expect(insert?.params).toEqual([TENANT, DRAFT, 'about 6 booked calls a week'])
    expect(result.prediction.pendingWriteId).toBe(DRAFT)
  })

  it('hands back the row that already exists when the insert loses the race', async () => {
    // Two reviewers, one draft: the second POST must report the first prediction
    // rather than a second one or an error a console cannot show.
    mockQuery.mockImplementation((sql: string) =>
      String(sql).includes('INSERT INTO reviewer_predictions')
        ? { rows: [] }
        : { rows: [predictionRow({ predicted_outcome: 'forty replies' })] },
    )
    const { insertPrediction } = await load()
    const result = await insertPrediction({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'mine',
    })
    expect(result.created).toBe(false)
    expect(result.prediction.predictedOutcome).toBe('forty replies')
    expect(calls('SELECT')[0]?.sql).toContain('pending_write_id = $2')
  })

  it('refuses an empty outcome before it opens a connection', async () => {
    const { insertPrediction } = await load()
    await expect(
      insertPrediction({ tenantId: TENANT, pendingWriteId: DRAFT, predictedOutcome: '   ' }),
    ).rejects.toThrow(/predicted_outcome/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('bundlePredictionGate', () => {
  it('is not required, and reports no prediction, when the bundle has no open stage draft', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { bundlePredictionGate } = await load()
    expect(await bundlePredictionGate(TENANT, BUNDLE)).toEqual({
      required: false,
      pendingWriteId: null,
      prediction: null,
    })
    // No second query: a bundle nobody has staged is not a decision waiting for
    // a prediction, and the screen must render as slices 1 to 3 made it.
    expect(calls('FROM reviewer_predictions')).toHaveLength(0)
  })

  it('is required with the draft id and a null prediction when the draft is open and nobody has typed yet', async () => {
    mockQuery.mockImplementation((sql: string) =>
      String(sql).includes('FROM pending_writes')
        ? { rows: [draftRowForGate()] }
        : { rows: [] },
    )
    const { bundlePredictionGate } = await load()
    const gate = await bundlePredictionGate(TENANT, BUNDLE)
    expect(gate).toEqual({ required: true, pendingWriteId: DRAFT, prediction: null })
  })

  it('is required with the prediction when one exists', async () => {
    mockQuery.mockImplementation((sql: string) =>
      String(sql).includes('FROM pending_writes')
        ? { rows: [draftRowForGate()] }
        : { rows: [predictionRow()] },
    )
    const { bundlePredictionGate } = await load()
    const gate = await bundlePredictionGate(TENANT, BUNDLE)
    expect(gate.required).toBe(true)
    expect(gate.pendingWriteId).toBe(DRAFT)
    expect(gate.prediction?.predictedOutcome).toBe('about 6 booked calls a week')
  })
})

function draftRowForGate(): Record<string, unknown> {
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
  }
}

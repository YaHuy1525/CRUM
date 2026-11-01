// tests/marketing/image-spend.test.ts
// The daily image spend ceiling is the only thing standing between an agent
// loop and a real bill, so the boundary is worth ten cases and a database
// that never sees any of them (spec section 4.2).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const DOC = '99999999-9999-4999-8999-999999999999'
const SPEND_ID = '44444444-4444-4444-8444-444444444444'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/marketing/image-spend')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('the ceiling arithmetic', () => {
  it('spends exactly to the ceiling and passes', async () => {
    const { admitsRun, headroomMinor } = await load()
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 1996, costMinorPerImage: 4, assetCount: 1 })).toBe(true)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 500 })).toBe(true)
    expect(headroomMinor({ ceilingMinor: 2000, committedMinor: 1990 })).toBe(10)
    // Past the ceiling the headroom is nothing, not a negative number a caller
    // could mistake for room: an overrun must read as "stop", never as a budget.
    expect(headroomMinor({ ceilingMinor: 2000, committedMinor: 2400 })).toBe(0)
  })

  it('refuses one minor unit over the ceiling', async () => {
    const { admitsRun } = await load()
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 1997, costMinorPerImage: 4, assetCount: 1 })).toBe(false)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 501 })).toBe(false)
  })

  it('stops a six asset run at the boundary, so five are paid and the sixth is a refusal', async () => {
    const { admitsRun } = await load()
    let committed = 1980
    const fitted: number[] = []
    for (let asset = 0; asset < 6; asset++) {
      if (!admitsRun({ ceilingMinor: 2000, committedMinor: committed, costMinorPerImage: 4, assetCount: 1 })) break
      fitted.push(asset)
      committed += 4
    }
    expect(fitted).toHaveLength(5)
    expect(committed).toBe(2000)
  })

  it('admits nothing when a zero ceiling says stop, or a count of zero asks for nothing', async () => {
    const { admitsRun } = await load()
    expect(admitsRun({ ceilingMinor: 0, committedMinor: 0, costMinorPerImage: 4, assetCount: 1 })).toBe(false)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 0 })).toBe(false)
  })
})

describe('the ledger', () => {
  it('sums only this tenant and only today', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1980' }] })
    const { committedSpendMinor } = await load()
    expect(await committedSpendMinor(TENANT)).toBe(1980)
    const [call] = calls('FROM marketing_image_spend')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('spent_on = CURRENT_DATE')
    expect(call!.params).toEqual([TENANT])
  })

  it('reads an empty ledger as zero and an unreadable ledger as an error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })
    const { committedSpendMinor } = await load()
    expect(await committedSpendMinor(TENANT)).toBe(0)
    // An aggregate without GROUP BY always returns exactly one row, and the
    // COALESCE makes that row's total a number, so zero rows is not an empty
    // ledger — it is a read that did not answer. Answering 0 there would be
    // answering "this tenant has spent nothing today", the one reading that
    // admits unlimited spend. Fail closed, and let the caller refuse.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await expect(committedSpendMinor(TENANT)).rejects.toThrow(/marketing_image_spend/)
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 'not-a-number' }] })
    await expect(committedSpendMinor(TENANT)).rejects.toThrow(/marketing_image_spend/)
  })

  it('appends a spend with a document', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    expect(
      await recordImageSpend({
        tenantId: TENANT,
        documentId: DOC,
        costMinor: 4,
        rawExtract: { predictionId: 'p1', model: 'flux-1.1-pro', costUsd: '0.04' },
      }),
    ).toBe(SPEND_ID)
    const [call] = calls('INSERT INTO marketing_image_spend')
    expect(call!.sql).toContain('RETURNING id')
    expect(call!.params).toEqual([
      TENANT,
      DOC,
      'replicate',
      4,
      JSON.stringify({ predictionId: 'p1', model: 'flux-1.1-pro', costUsd: '0.04' }),
    ])
  })

  it('appends a spend with no document, because a failed prediction still cost money', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    await recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: 4 })
    const [call] = calls('INSERT INTO marketing_image_spend')
    // No rawExtract passed is a null jsonb, not the string "null": a row written
    // by a caller that never saw a prediction must not look like a row whose
    // extract was parsed into nothing.
    expect(call!.params).toEqual([TENANT, null, 'replicate', 4, null])
  })

  it('names the prediction on a spend with no document, which is the failed path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    await recordImageSpend({
      tenantId: TENANT,
      documentId: null,
      costMinor: 2,
      rawExtract: { predictionId: 'p-f', model: 'flux-1.1-pro', costUsd: '0.02' },
    })
    const [call] = calls('INSERT INTO marketing_image_spend')
    // Task 3's fact, stated as an assertion: a prediction that produced no
    // bytes can still carry a charge, and its handle is the only thing that
    // names the money later. A null document must never be read as
    // "no prediction to record".
    expect(call!.params).toEqual([
      TENANT,
      null,
      'replicate',
      2,
      JSON.stringify({ predictionId: 'p-f', model: 'flux-1.1-pro', costUsd: '0.02' }),
    ])
  })

  it('refuses to under-report a negative or fractional cost before the database sees it', async () => {
    const { recordImageSpend } = await load()
    await expect(recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: -1 })).rejects.toThrow(/cost_minor/)
    await expect(recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: 1.5 })).rejects.toThrow(/cost_minor/)
    expect(calls('INSERT INTO marketing_image_spend')).toHaveLength(0)
  })
})

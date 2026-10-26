// tests/mastra/workflows/digest.mail.test.ts
//
// The Date/ISO boundary that only a live database exposes: pg hands back
// `timestamptz` as JS Date objects, and the digest itemSchema refuses
// non-strings ("expected string, received Date" - seen for real once a watched
// mailbox had mirrored rows). Unit mocks in digest.test.ts use string dates,
// so they could never catch this. Here the mocked query returns Dates, exactly
// what the driver produces.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/db/queries', () => ({
  queryAllTasks: vi.fn(() => Promise.resolve([])),
  queryTenantSchedulesForDate: vi.fn(() => Promise.resolve([])),
  queryStaleFollowups: vi.fn(() => Promise.resolve([])),
  queryRecentMailMessages: vi.fn(() =>
    Promise.resolve([
      {
        id: '1913abc',
        subject: 'Invoice',
        senders: ['Ariel <a@x.com>'],
        gmail_email: 'me@gmail.example',
        received_at: new Date('2026-10-26T09:00:00.000Z'),
      },
    ]),
  ),
}))

import { fetchOverdueStep, fetchRecentMailStep } from '../../../src/mastra/workflows/digest'
import { queryAllTasks } from '../../../src/db/queries'

const input = { tenantId: '550e8400-e29b-41d4-a716-446655440000' }

interface FetchOut {
  items: { id: string; customer_id: string | null; label: string; updated_at?: string }[]
}

// Only inputData is exercised; the execute-parameter union (InnerOutput on the
// return side) belongs to the framework contract, so the test projects the
// params and pins the result to the step's declared output shape - the same
// convention digest.test.ts uses.
const params = {
  inputData: input,
  requestContext: {},
  mastra: {},
  tracingContext: {},
  suspend: () => {},
  resume: undefined,
} as unknown as Parameters<typeof fetchRecentMailStep.execute>[0]

describe('fetchRecentMailStep date boundary', () => {
  it('normalizes pg Date objects to ISO strings', async () => {
    const out = (await fetchRecentMailStep.execute(params)) as unknown as FetchOut
    expect(out.items).toHaveLength(1)
    const item = out.items[0]!
    expect(item.updated_at).toBe('2026-10-26T09:00:00.000Z')
    expect(item.label).toBe('Invoice \u2014 Ariel <a@x.com>')
  })

  it('passes string timestamps through untouched (driver-dependent)', async () => {
    // Same normalization path with an ISO string, matching whatever the
    // interface claims: iso() must not double-convert.
    const { queryRecentMailMessages } = await import('../../../src/db/queries')
    vi.mocked(queryRecentMailMessages).mockResolvedValueOnce([
      { id: 'x', subject: 'S', senders: [], gmail_email: 'm@e', received_at: '2026-01-01T00:00:00.000Z' } as never,
    ])
    const out = (await fetchRecentMailStep.execute(params)) as unknown as FetchOut
    expect(out.items[0]!.updated_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('the other fetch steps share the same normalization helper', async () => {
    vi.mocked(queryAllTasks).mockResolvedValueOnce([
      { id: 't1', customer_id: null, title: 'Task', updated_at: new Date('2026-10-20T00:00:00.000Z') } as never,
    ])
    const out = (await fetchOverdueStep.execute(params)) as unknown as FetchOut
    expect(out.items[0]!.updated_at).toBe('2026-10-20T00:00:00.000Z')
  })
})

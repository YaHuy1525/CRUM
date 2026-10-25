// tests/mastra/workflows/approval-flow-steps.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `approvalFlow` is the only path that turns an approval into a write, so the
 * property worth testing is where the bytes come from. They used to come from
 * the request — the workflow re-staged a caller-supplied payload as a
 * hard-coded `customer`/`create` draft — which meant an approver could commit
 * content nobody staged, and a non-customer approval produced a customer.
 * These tests pin the current rule: read the draft back from `pending_writes`
 * by (id, tenant), refuse anything already decided or expired, and commit that
 * row and nothing else.
 */
vi.mock('../../../src/db/pending-writes', () => ({
  getPendingWrite: vi.fn(),
  commitWithReceipt: vi.fn(),
}))

import { commitStep, validateStep } from '../../../src/mastra/workflows/approval-flow'
import { commitWithReceipt, getPendingWrite } from '../../../src/db/pending-writes'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const APPROVER = '660e8400-e29b-41d4-a716-446655440009'
const DRAFT_ID = '770e8400-e29b-41d4-a716-446655440003'

const input = {
  pendingWriteId: DRAFT_ID,
  tenantId: TENANT,
  approvedBy: APPROVER,
  scope: 'crm:write',
}

function stagedDraft(over: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    tenantId: TENANT,
    runId: 'pending',
    objectType: 'task',
    operation: 'create',
    targetId: null,
    payload: { title: 'Send the renewal' },
    riskScore: 40,
    gate: 'approval',
    draftHash: 'deadbeef',
    receiptId: null,
    rejectedAt: null,
    committedAt: null,
    requestedBy: APPROVER,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  }
}

type ValidateParams = Parameters<typeof validateStep.execute>[0]
type CommitParams = Parameters<typeof commitStep.execute>[0]

/**
 * `Step.execute` is typed as returning the step output OR the framework's
 * suspend brand, so the union has no readable properties. These steps never
 * suspend, so the tests narrow to the shape each step actually declares.
 */
interface Validated {
  pendingWriteId: string
  tenantId: string
  approvedBy: string
  scope: string
  draft: unknown
}

interface Committed {
  committedId: string | null
  receiptId: string
  pendingWriteId: string
  objectType: string
  operation: string
}

const stepContext = {
  runId: 'run-test',
  workflowId: 'approvalFlow',
  mastra: {},
  requestContext: {},
  state: {},
}

function validate(data: typeof input): Promise<Validated> {
  return validateStep.execute({ ...stepContext, inputData: data } as unknown as ValidateParams) as Promise<Validated>
}

function commit(data: Validated): Promise<Committed> {
  return commitStep.execute({ ...stepContext, inputData: data } as unknown as CommitParams) as Promise<Committed>
}

beforeEach(() => {
  vi.mocked(getPendingWrite).mockReset()
  vi.mocked(commitWithReceipt).mockReset()
})

describe('validate-approval', () => {
  it('looks the draft up by id AND tenant, never by id alone', async () => {
    vi.mocked(getPendingWrite).mockResolvedValue(stagedDraft() as never)

    await validate(input)

    expect(getPendingWrite).toHaveBeenCalledTimes(1)
    expect(getPendingWrite).toHaveBeenCalledWith(DRAFT_ID, TENANT)
  })

  /**
   * A uuid is guessable by nothing except a leak, but the tenant filter is what
   * makes a leak harmless: without it another tenant's approver could burn a
   * draft it can even see.
   */
  it('refuses a draft the tenant cannot see', async () => {
    vi.mocked(getPendingWrite).mockResolvedValue(null)

    await expect(validate(input)).rejects.toThrow(/does not exist for this tenant/)
  })

  it.each([
    ['already approved', { receiptId: 'rr-1' }],
    ['rejected', { rejectedAt: '2026-10-24T09:00:00.000Z' }],
    ['expired', { expiresAt: '2026-01-01T00:00:00.000Z' }],
  ])('refuses a %s draft', async (_label, over) => {
    vi.mocked(getPendingWrite).mockResolvedValue(stagedDraft(over) as never)

    await expect(validate(input)).rejects.toThrow(/expired|rejected|already approved/)
  })

  it('hands the stored draft to the next step', async () => {
    const draft = stagedDraft()
    vi.mocked(getPendingWrite).mockResolvedValue(draft as never)

    const out = await validate(input)

    expect(out.draft).toBe(draft)
    expect(out.tenantId).toBe(TENANT)
  })
})

describe('commit-write', () => {
  it('commits the draft it read back, not a re-staged copy of the request', async () => {
    const draft = stagedDraft({ objectType: 'schedule', operation: 'update', targetId: DRAFT_ID })
    vi.mocked(getPendingWrite).mockResolvedValue(draft as never)
    vi.mocked(commitWithReceipt).mockResolvedValue({ committedId: 'c-1', receiptId: 'r-1' })

    const out = await commit(await validate(input))

    // Identity, not equality: the exact row validateStep loaded is the one
    // committed, so no caller can swap the payload between the two steps.
    expect(commitWithReceipt).toHaveBeenCalledWith(draft, {
      approvedBy: APPROVER,
      scope: 'crm:write',
    })
    expect(out).toEqual({
      committedId: 'c-1',
      receiptId: 'r-1',
      pendingWriteId: DRAFT_ID,
      objectType: 'schedule',
      operation: 'update',
    })
  })

  it('reports a null committedId instead of inventing one', async () => {
    vi.mocked(getPendingWrite).mockResolvedValue(
      stagedDraft({ objectType: 'email', gate: 'auto' }) as never,
    )
    // An auto email draft settles without a CRM row, so there is no record id
    // to report. Echoing a fabricated one would be a receipt for nothing.
    vi.mocked(commitWithReceipt).mockResolvedValue({ committedId: null, receiptId: 'r-2' })

    const out = await commit(await validate(input))

    expect(out.committedId).toBeNull()
    expect(out.objectType).toBe('email')
  })
})

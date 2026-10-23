import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getDbClient, closeDbClient } from '../../src/db/client'
import {
  getOrCreateDraft,
  commitWithReceipt as _commitWithReceipt,
  listPendingWrites as _listPendingWrites,
  rejectPendingWrite as _rejectPendingWrite,
  createHumanTask as _createHumanTask,
} from '../../src/db/pending-writes'
import { computeActionHash } from '../../src/governance/receipt'

const TENANT_A = '550e8400-e29b-41d4-a716-446655440000'
const USER_A = '660e8400-e29b-41d4-a716-446655440001'

describe('getOrCreateDraft', () => {
  beforeAll(async () => {
    const db = getDbClient()
    await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [TENANT_A])
    await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [TENANT_A])
  })

  afterAll(async () => {
    await closeDbClient()
  })

  it('creates a draft and returns it', async () => {
    const draft = await getOrCreateDraft({
      tenantId: TENANT_A,
      runId: 'run-1',
      objectType: 'customer',
      operation: 'create',
      payload: { name: 'Acme' },
      riskScore: 55,
      gate: 'approval',
      requestedBy: USER_A,
      idempotencyKey: computeActionHash({ name: 'Acme' }),
    })
    expect(draft.id).toBeTruthy()
    expect(draft.objectType).toBe('customer')
    expect(draft.gate).toBe('approval')
  })

  it('returns the same draft for the same idempotency key', async () => {
    const key = computeActionHash({ name: 'Idempotent Corp' })
    const d1 = await getOrCreateDraft({
      tenantId: TENANT_A, runId: 'run-2', objectType: 'customer',
      operation: 'create', payload: { name: 'Idempotent Corp' },
      riskScore: 30, gate: 'approval', requestedBy: USER_A, idempotencyKey: key,
    })
    const d2 = await getOrCreateDraft({
      tenantId: TENANT_A, runId: 'run-3', objectType: 'customer',
      operation: 'create', payload: { name: 'Idempotent Corp' },
      riskScore: 30, gate: 'approval', requestedBy: USER_A, idempotencyKey: key,
    })
    expect(d1.id).toBe(d2.id)
  })
})

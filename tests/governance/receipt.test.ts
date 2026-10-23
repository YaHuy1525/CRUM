import { describe, it, expect, beforeAll } from 'vitest'
import { signReceipt, verifyReceipt, computeActionHash } from '../../src/governance/receipt'

describe('signReceipt', () => {
  beforeAll(() => {
    process.env.APPROVAL_HMAC_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!'
  })

  it('produces a hex digest', () => {
    const sig = signReceipt({
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    })
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const input = {
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    }
    expect(signReceipt(input)).toBe(signReceipt(input))
  })

  it('differs when any field changes', () => {
    const base = {
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    }
    const sig1 = signReceipt(base)
    const sig2 = signReceipt({ ...base, runId: 'run-xyz' })
    expect(sig1).not.toBe(sig2)
  })
})

describe('verifyReceipt', () => {
  beforeAll(() => {
    process.env.APPROVAL_HMAC_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!'
  })

  it('returns true for a valid signature', () => {
    const input = {
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    }
    const sig = signReceipt(input)
    expect(verifyReceipt(input, sig)).toBe(true)
  })

  it('returns false for a tampered signature', () => {
    const input = {
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    }
    expect(verifyReceipt(input, '0'.repeat(64))).toBe(false)
  })

  it('returns false when input is modified', () => {
    const input = {
      pendingWriteId: '550e8400-e29b-41d4-a716-446655440000',
      runId: 'run-abc',
      scope: 'crm:write',
      actionHash: computeActionHash({ name: 'Acme' }),
      approvedBy: '660e8400-e29b-41d4-a716-446655440001',
    }
    const sig = signReceipt(input)
    expect(verifyReceipt({ ...input, runId: 'run-xyz' }, sig)).toBe(false)
  })
})

describe('computeActionHash', () => {
  it('produces a stable hash for the same payload', () => {
    const h1 = computeActionHash({ name: 'Acme', city: 'Berlin' })
    const h2 = computeActionHash({ name: 'Acme', city: 'Berlin' })
    expect(h1).toBe(h2)
  })

  it('differs for different payloads', () => {
    const h1 = computeActionHash({ name: 'Acme' })
    const h2 = computeActionHash({ name: 'Globex' })
    expect(h1).not.toBe(h2)
  })
})

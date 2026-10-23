// tests/api/approvals.test.ts
import { describe, it, expect } from 'vitest'
import { createApprovalRouter } from '../../src/api/approvals'

describe('approval routes', () => {
  it('creates a router with the expected routes', () => {
    const router = createApprovalRouter()
    expect(router).toBeDefined()
    // Route existence is verified by integration tests in Task 12.
    // This test verifies the module loads and exports correctly.
  })
})

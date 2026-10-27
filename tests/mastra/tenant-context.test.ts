import { describe, it, expect } from 'vitest'
import {
  TenantRequestContextSchema,
  tenantScope,
  type TenantRequestContext,
} from '../../src/mastra/tenant-context'

describe('TenantRequestContextSchema', () => {
  const validContext: TenantRequestContext = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    userRole: 'user',
  }

  it('accepts a valid context with user role', () => {
    const result = TenantRequestContextSchema.safeParse(validContext)
    expect(result.success).toBe(true)
    expect(result.data).toEqual(validContext)
  })

  it('accepts a valid context with admin role', () => {
    const adminContext = { ...validContext, userRole: 'admin' as const }
    const result = TenantRequestContextSchema.safeParse(adminContext)
    expect(result.success).toBe(true)
    if (!result.success) {
      throw new Error(
        `expected admin context to parse, got issues: ${JSON.stringify(result.error.issues)}`,
      )
    }
    expect(result.data.userRole).toBe('admin')
  })

  it('rejects missing tenantId', () => {
    const { tenantId: _tenantId, ...missingTenant } = validContext
    const result = TenantRequestContextSchema.safeParse(missingTenant)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0])
      expect(paths).toContain('tenantId')
    }
  })

  it('rejects missing userId', () => {
    const { userId: _userId, ...missingUser } = validContext
    const result = TenantRequestContextSchema.safeParse(missingUser)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0])
      expect(paths).toContain('userId')
    }
  })

  it('rejects invalid UUID format for tenantId', () => {
    const invalid = { ...validContext, tenantId: 'not-a-uuid' }
    const result = TenantRequestContextSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('UUID'))).toBe(true)
    }
  })

  it('rejects invalid UUID format for userId', () => {
    const invalid = { ...validContext, userId: '12345' }
    const result = TenantRequestContextSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('UUID'))).toBe(true)
    }
  })

  it('rejects invalid userRole', () => {
    const invalid = { ...validContext, userRole: 'superadmin' }
    const result = TenantRequestContextSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('tenantScope', () => {
  const baseContext: TenantRequestContext = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    userRole: 'user',
  }

  it('returns ownerIds with userId for user role', () => {
    const predicates = tenantScope(baseContext)
    expect(predicates.ownerIds).toEqual([baseContext.userId])
    expect(predicates.teamMemberIds).toEqual([])
  })

  it('returns empty predicates for admin role', () => {
    const adminContext: TenantRequestContext = { ...baseContext, userRole: 'admin' }
    const predicates = tenantScope(adminContext)
    expect(predicates.ownerIds).toEqual([])
    expect(predicates.teamMemberIds).toEqual([])
  })

  it('preserves userId in ownerIds when role is user', () => {
    const predicates = tenantScope(baseContext)
    expect(predicates.ownerIds).toHaveLength(1)
    expect(predicates.ownerIds[0]).toBe(baseContext.userId)
  })
})

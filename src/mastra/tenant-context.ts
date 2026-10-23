import { z } from 'zod'

/**
 * Schema for tenant-scoped request context.
 * Used to enforce row-level security predicates in Mastra agent tools.
 */
export const TenantRequestContextSchema = z.object({
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  userId: z.string().uuid('userId must be a valid UUID'),
  userRole: z.enum(['user', 'admin']),
})

export type TenantRequestContext = z.infer<typeof TenantRequestContextSchema>

/**
 * Returns row-level security predicates for a tenant-scoped request.
 * 
 * - For 'user' role: restricts to rows owned by the user
 * - For 'admin' role: returns empty predicates (sees all rows in tenant)
 */
export function tenantScope(context: TenantRequestContext): {
  ownerIds: string[]
  teamMemberIds: string[]
} {
  if (context.userRole === 'admin') {
    return { ownerIds: [], teamMemberIds: [] }
  }
  return { ownerIds: [context.userId], teamMemberIds: [] }
}

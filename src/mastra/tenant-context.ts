import { z } from 'zod'

export const TenantRequestContextSchema = z.object({
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  userId: z.string().uuid('userId must be a valid UUID'),
  userRole: z.enum(['user', 'admin']),
})

export type TenantRequestContext = z.infer<typeof TenantRequestContextSchema>

export function tenantScope(context: TenantRequestContext): {
  ownerIds: string[]
  teamMemberIds: string[]
} {
  if (context.userRole === 'admin') {
    return { ownerIds: [], teamMemberIds: [] }
  }
  return { ownerIds: [context.userId], teamMemberIds: [] }
}

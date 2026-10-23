import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryFollowups } from '../../db/queries'

const FollowupSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  note: z.string().optional(),
  owner_id: z.string(),
  team_member_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
})

export const listFollowupsTool = createTool({
  id: 'crm.list_followups',
  title: 'List Followups',
  description: 'List all followups for a given customer. Returns an array of followup records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(FollowupSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_followups', async () => {
      const rc = context.requestContext.all
      return queryFollowups(rc, input.customerId)
    })
  },
})

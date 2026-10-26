import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryFollowups } from '../../db/queries'
import { FollowupRowSchema } from './row-fields'

export const listFollowupsTool = createTool({
  id: 'crm.list_followups',
  title: 'List Followups',
  description: 'List all followups for a given customer. Returns an array of followup records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(FollowupRowSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_followups', async () => {
      const rc = context.requestContext.all
      return queryFollowups(rc, input.customerId)
    })
  },
})

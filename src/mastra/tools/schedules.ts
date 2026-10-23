import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { querySchedules } from '../../db/queries'

const ScheduleSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  scheduled_at: z.string().optional(),
  owner_id: z.string(),
  team_member_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
})

export const listSchedulesTool = createTool({
  id: 'crm.list_schedules',
  title: 'List Schedules',
  description: 'List all schedules for a given customer. Returns an array of schedule records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(ScheduleSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_schedules', async () => {
      const rc = context.requestContext.all
      return querySchedules(rc, input.customerId)
    })
  },
})

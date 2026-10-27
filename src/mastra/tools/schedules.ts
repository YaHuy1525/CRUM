import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { querySchedules } from '../../db/queries'
import { ScheduleRowSchema } from './row-fields'

export const listSchedulesTool = createTool({
  id: 'crm.list_schedules',
  title: 'List Schedules',
  description: 'List all schedules for a given customer. Returns an array of schedule records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(ScheduleRowSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_schedules', async () => {
      const rc = context.requestContext.all
      return querySchedules(rc, input.customerId)
    })
  },
})

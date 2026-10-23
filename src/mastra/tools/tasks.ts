import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryTasks, queryMyTasks, queryMyFollowups } from '../../db/queries'

const TaskSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  owner_id: z.string(),
  team_member_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
})

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

export const listTasksTool = createTool({
  id: 'crm.list_tasks',
  title: 'List Tasks',
  description: 'List all tasks for a given customer. Returns an array of task records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(TaskSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_tasks', async () => {
      const rc = context.requestContext.all
      return queryTasks(rc, input.customerId)
    })
  },
})

export const myOpenItemsTool = createTool({
  id: 'crm.my_open_items',
  title: 'My Open Items',
  description: 'Returns tasks and followups assigned to the current user across all customers.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({}),
  outputSchema: z.object({
    tasks: z.array(TaskSchema),
    followups: z.array(FollowupSchema),
  }),
  execute: async (_input, context) => {
    return context.observe.span('crm.my_open_items', async () => {
      const rc = context.requestContext.all
      const [tasks, followups] = await Promise.all([
        queryMyTasks(rc),
        queryMyFollowups(rc),
      ])
      return { tasks, followups }
    })
  },
})

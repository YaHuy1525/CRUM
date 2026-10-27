import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryTasks, queryMyTasks, queryMyFollowups } from '../../db/queries'
import { FollowupRowSchema, TaskRowSchema } from './row-fields'

export const listTasksTool = createTool({
  id: 'crm.list_tasks',
  title: 'List Tasks',
  description: 'List all tasks for a given customer. Returns an array of task records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(TaskRowSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_tasks', async () => {
      const rc = context.requestContext.all
      return queryTasks(rc, input.customerId)
    })
  },
})

const OPEN_TASK_STATUSES = new Set(['open', 'in_progress'])
const OPEN_FOLLOWUP_STATUSES = new Set(['scheduled', 'missed'])

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function urgency(value?: string | Date | null): number {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

export const myOpenItemsTool = createTool({
  id: 'crm.my_open_items',
  title: 'My Open Items',
  description:
    'Returns the open tasks and follow-ups assigned to the current user across all customers, most urgent first and bounded by `limit` (default 25 per list). It is a shortlist, not a census: ask a counting or filtering question of the whole set through a filtered read instead.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  }),
  outputSchema: z.object({
    tasks: z.array(TaskRowSchema),
    followups: z.array(FollowupRowSchema),
  }),
  execute: async (input, context) => {
    return context.observe.span('crm.my_open_items', async () => {
      const rc = context.requestContext.all
      const [tasks, followups] = await Promise.all([
        queryMyTasks(rc),
        queryMyFollowups(rc),
      ])
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      return {
        tasks: tasks
          .filter((task) => OPEN_TASK_STATUSES.has(task.status ?? 'open'))
          .sort((a, b) => urgency(a.deadline) - urgency(b.deadline))
          .slice(0, limit),
        followups: followups
          .filter((followup) => OPEN_FOLLOWUP_STATUSES.has(followup.status ?? 'scheduled'))
          .sort((a, b) => urgency(a.scheduled_at) - urgency(b.scheduled_at))
          .slice(0, limit),
      }
    })
  },
})

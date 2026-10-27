import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { queryAllTasks, queryRecentMailMessages, queryTenantSchedulesForDate, queryStaleFollowups } from '../../db/queries'


const digestInputSchema = z.object({
  tenantId: z.string().uuid(),
  date: z.string().optional(),
  staleDays: z.number().int().positive().optional(),
  mailLimit: z.number().int().positive().max(50).optional(),
})

const itemSchema = z.object({
  id: z.string(),
  customer_id: z.string().nullable(),
  label: z.string(),
  updated_at: z.string().optional(),
})

const fetchOutputSchema = z.object({
  items: z.array(itemSchema),
})

const digestOutputSchema = z.object({
  date: z.string(),
  overdue: z.array(itemSchema),
  todaySchedule: z.array(itemSchema),
  staleFollowups: z.array(itemSchema),
  recentMail: z.array(itemSchema),
  summary: z.string(),
})

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return undefined
}

export const fetchOverdueStep = createStep({
  id: 'fetch-overdue',
  inputSchema: digestInputSchema,
  outputSchema: fetchOutputSchema,
  execute: async ({ inputData }) => {
    const tasks = await queryAllTasks(inputData.tenantId)
    return {
      items: tasks.map((t) => ({
        id: t.id,
        customer_id: t.customer_id,
        label: t.title ?? t.description ?? `Task ${t.id.slice(0, 8)}`,
        updated_at: iso(t.updated_at),
      })),
    }
  },
})

export const fetchTodayScheduleStep = createStep({
  id: 'fetch-today-schedule',
  inputSchema: digestInputSchema,
  outputSchema: fetchOutputSchema,
  execute: async ({ inputData }) => {
    const date = inputData.date ?? new Date().toISOString().slice(0, 10)
    const schedules = await queryTenantSchedulesForDate(inputData.tenantId, date)
    return {
      items: schedules.map((s) => ({
        id: s.id,
        customer_id: s.customer_id,
        label: `Schedule ${s.id.slice(0, 8)}${s.scheduled_at ? ` @ ${s.scheduled_at}` : ''}`,
        updated_at: iso(s.updated_at),
      })),
    }
  },
})

export const fetchStaleFollowupsStep = createStep({
  id: 'fetch-stale-followups',
  inputSchema: digestInputSchema,
  outputSchema: fetchOutputSchema,
  execute: async ({ inputData }) => {
    const staleDays = inputData.staleDays ?? 7
    const followups = await queryStaleFollowups(inputData.tenantId, staleDays)
    return {
      items: followups.map((f) => ({
        id: f.id,
        customer_id: f.customer_id,
        label: f.note ?? `Followup ${f.id.slice(0, 8)}`,
        updated_at: iso(f.updated_at),
      })),
    }
  },
})

export const fetchRecentMailStep = createStep({
  id: 'fetch-recent-mail',
  inputSchema: digestInputSchema,
  outputSchema: fetchOutputSchema,
  execute: async ({ inputData }) => {
    const limit = inputData.mailLimit ?? 10
    const messages = await queryRecentMailMessages(inputData.tenantId, limit)
    return {
      items: messages.map((m) => ({
        id: m.id,
        customer_id: null,
        label: `${m.subject || '(no subject)'} — ${m.senders[0] ?? m.gmail_email}`,
        updated_at: iso(m.received_at),
      })),
    }
  },
})


export const generateSummaryStep = createStep({
  id: 'generate-summary',
  inputSchema: z.object({
    'fetch-overdue': fetchOutputSchema,
    'fetch-today-schedule': fetchOutputSchema,
    'fetch-stale-followups': fetchOutputSchema,
    'fetch-recent-mail': fetchOutputSchema,
  }),
  outputSchema: digestOutputSchema,
  execute: ({ inputData }) => {
    const overdue = inputData['fetch-overdue'].items
    const todaySchedule = inputData['fetch-today-schedule'].items
    const staleFollowups = inputData['fetch-stale-followups'].items
    const recentMail = inputData['fetch-recent-mail'].items

    const date = new Date().toISOString().slice(0, 10)

    const parts: string[] = []
    parts.push(`${overdue.length} overdue task(s)`)
    parts.push(`${todaySchedule.length} schedule(s) today`)
    parts.push(`${staleFollowups.length} stale followup(s)`)
    if (recentMail.length > 0) parts.push(`${recentMail.length} new message(s) in watched mailbox(es)`)

    const summary = `Morning digest: ${parts.join(', ')}.`

    return Promise.resolve({
      date,
      overdue,
      todaySchedule,
      staleFollowups,
      recentMail,
      summary,
    })
  },
})

export const digestWorkflow = createWorkflow({
  id: 'crum-digest',
  inputSchema: digestInputSchema,
  outputSchema: digestOutputSchema,
})
  .parallel([fetchOverdueStep, fetchTodayScheduleStep, fetchStaleFollowupsStep, fetchRecentMailStep])
  .then(generateSummaryStep)
  .commit()

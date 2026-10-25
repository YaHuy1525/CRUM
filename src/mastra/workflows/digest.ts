import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { queryAllTasks, queryTenantSchedulesForDate, queryStaleFollowups } from '../../db/queries'

/**
 * §9 — Digest workflow: morning priorities summary.
 *
 * Three parallel fetch steps (overdue tasks, today's schedule, stale followups)
 * fan out from the workflow input, then a summary step merges the results into
 * a structured digest. The digest agent (§9.1) can post-process the summary
 * into natural language, but the workflow itself produces structured data.
 *
 * The workflow takes a tenantId and optional date (defaults to today). The
 * fetch steps run in parallel because they are independent queries against
 * different tables. The summary step waits for all three to complete.
 */

const digestInputSchema = z.object({
  tenantId: z.string().uuid(),
  /** ISO date string (YYYY-MM-DD). Defaults to today when omitted. */
  date: z.string().optional(),
  /** Days before a followup is considered stale. Defaults to 7. */
  staleDays: z.number().int().positive().optional(),
})

const itemSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
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
  summary: z.string(),
})

/**
 * Fetches all open tasks for the tenant (overdue candidates).
 * Since the tasks table has no due_date column yet, all tasks are returned
 * as overdue candidates — the summary step can prioritise by age.
 */
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
        updated_at: t.updated_at,
      })),
    }
  },
})

/**
 * Fetches schedules for the given date (defaults to today).
 */
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
        updated_at: s.updated_at,
      })),
    }
  },
})

/**
 * Fetches followups not updated within `staleDays` (default 7).
 */
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
        updated_at: f.updated_at,
      })),
    }
  },
})

/**
 * Merges the three parallel fetch results into a structured digest.
 *
 * After `.parallel()`, the inputData is keyed by each step's id:
 * {
 *   'fetch-overdue': { items: [...] },
 *   'fetch-today-schedule': { items: [...] },
 *   'fetch-stale-followups': { items: [...] },
 * }
 */
export const generateSummaryStep = createStep({
  id: 'generate-summary',
  inputSchema: z.object({
    'fetch-overdue': fetchOutputSchema,
    'fetch-today-schedule': fetchOutputSchema,
    'fetch-stale-followups': fetchOutputSchema,
  }),
  outputSchema: digestOutputSchema,
  execute: ({ inputData }) => {
    const overdue = inputData['fetch-overdue'].items
    const todaySchedule = inputData['fetch-today-schedule'].items
    const staleFollowups = inputData['fetch-stale-followups'].items

    const date = new Date().toISOString().slice(0, 10)

    const parts: string[] = []
    parts.push(`${overdue.length} overdue task(s)`)
    parts.push(`${todaySchedule.length} schedule(s) today`)
    parts.push(`${staleFollowups.length} stale followup(s)`)

    const summary = `Morning digest: ${parts.join(', ')}.`

    // The Mastra ExecuteFunction contract wants a Promise; this step is pure
    // aggregation, so it resolves one rather than being declared async.
    return Promise.resolve({
      date,
      overdue,
      todaySchedule,
      staleFollowups,
      summary,
    })
  },
})

/**
 * The complete digest workflow:
 * parallel([fetchOverdue, fetchTodaySchedule, fetchStaleFollowups]) → generateSummary
 */
export const digestWorkflow = createWorkflow({
  id: 'crum-digest',
  inputSchema: digestInputSchema,
  outputSchema: digestOutputSchema,
})
  .parallel([fetchOverdueStep, fetchTodayScheduleStep, fetchStaleFollowupsStep])
  .then(generateSummaryStep)
  .commit()

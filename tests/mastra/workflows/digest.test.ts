import { describe, it, expect } from 'vitest'
import {
  digestWorkflow,
  fetchOverdueStep,
  fetchTodayScheduleStep,
  fetchStaleFollowupsStep,
  fetchRecentMailStep,
  generateSummaryStep,
} from '../../../src/mastra/workflows/digest'
import { digestAgent } from '../../../src/mastra/agents/digest'

describe('digestWorkflow', () => {
  it('has the correct id', () => {
    expect(digestWorkflow.id).toBe('crum-digest')
  })

  it('exposes all five steps', () => {
    // The workflow should contain the four parallel fetch steps plus the summary
    // step. Mastra stores the step graph internally; we verify the exported
    // steps exist.
    expect(fetchOverdueStep).toBeDefined()
    expect(fetchTodayScheduleStep).toBeDefined()
    expect(fetchStaleFollowupsStep).toBeDefined()
    expect(fetchRecentMailStep).toBeDefined()
    expect(generateSummaryStep).toBeDefined()
  })

  it('has fetch steps with correct ids', () => {
    expect(fetchOverdueStep.id).toBe('fetch-overdue')
    expect(fetchTodayScheduleStep.id).toBe('fetch-today-schedule')
    expect(fetchStaleFollowupsStep.id).toBe('fetch-stale-followups')
    expect(fetchRecentMailStep.id).toBe('fetch-recent-mail')
  })

  it('has summary step with correct id', () => {
    expect(generateSummaryStep.id).toBe('generate-summary')
  })
})

describe('digestAgent', () => {
  it('has the correct id', () => {
    expect(digestAgent.id).toBe('digest')
  })

  it('has no tools (pure generation agent)', async () => {
    // The digest agent is a pure generation agent — it receives structured
    // data and produces a summary. No tools needed.
    const tools = await digestAgent.listTools()
    expect(tools).toEqual({})
  })

  it('has instructions set', async () => {
    const instructions = await digestAgent.getInstructions()
    expect(instructions).toBeDefined()
    expect(typeof instructions).toBe('string')
    expect((instructions as string).length).toBeGreaterThan(0)
  })
})

describe('generateSummaryStep output shape', () => {
  it('merges parallel step outputs correctly', async () => {
    // Verify the summary step's execute function produces the expected shape
    // when given mock parallel output.
    const mockParallelOutput = {
      'fetch-overdue': {
        items: [
          { id: 't1', customer_id: 'c1', label: 'Task 1', updated_at: '2026-10-20' },
        ],
      },
      'fetch-today-schedule': {
        items: [
          { id: 's1', customer_id: 'c2', label: 'Schedule 1', updated_at: '2026-10-24' },
        ],
      },
      'fetch-stale-followups': {
        items: [
          { id: 'f1', customer_id: 'c3', label: 'Followup 1', updated_at: '2026-10-01' },
          { id: 'f2', customer_id: 'c4', label: 'Followup 2', updated_at: '2026-09-15' },
        ],
      },
      'fetch-recent-mail': {
        items: [
          { id: 'm1', customer_id: null, label: 'Invoice 123 — a@x.com', updated_at: '2026-10-26' },
        ],
      },
    }

    // Call the step's execute function directly with mock data. Only inputData is
    // exercised, so the params are projected onto the real execute-parameter type
    // rather than `any`; the result then carries the step's declared output shape.
    const params = {
      inputData: mockParallelOutput,
      requestContext: {},
      mastra: {},
      tracingContext: {},
      suspend: () => {},
      resume: undefined,
    } as unknown as Parameters<typeof generateSummaryStep.execute>[0]
    // execute is typed as returning the step output or the workflow InnerOutput
    // union; this step always resolves the digest shape, so the test pins it.
    interface DigestItem {
      id: string
      customer_id: string
      label: string
      updated_at?: string
    }
    interface SummaryOutput {
      date: string
      overdue: DigestItem[]
      todaySchedule: DigestItem[]
      staleFollowups: DigestItem[]
      recentMail: DigestItem[]
      summary: string
    }
    const result = (await generateSummaryStep.execute(params)) as SummaryOutput

    expect(result.overdue).toHaveLength(1)
    expect(result.todaySchedule).toHaveLength(1)
    expect(result.staleFollowups).toHaveLength(2)
    expect(result.recentMail).toHaveLength(1)
    expect(result.summary).toContain('1 overdue task(s)')
    expect(result.summary).toContain('1 schedule(s) today')
    expect(result.summary).toContain('2 stale followup(s)')
    expect(result.summary).toContain('1 new message(s) in watched mailbox(es)')
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

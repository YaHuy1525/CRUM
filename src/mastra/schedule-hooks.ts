import type { ScheduleHooks } from '@mastra/core/schedules'

export function buildScheduleHooks(): ScheduleHooks {
  // None of these await: the ScheduleHooks signatures accept a synchronous
  // return (`Promise<T> | T`), so declaring them async would only promise work
  // that never happens.
  return {
    prepare: ({ schedule }) => {
      return { threadId: schedule.threadId as string | undefined }
    },
    onFinish: ({ agentId, trigger }) => {
      console.log(`[schedule] ${agentId} finished`, trigger)
    },
    onError: ({ agentId, error }) => {
      console.error(`[schedule] ${agentId} error:`, error.message)
    },
    onAbort: ({ agentId }) => {
      console.log(`[schedule] ${agentId} aborted`)
    },
  }
}

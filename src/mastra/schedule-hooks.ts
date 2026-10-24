import type { ScheduleHooks } from '@mastra/core/schedules'

export function buildScheduleHooks(): ScheduleHooks {
  return {
    prepare: async ({ schedule }) => {
      return { threadId: schedule.threadId as string | undefined }
    },
    onFinish: async ({ agentId, trigger }) => {
      console.log(`[schedule] ${agentId} finished`, trigger)
    },
    onError: async ({ agentId, error }) => {
      console.error(`[schedule] ${agentId} error:`, error.message)
    },
    onAbort: async ({ agentId }) => {
      console.log(`[schedule] ${agentId} aborted`)
    },
  }
}

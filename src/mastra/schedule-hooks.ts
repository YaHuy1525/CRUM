import type { ScheduleHooks } from '@mastra/core/schedules'
import type { CreateWorkflowScheduleInput } from '@mastra/core/schedules'
import {
  buildDailyEarningsScheduleConfig,
  buildWeeklyAudienceScheduleConfig,
} from './schedules/video-sync'

export function buildScheduleHooks(): ScheduleHooks {
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

/**
 * Build all schedule configs that should be registered at boot time.
 * This includes the digest schedule and video sync schedules.
 */
export function buildAllScheduleConfigs(): CreateWorkflowScheduleInput[] {
  return [
    buildDailyEarningsScheduleConfig(),
    buildWeeklyAudienceScheduleConfig(),
  ]
}

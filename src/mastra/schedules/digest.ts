import type { CrumEnv } from '../../config/env'
import type { CreateWorkflowScheduleInput } from '@mastra/core/schedules'

export function buildDigestScheduleConfig(
  env: CrumEnv,
): CreateWorkflowScheduleInput | null {
  const cron = env.CRUM_DIGEST_CRON?.trim()
  if (!cron) return null

  return {
    id: 'crum-digest-morning',
    workflowId: 'crum-digest',
    cron,
    timezone: 'UTC',
  }
}

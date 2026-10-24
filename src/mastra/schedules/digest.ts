import type { CrumEnv } from '../../config/env'
import type { CreateWorkflowScheduleInput } from '@mastra/core/schedules'

/**
 * Builds the digest schedule configuration from the environment.
 *
 * Returns `null` when `CRUM_DIGEST_CRON` is empty or unset, so the boot path
 * can skip schedule creation entirely. This keeps the digest schedule opt-in:
 * a developer who copies `.env.example` and leaves the variable blank does not
 * get a surprise cron job firing at 07:00 UTC.
 *
 * The returned object is a {@link CreateWorkflowScheduleInput} suitable for
 * passing directly to `mastra.schedules.create()`.
 */
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

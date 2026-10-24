import { parseEnv } from './config/env'
import { createCrumMastra } from './mastra'
import { buildDigestScheduleConfig } from './mastra/schedules/digest'

// Phase 1: construct the singleton at process startup, where the process
// environment is the right thing to read. No module-level singleton on purpose
// (see src/mastra/index.ts comment).
const env = parseEnv()
const mastra = createCrumMastra(env)

// Phase 6: register the digest schedule at boot. Schedule creation is async
// (it persists to storage), so it runs detached from the synchronous export
// below. Errors are logged but do not crash the boot — a missing schedule is
// a degraded feature, not a fatal one.
const digestScheduleConfig = buildDigestScheduleConfig(env)
if (digestScheduleConfig) {
  mastra.schedules
    .create(digestScheduleConfig)
    .then((schedule) => {
      console.log(
        `[CRUM] Digest schedule created: id=${schedule.id}, cron=${schedule.cron}, tz=${schedule.timezone ?? 'UTC'}`,
      )
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[CRUM] Failed to create digest schedule: ${message}`)
    })
}

// Mastra CLI reads this export and starts the server.
export default mastra

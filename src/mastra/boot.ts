import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import type { ApiServerHandle } from '../api/serve'
import { buildDigestScheduleConfig } from './schedules/digest'


export interface CrumBootResult {
  digestScheduled: boolean
  restPlane: Promise<ApiServerHandle | null>
  skipped: BootSkipReason | null
}

export type BootSkipReason = 'test' | 'not-server-process' | 'already-started'

interface BootMarker {
  __crumBootStarted?: boolean
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isMastraServerProcess(selfUrl: string = import.meta.url): boolean {
  return /(?:^|[\\/])\.mastra[\\/](?:output|\.build)[\\/]/.test(selfUrl)
}

export function bootCrumProcess(
  env: CrumEnv,
  mastra: Mastra,
  selfUrl: string = import.meta.url,
): CrumBootResult {
  if (env.NODE_ENV === 'test') {
    return { digestScheduled: false, restPlane: Promise.resolve(null), skipped: 'test' }
  }
  if (!isMastraServerProcess(selfUrl)) {
    return { digestScheduled: false, restPlane: Promise.resolve(null), skipped: 'not-server-process' }
  }
  return startCrumBootSideEffects(env, mastra)
}

export function startCrumBootSideEffects(env: CrumEnv, mastra: Mastra): CrumBootResult {
  const marker = globalThis as unknown as BootMarker
  if (marker.__crumBootStarted) {
    return { digestScheduled: false, restPlane: Promise.resolve(null), skipped: 'already-started' }
  }
  marker.__crumBootStarted = true

  const digestConfig = buildDigestScheduleConfig(env)
  const digestScheduled = digestConfig !== null
  if (digestConfig) {
    void mastra.schedules
      .create(digestConfig)
      .then((schedule) => {
        console.log(
          `[CRUM] Digest schedule created: id=${schedule.id}, cron=${schedule.cron}, tz=${schedule.timezone ?? 'UTC'}`,
        )
      })
      .catch((err: unknown) => {
        console.error(`[CRUM] Failed to create digest schedule: ${describe(err)}`)
      })
  }

  const restPlane = import('../api/serve')
    .then(({ startApiServer }) => startApiServer({ env, mastra }))
    .then((handle) => {
      console.log(`[CRUM] REST plane listening on http://127.0.0.1:${handle.port}`)
      return handle
    })
    .catch((err: unknown) => {
      console.error(
        `[CRUM] REST plane did not start on port ${env.CRUM_REST_PORT}: ${describe(err)}. ` +
          `The Mastra server on ${env.CRUM_API_PORT} is unaffected.`,
      )
      return null
    })

  return { digestScheduled, restPlane, skipped: null }
}

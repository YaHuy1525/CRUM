// src/mastra/boot.ts
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import type { ApiServerHandle } from '../api/serve'
import { buildDigestScheduleConfig } from './schedules/digest'

/**
 * The work that belongs to a *process* rather than to a request, extracted from
 * the entry module so it can be tested without importing the entry.
 *
 * Two things happen here, in this order:
 *
 * 1. The digest schedule is registered (§10.3). Creation is async because it
 *    persists to storage, so it runs detached from the caller. A failure is
 *    logged, not thrown: a missing schedule is a degraded feature, not a dead
 *    process.
 * 2. The `/api` REST plane binds next to the registry. It binds in this process
 *    because an AgentController session lives in the process that owns the live
 *    run: a plane in another process could read the storage-backed queues but
 *    could never steer a chat this process is streaming. A bind failure is
 *    logged, not thrown — losing the chat lane because port 4113 is occupied
 *    would be the worse outage. See `src/api/serve.ts`.
 *
 * Idempotency is deliberate, not assumed. `mastra dev` watches for file changes,
 * and whether a reload re-evaluates this module inside the same process or
 * restarts the child was not observed here — so the marker lives on `globalThis`
 * (surviving a re-evaluation) rather than at module scope (which would not). If
 * the CLI does restart the child, the marker is simply re-created and nothing is
 * lost. And because this module's caller — `src/mastra/index.ts` — is imported as
 * a library by every router, `bootCrumProcess` only acts inside the process the
 * Mastra CLI actually runs; see `isMastraServerProcess`.
 */

/** Result of a boot attempt, returned so tests can await the plane. */
export interface CrumBootResult {
  /** True when `CRUM_DIGEST_CRON` was configured and creation was attempted. */
  digestScheduled: boolean
  /**
   * Resolves once the REST plane is listening, or to null when it did not bind.
   * Never rejects: a caller that fires this off at module scope must not be able
   * to take the process down with an unhandled rejection because 4113 was busy.
   */
  restPlane: Promise<ApiServerHandle | null>
  /** Why nothing ran, when this call was a no-op. */
  skipped: BootSkipReason | null
}

export type BootSkipReason = 'test' | 'not-server-process' | 'already-started'

interface BootMarker {
  __crumBootStarted?: boolean
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * True only when this module was loaded from the built server bundle, i.e. from
 * inside `.mastra/output/` (or the `.mastra/.build/` staging directory).
 *
 * The predicate reads the module's own URL instead of `process.argv[1]` because
 * the two launch styles are not the same: `mastra start` runs
 * `node .mastra/output/index.mjs`, while `mastra dev` spawns the bundle through
 * `execa` from a supervisor that keeps its own dev-server lock. The first real
 * `npm run dev:all` of this code produced a server that printed Studio on :4112
 * and never bound the REST plane, which is only explainable by argv not being
 * what the gate expected. "Where was this file loaded from?" asks the actual
 * question — is this the compiled server? — independently of how it was started.
 *
 * This check exists because the boot lives behind `src/mastra/index.ts`, which is
 * also the barrel every router and half the suite imports. Without it, a plain
 * `npx tsx scripts/db-migrate.ts` or `npm run dev:api` that happens to touch the
 * barrel would register the digest schedule and bind port 4113 as a side effect
 * of an `import`. Under `tsx` and `vitest` this module's URL is
 * `src/mastra/boot.ts`, so those processes are refused.
 *
 * Both path separators are matched because a bundled URL is POSIX while a
 * developer-supplied override on Windows is a native path.
 */
export function isMastraServerProcess(selfUrl: string = import.meta.url): boolean {
  return /(?:^|[\\/])\.mastra[\\/](?:output|\.build)[\\/]/.test(selfUrl)
}

/**
 * The gated entry used by `src/mastra/index.ts`. Runs the side effects at most
 * once per server process and explains every refusal instead of throwing.
 *
 * `selfUrl` is a parameter rather than a fixed read of `import.meta.url` so a
 * test can drive both sides of the gate.
 */
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

/**
 * Runs the process-level side effects. Safe to call more than once: only the
 * first call in a process does anything, and later calls return this shape with
 * `skipped` explaining why.
 *
 * Un-gated on purpose, so a test can drive it without faking a CLI process; the
 * environment gates live in `bootCrumProcess`.
 */
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

  // Deferred import: `src/api/*` routers import this module's barrel, so a static
  // edge from the barrel to the plane would make the entry half-initialised while
  // the routers are still being evaluated. By the time this resolves the registry
  // export has been assigned.
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

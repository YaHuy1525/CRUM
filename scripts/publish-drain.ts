// scripts/publish-drain.ts
//
// The outbox drainer. One pass by default; --interval turns it into a poller,
// the same shape scripts/mail-watch.ts established.
//
//   npx tsx scripts/publish-drain.ts                    # one pass over every queued action
//   npx tsx scripts/publish-drain.ts --interval 60      # pass every minute
//   npx tsx scripts/publish-drain.ts --bundle <uuid>    # narrow to one bundle
//
// This is the only code in CRUM that makes an external HTTP call, and it makes
// it outside every transaction. commitWithReceipt wraps applyDraft in BEGIN and
// COMMIT; a publish that succeeded over HTTP but lost that transaction would
// leave CRUM believing nothing happened while a live page exists. The database
// is the source of intent, the provider is the source of state.
//
// Env loading follows scripts/mail-watch.ts: `mastra dev` loads .env for you, a
// bare tsx process does not, so the file is loaded here before parseEnv runs.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { parseEnv } from '../src/config/env'
import { getDbClient } from '../src/db/client'
import { markBundleLive } from '../src/db/marketing'
import { registerMetaLane, type MetaLaneEnv } from '../src/marketing/meta-ads-config'
import {
  actionAdapter,
  isExecutable,
  registerActionAdapter,
  type DerivedAction,
  type MarketingActionName,
} from '../src/marketing/outbox'
import { makePromotePageAdapter, makePublishPageAdapter, pageHostConfigFromEnv } from '../src/marketing/page-host'

interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export interface DrainRow {
  id: string
  tenant_id: string
  bundle_id: string
  action: string
  payload: unknown
  attempts: number
}

/**
 * Claim, then execute, then record. The claim is one atomic UPDATE that only
 * matches a queued row, so two drainers running at once cannot both execute one
 * row: whichever loses the race sees zero rows and moves on. That is the whole
 * of the concurrency story and it is deliberately not a lock, a lease or a
 * queue: a personal tool with one owner and one worker does not need more.
 *
 * The subselect holds the row locked (FOR UPDATE SKIP LOCKED) for the lifetime
 * of the statement, so the outer UPDATE sees the same `queued` row it selected
 * even when a second drainer evaluates the subselect at the same instant: that
 * drainer skips the locked row and claims the next one, or nothing.
 *
 * The claim stamps `executed_at`, so the column reads "the last moment this row
 * changed state" for every state it can be in: queued to running here, then
 * running to succeeded or failed in recordSuccess and recordFailure. Without
 * that stamp there is no claim time anywhere, and the reaper would have to
 * measure from `created_at`, the moment the row was queued, which is a
 * different and much older instant.
 */
export async function claimNextQueued(client: Queryable, bundleId?: string): Promise<DrainRow | null> {
  const result = await client.query<DrainRow>(
    bundleId
      ? `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1, executed_at = now()
          WHERE id = (
                    SELECT id FROM marketing_actions
                     WHERE status = 'queued' AND bundle_id = $1
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
          RETURNING id, tenant_id, bundle_id, action, payload, attempts`
      : `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1, executed_at = now()
          WHERE id = (
                    SELECT id FROM marketing_actions
                     WHERE status = 'queued'
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
          RETURNING id, tenant_id, bundle_id, action, payload, attempts`,
    bundleId ? [bundleId] : [],
  )
  return result.rows[0] ?? null
}

export async function recordSuccess(client: Queryable, actionId: string, result: Record<string, unknown>): Promise<void> {
  // The adapter answers with a deployment id; anything else is not one. A blind
  // String() here would store '[object Object]' in external_id and still look
  // like a provider answer.
  const externalId = typeof result['externalId'] === 'string' ? result['externalId'] : ''
  await client.query(
    `UPDATE marketing_actions
        SET status = 'succeeded', external_id = $2, result = $3::jsonb, executed_at = now(), last_error = NULL
      WHERE id = $1`,
    [actionId, externalId, JSON.stringify(result)],
  )
}

export async function recordFailure(client: Queryable, actionId: string, error: string): Promise<void> {
  // A terminal failure needs a new queued row, never a silent retry: the CHECK
  // at 0018 caps attempts at 3, so this row stops being retryable by itself and
  // marketing.retry_publish is the only way to ask for another go.
  await client.query(
    `UPDATE marketing_actions
        SET status = 'failed', last_error = $2, executed_at = now()
      WHERE id = $1`,
    [actionId, error.slice(0, 2000)],
  )
}

/**
 * A `running` row held longer than the process timeout is a drainer that died
 * holding it. Marking it failed and letting a human re-queue beats re-uploading
 * in silence, because a duplicate deployment is visible and a hidden second
 * publish is not.
 *
 * The window is measured from `executed_at`, which every state change stamps:
 * claim, success and failure. So it answers "how long has this row been in
 * flight", and `created_at` is deliberately not the answer, because that is the
 * moment the row was queued: a bundle approved ten minutes ago and claimed one
 * second ago has been in flight for one second, and reaping it then would fail a
 * row whose provider call is still running, inviting a second deployment. The
 * COALESCE stays for rows claimed by a build that predates the claim stamp: they
 * carry no claim time, and the queue time is the only bound left to retire them
 * by, so they keep the old behaviour rather than leaking as `running` forever.
 */
export async function reapStaleRunning(client: Queryable, olderThanSeconds: number): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE marketing_actions
        SET status = 'failed', last_error = 'stale_running: a drainer claimed this row and never reported'
      WHERE status = 'running'
        AND COALESCE(executed_at, created_at) < now() - interval '1 second' * $1
      RETURNING id`,
    [olderThanSeconds],
  )
  return result.rows.length
}

type ActionOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * The adapter call, and only the adapter call, inside the try. What the provider
 * did is what that try decides, so nothing that happens after it may be folded
 * into a provider failure: `recordSuccess` runs outside this function for that
 * reason. A database failure while writing down a success leaves the row
 * `running`, where the reaper retires it on claim age; it never becomes a
 * `failed` row whose retry would deploy the same page a second time.
 */
async function executeAction(action: DerivedAction, tenantId: string): Promise<ActionOutcome> {
  try {
    const adapter = actionAdapter(action.action)
    if (adapter === null) return { ok: false, error: `no_adapter: ${action.action} registered no adapter` }
    // The adapter needs to know whose bundle it is reading: the action carries a
    // bundle id and nothing else, and an unscoped artifact read would let one
    // tenant's row publish another tenant's page. The claimed row has the tenant.
    return { ok: true, result: { ...(await adapter.execute(action, { tenantId })) } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function drainOnce(deps: {
  // Only `query` is ever asked of it: the claim, the record and the reap are
  // plain statements, so a test can hand in a fake that answers the claim and
  // records the rest without a database behind it.
  pool?: Queryable
  bundleId?: string
  staleSeconds?: number
} = {}): Promise<{ ran: number; succeeded: number; failed: number }> {
  // The claim, the call and the record are three separate statements, so each is
  // its own transaction and no client is held across the adapter. `client` here
  // is a Pool by default: it checks a connection out per statement, and the
  // adapter's own reads take a different one.
  const client = deps.pool ?? getDbClient()
  await reapStaleRunning(client, deps.staleSeconds ?? 300)
  let ran = 0
  let succeeded = 0
  let failed = 0

  for (;;) {
    const row = await claimNextQueued(client, deps.bundleId)
    if (!row) break
    ran += 1

    // The column's CHECK is the vocabulary, so a value read back is one of the
    // declared names. `isExecutable` is what decides whether this process can
    // actually run it, and an action it cannot run is recorded as a failure
    // naming it rather than dropped.
    const action: DerivedAction = {
      action: row.action as MarketingActionName,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }
    if (!isExecutable(action.action)) {
      await recordFailure(client, row.id, `no_adapter: ${row.action} has no adapter in this process`)
      failed += 1
      continue
    }

    // The adapter is the only thing that can report a provider failure, and it is
    // the only thing inside this try. Writing the answer down comes after: a
    // database failure there is not the provider's, and reporting it as one would
    // leave a `failed` row over a page that exists.
    const outcome = await executeAction(action, row.tenant_id)
    if (!outcome.ok) {
      await recordFailure(client, row.id, outcome.error)
      failed += 1
      continue
    }
    await recordSuccess(client, row.id, outcome.result)
    succeeded += 1

    // Outside the recording above on purpose: the provider already answered and
    // the row already says so. A database blip while marking the bundle live must
    // not rewrite that row to failed, because `marketing.retry_publish` is what
    // re-queues a failed row and a retry here would deploy a live page twice.
    // The honest leftover is a loud line naming the bundle; a human sets it live.
    if (action.action === 'promote_page') {
      try {
        const marked = await markBundleLive({ tenantId: row.tenant_id, bundleId: row.bundle_id })
        if (!marked) {
          // A false is a write that matched no row: the bundle left approved,
          // publishing and live between the approval and this promote. The page
          // is live and the bundle does not say so, and nothing else would.
          console.error(
            `[publish-drain] action ${row.id} promoted bundle ${row.bundle_id}: the page is live but the bundle is not live, ` +
              'because its status no longer allows it; set the bundle live by hand',
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[publish-drain] action ${row.id} promoted bundle ${row.bundle_id} but marking it live failed: ${message}`,
        )
      }
    }
  }
  return { ran, succeeded, failed }
}

interface Options {
  intervalSeconds: number | null
  bundleId?: string
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { intervalSeconds: null }
  let cursor = 0
  const requireValue = (flag: string): string => {
    // The outer loop already stepped past the flag, so the value is at `cursor`.
    const value = argv[cursor]
    cursor++
    if (value === undefined) {
      console.error(`${flag} requires a value`)
      process.exit(2)
    }
    return value
  }
  while (cursor < argv.length) {
    const flag = argv[cursor]
    cursor++
    switch (flag) {
      case '--interval':
        opts.intervalSeconds = Number(requireValue('--interval'))
        break
      case '--bundle':
        opts.bundleId = requireValue('--bundle')
        break
      default:
        console.error(`unknown flag: ${flag}`)
        process.exit(2)
    }
  }
  if (opts.intervalSeconds !== null && (!Number.isFinite(opts.intervalSeconds) || opts.intervalSeconds < 1)) {
    console.error('--interval must be a positive number of seconds')
    process.exit(2)
  }
  return opts
}

function report(counts: { ran: number; succeeded: number; failed: number }): void {
  console.log(
    `[publish-drain] ran ${counts.ran}, succeeded ${counts.succeeded}, failed ${counts.failed}`,
  )
}

/**
 * The settings both lanes read, taken from the two readers rather than restated
 * here, so this file cannot drift from what they actually ask for.
 */
export type DrainEnv = Parameters<typeof pageHostConfigFromEnv>[0] & MetaLaneEnv

export interface DrainAdapters {
  /** The closures that put the registry back as this process found it. */
  handles: Array<() => void>
  /** Which lanes the environment actually configured, so the caller can say the
   *  missing one out loud instead of letting a reader infer it from a count. */
  pageHostConfigured: boolean
  metaConfigured: boolean
}

/**
 * Register every action this process can run.
 *
 * Both lanes, in one call, because the registry is the drainer's whole vocabulary.
 * `drainOnce` asks `isExecutable` about the row it just claimed (`:204`, and the
 * lookup the adapter call makes at `:162`) and records `no_adapter` when the answer
 * is no, and `isExecutable` reads this process's map (`src/marketing/outbox.ts:81`).
 * The server registers the Meta pair at boot (`src/mastra/index.ts:174-175`), but
 * the publisher is a different process, so a host that approves campaign work and
 * drains it here fails every Meta row while succeeding every page row. That
 * asymmetry is invisible from either file alone, which is why the two reads are one
 * call and one test rather than two blocks that can drift apart again.
 *
 * A missing half is not an error here. Whether "this host does not run that lane"
 * is the plan or the bug is an operator's judgement, so the caller is told which
 * lanes landed and says so.
 */
export function registerDrainAdapters(env: DrainEnv): DrainAdapters {
  const handles: Array<() => void> = []
  const pageHost = pageHostConfigFromEnv(env)
  if (pageHost !== null) {
    handles.push(registerActionAdapter(makePublishPageAdapter(pageHost)))
    handles.push(registerActionAdapter(makePromotePageAdapter(pageHost)))
  }
  const metaLane = registerMetaLane(env, 'publish-drain')
  handles.push(...metaLane)
  return {
    handles,
    pageHostConfigured: pageHost !== null,
    metaConfigured: metaLane.length > 0,
  }
}

async function main(): Promise<void> {
  const envPath = new URL('../.env', import.meta.url)
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const env = parseEnv()
  if (!env.DATABASE_URL) {
    console.error('[publish-drain] DATABASE_URL is unset; the drainer has no outbox to read.')
    process.exit(1)
  }

  // The adapters this process can run are the whole meaning of "executable". A
  // missing lane is said out loud and still starts: every queued action of that
  // kind then fails as no_adapter, in the table, where a human can see it. The
  // undo handles are deliberately not kept: a drainer holds its registry for the
  // life of the process, and the caller that wants the map back is the test.
  const { pageHostConfigured, metaConfigured } = registerDrainAdapters(env)
  if (!pageHostConfigured) {
    console.warn(
      '[publish-drain] no complete Cloudflare Pages config; queued page actions will be recorded as no_adapter',
    )
  }
  if (!metaConfigured) {
    console.warn(
      '[publish-drain] no complete Meta Ads config; queued campaign actions will be recorded as no_adapter',
    )
  }

  const options = parseArgs(process.argv.slice(2))
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 })

  const runOnce = async (): Promise<void> => {
    try {
      report(await drainOnce({ pool, ...(options.bundleId === undefined ? {} : { bundleId: options.bundleId }) }))
    } catch (err) {
      console.error('[publish-drain] pass error:', err instanceof Error ? err.message : String(err))
    }
  }

  await runOnce()
  if (options.intervalSeconds === null) {
    await pool.end()
    return
  }

  console.log(`[publish-drain] polling every ${options.intervalSeconds}s — Ctrl-C to stop`)
  const timer = setInterval(() => {
    void runOnce()
  }, options.intervalSeconds * 1000)

  const shutdown = () => {
    clearInterval(timer)
    void pool.end().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// A test imports drainOnce from this file, so the CLI tail runs only when this
// file is the entry point. Without the guard the integration suite would start
// a poller against whatever DATABASE_URL the developer's shell holds.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main()
}

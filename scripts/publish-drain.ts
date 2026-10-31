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
 */
export async function claimNextQueued(client: Queryable, bundleId?: string): Promise<DrainRow | null> {
  const result = await client.query<DrainRow>(
    bundleId
      ? `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1
          WHERE id = (
                    SELECT id FROM marketing_actions
                     WHERE status = 'queued' AND bundle_id = $1
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
          RETURNING id, tenant_id, bundle_id, action, payload, attempts`
      : `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1
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
 * A `running` row older than the process timeout is a drainer that died holding
 * it. Marking it failed and letting a human re-queue beats re-uploading in
 * silence, because a duplicate deployment is visible and a hidden second
 * publish is not.
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

    try {
      const adapter = actionAdapter(action.action)
      if (adapter === null) throw new Error(`no_adapter: ${row.action} registered no adapter`)
      // The adapter needs to know whose bundle it is reading: the action carries a
      // bundle id and nothing else, and an unscoped artifact read would let one
      // tenant's row publish another tenant's page. The claimed row has the tenant.
      const result = await adapter.execute(action, { tenantId: row.tenant_id })
      await recordSuccess(client, row.id, { ...result })
      succeeded += 1
    } catch (err) {
      await recordFailure(client, row.id, err instanceof Error ? err.message : String(err))
      failed += 1
      continue
    }

    // Outside the try on purpose: the provider already answered and the row
    // already says so. A database blip while marking the bundle live must not
    // rewrite that row to failed, because `marketing.retry_publish` is what
    // re-queues a failed row and a retry here would deploy a live page twice.
    // The honest leftover is a loud line naming the bundle; a human sets it live.
    if (action.action === 'promote_page') {
      try {
        await markBundleLive({ tenantId: row.tenant_id, bundleId: row.bundle_id })
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

async function main(): Promise<void> {
  const envPath = new URL('../.env', import.meta.url)
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const env = parseEnv()
  if (!env.DATABASE_URL) {
    console.error('[publish-drain] DATABASE_URL is unset; the drainer has no outbox to read.')
    process.exit(1)
  }

  // The adapters this process can run are the whole meaning of "executable". A
  // missing Pages config is said out loud and still starts: every queued publish
  // then fails as no_adapter, in the table, where a human can see it.
  const pageHost = pageHostConfigFromEnv(env)
  if (pageHost === null) {
    console.warn(
      '[publish-drain] no complete Cloudflare Pages config; queued page actions will be recorded as no_adapter',
    )
  } else {
    registerActionAdapter(makePublishPageAdapter(pageHost))
    registerActionAdapter(makePromotePageAdapter(pageHost))
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

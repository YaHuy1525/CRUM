// scripts/mail-watch.ts
//
// The inbound-mail watcher. One pass by default; --interval turns it into a
// poller loop.
//
//   npx tsx scripts/mail-watch.ts                     # one pass over every watched mailbox
//   npx tsx scripts/mail-watch.ts --interval 300      # pass every 5 minutes
//   npx tsx scripts/mail-watch.ts --query "in:inbox" --limit 25 --pages 4
//   npx tsx scripts/mail-watch.ts --tenant <uuid>     # narrow to one tenant
//
// Only gmail_connections rows with watch = true are polled — enabling a watch
// is a deliberate, per-user decision (see 0010_crum_mail_watch.sql):
//
//   UPDATE gmail_connections SET watch = true WHERE tenant_id = $1 AND user_id = $2;
//
// What it does with what it finds: each new inbound message is mirrored into
// mail_messages (metadata + snippet, inside the granted gmail.readonly scope),
// which is exactly the table the digest workflow now reads, so a watched
// mailbox shows up in the next morning digest. Nothing is ever sent.
//
// Env loading follows src/api/serve.ts: `mastra dev` loads .env for you, a bare
// tsx process does not, so the file is loaded here before parseEnv runs.
import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { parseEnv } from '../src/config/env'
import { runWatchPass } from '../src/gmail/watch'
import type { WatchPassResult } from '../src/gmail/watch'

interface Options {
  intervalSeconds: number | null
  query: string
  limit: number
  pages: number
  tenantId?: string
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { intervalSeconds: null, query: 'in:inbox', limit: 25, pages: 4 }
  let cursor = 0
  const requireValue = (flag: string): string => {
    const value = argv[++cursor]
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
      case '--query':
        opts.query = requireValue('--query')
        break
      case '--limit':
        opts.limit = Number(requireValue('--limit'))
        break
      case '--pages':
        opts.pages = Number(requireValue('--pages'))
        break
      case '--tenant':
        opts.tenantId = requireValue('--tenant')
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
  if (!Number.isFinite(opts.limit) || opts.limit < 1 || opts.limit > 100) {
    console.error('--limit must be between 1 and 100')
    process.exit(2)
  }
  if (!Number.isFinite(opts.pages) || opts.pages < 1) {
    console.error('--pages must be a positive number')
    process.exit(2)
  }
  return opts
}

/**
 * Print one pass and return whether it fully succeeded. A per-mailbox failure
 * is reported but is not fatal for the loop: a dead token in one account must
 * not stop everyone else's watch.
 */
function report(pass: WatchPassResult): boolean {
  if (pass.results.length === 0) {
    console.log(`[mail-watch] ${pass.ranAt}: no watched mailboxes (set gmail_connections.watch = true to opt in)`)
    return true
  }
  for (const r of pass.results) {
    console.log(
      `[mail-watch] ${r.email}: ${r.inserted} new message(s) across ${r.pages} page(s)` +
        (r.error ? ` — FAILED: ${r.error}` : ''),
    )
  }
  return pass.results.every((r) => !r.error)
}

async function main(): Promise<void> {
  const envPath = new URL('../.env', import.meta.url)
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const env = parseEnv()
  if (!env.DATABASE_URL) {
    console.error('[mail-watch] DATABASE_URL is unset; the watcher needs the connections table.')
    process.exit(1)
  }

  const options = parseArgs(process.argv.slice(2))
  // A Supabase pooler can present a certificate chain Node's default store
  // does not contain. Strict verification is the default; the escape hatch is
  // an explicit operator opt-in, never silent.
  const insecure = process.env.MAIL_WATCH_INSECURE_SSL === 'true'
  if (insecure) {
    console.warn('[mail-watch] MAIL_WATCH_INSECURE_SSL=true — certificate verification is OFF (dev only, do not use in production)')
  }
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
    max: 2,
  })

  const runOnce = async (): Promise<boolean> => {
    try {
      const pass = await runWatchPass(
        { env, pool },
        { query: options.query, pageSize: options.limit, maxPages: options.pages, ...(options.tenantId ? { tenantId: options.tenantId } : {}) },
      )
      return report(pass)
    } catch (err) {
      console.error('[mail-watch] pass error:', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  const ok = await runOnce()
  if (options.intervalSeconds === null) {
    await pool.end()
    process.exit(ok ? 0 : 1)
  }

  console.log(`[mail-watch] polling every ${options.intervalSeconds}s — Ctrl-C to stop`)
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

void main()

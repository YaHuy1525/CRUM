// scripts/prospects-enrich.ts
//
// Fetches the public website behind each stale prospect, turns it into evidence
// with the pure analyser in src/prospects/enrich.ts, and appends one snapshot
// per page. Without snapshots every prospect has no weakness signals, so
// funnel-gap scoring stays at zero and the console has nothing to cite.
//
// Only website channels are fetched. Social profiles (Instagram, LinkedIn,
// Facebook, TikTok, Shopee, YouTube) cannot be read without authentication: a
// logged-out request returns a login wall or a JS-only shell whose chrome is
// not evidence of anything. A prospect that has only those channels is
// therefore not enrichable, and the run reports it as `enrichable 0`.
//
// Usage: npm run prospects:enrich  (needs DATABASE_URL and PROSPECT_TENANT_ID)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDbClient } from '../src/db/client'
import { analysePage } from '../src/prospects/enrich'

const EXTRACTOR_VERSION = 'enrich-v1'
const STALE_DAYS = 30
const TIMEOUT_MS = 8000
const REQUEST_DELAY_MS = 1000
const LIMIT = Number(process.env.PROSPECT_ENRICH_LIMIT ?? '25')

// DISTINCT ON keeps exactly one row per prospect when a prospect has more than
// one website channel, and the LIMIT then counts prospects, not joined channel
// rows. The join itself is restricted to 'website': no social profile is ever
// fetched, because the analyser cannot read one without authentication.
// A prospect is stale when none of its enrichment attempts is recent, so
// re-running the command an hour later refetches nothing. Only 'enrich-%'
// snapshots count towards freshness: the import CLI writes an 'import-v1'
// baseline for every prospect, and counting that baseline would hide every
// imported prospect from enrichment for STALE_DAYS.
export const ENRICH_TARGETS_SQL = `SELECT DISTINCT ON (p.id) p.id, p.country, c.platform, c.profile_url,
            TRUE AS has_website_channel
       FROM prospects p
       JOIN prospect_channels c ON c.prospect_id = p.id AND c.platform = 'website'
      WHERE p.tenant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM prospect_snapshots s
           WHERE s.prospect_id = p.id
             AND s.extractor_version LIKE 'enrich-%'
             AND s.fetched_at > now() - ($2 || ' days')::interval
        )
      ORDER BY p.id, c.audience_count DESC NULLS LAST
      LIMIT $3`

// One insert shape, used only for a readable page. An unreadable page writes
// nothing: a placeholder row would become the latest snapshot and its null
// price and offer would overwrite whatever the import recorded.
const SNAPSHOT_INSERT_SQL = `INSERT INTO prospect_snapshots
           (tenant_id, prospect_id, what_they_sell, price_min_minor, price_max_minor, currency,
            price_visible, has_website, has_lead_magnet, has_email_capture, has_funnel,
            weakness_signals, source_url, extractor_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`

type EnrichmentTarget = {
  id: string
  country: 'AU' | 'VN'
  platform: string
  profile_url: string
  has_website_channel: boolean
}

// Space out requests to one host: a 25-prospect run takes roughly 25 seconds
// instead of firing every fetch at once.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const tenantId = process.env.PROSPECT_TENANT_ID
  if (!tenantId) throw new Error('PROSPECT_TENANT_ID is required')

  const db = getDbClient()
  const targets = await db.query<EnrichmentTarget>(ENRICH_TARGETS_SQL, [
    tenantId,
    String(STALE_DAYS),
    LIMIT,
  ])

  const enrichable = targets.rows.length
  let enriched = 0
  let failed = 0
  for (const [index, row] of targets.rows.entries()) {
    // Pause between requests, never after the last one, so the run does not
    // sleep before it exits.
    if (index > 0) await sleep(REQUEST_DELAY_MS)
    try {
      const response = await fetch(row.profile_url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'CRUM prospect enrichment' },
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const html = await response.text()
      const result = analysePage({
        html,
        url: row.profile_url,
        platform: row.platform,
        country: row.country,
        hasWebsiteChannel: row.has_website_channel,
      })
      // An unread page is not evidence, and writing anything for it would make
      // a placeholder the latest snapshot. It is retried on the next run.
      if (!result.usable) {
        failed += 1
        console.warn(`skip ${row.id}: page not usable, no snapshot written`)
        continue
      }
      await db.query(SNAPSHOT_INSERT_SQL, [
        tenantId, row.id, result.whatTheySell, result.priceMinMinor, result.priceMaxMinor,
        result.currency, result.priceVisible, result.hasWebsite, result.hasLeadMagnet,
        result.hasEmailCapture, result.hasFunnel, result.weaknessSignals,
        row.profile_url, EXTRACTOR_VERSION,
      ])
      enriched += 1
    } catch (error) {
      failed += 1
      // One unreachable page must not abort the run; the next session retries it
      // because no snapshot was written.
      console.warn(`skip ${row.id}: ${(error as Error).message}`)
    }
  }
  // A tenant whose prospects have only social or marketplace channels selects
  // no rows at all; say `enrichable 0` instead of reporting a silent no-op.
  console.log(`enrichable ${enrichable}, enriched ${enriched}, failed ${failed}`)
}

// Only run when invoked directly. The test suite imports ENRICH_TARGETS_SQL,
// and an unguarded main() would call getDbClient() at import time. This is the
// same guard scripts/db-migrate.ts and scripts/db-export-schema.ts use.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}

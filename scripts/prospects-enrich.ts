// scripts/prospects-enrich.ts
//
// Fetches the public page behind each stale prospect channel, turns it into
// evidence with the pure analyser in src/prospects/enrich.ts, and appends one
// snapshot per page. Without snapshots every prospect has no weakness signals,
// so funnel-gap scoring stays at zero and the console has nothing to cite.
//
// Usage: npm run prospects:enrich  (needs DATABASE_URL and PROSPECT_TENANT_ID)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDbClient } from '../src/db/client'
import { analysePage } from '../src/prospects/enrich'

const EXTRACTOR_VERSION = 'enrich-v1'
// A page that returned a login wall or a JS-only shell is not evidence, but the
// attempt still has to be remembered or the next run fetches the same hopeless
// URL again. The marker version carries no weakness signals, so it satisfies
// the freshness guard without scoring as an observation.
const UNUSABLE_EXTRACTOR_VERSION = 'enrich-unusable'
const STALE_DAYS = 30
const TIMEOUT_MS = 8000
const REQUEST_DELAY_MS = 1000
const LIMIT = Number(process.env.PROSPECT_ENRICH_LIMIT ?? '25')

// A prospect with several channels (say Instagram and LinkedIn) would be
// selected once per channel and receive duplicate snapshots in one run, so
// DISTINCT ON keeps exactly one row per prospect. The website channel sorts
// first and the largest audience breaks the remaining tie: fetching the
// site is more informative than fetching a social profile, and a page read
// from Instagram must not be mistaken for the prospect having no site.
// `has_website_channel` is a fact from the channel table, not a guess about
// the fetched page, and it is what the analyser reports as hasWebsite.
// DISTINCT ON requires p.id first in the ORDER BY, and the LIMIT then counts
// prospects, not joined channel rows.
// A prospect is stale when none of its enrichment attempts is recent, so
// re-running the command an hour later refetches nothing.
// The import CLI writes a baseline snapshot for every prospect with the
// 'import-v1' extractor. That baseline is not a reading of the page, so it
// must not count as freshness: without the extractor_version guard the import
// hides every prospect from enrichment for STALE_DAYS.
// A reading the analyser marked unusable is recorded as 'enrich-unusable'. It
// counts as an attempt, not as evidence: skipping the prospect for STALE_DAYS
// stops the same login wall being fetched every run. The marker also matches
// the 'enrich-%' prefix; the explicit equality is kept so the retry contract
// stays visible (and survives any future narrowing of the prefix pattern).
export const ENRICH_TARGETS_SQL = `SELECT DISTINCT ON (p.id) p.id, p.country, c.platform, c.profile_url,
            EXISTS (
              SELECT 1 FROM prospect_channels w
               WHERE w.prospect_id = p.id AND w.platform = 'website'
            ) AS has_website_channel
       FROM prospects p
       JOIN prospect_channels c ON c.prospect_id = p.id
      WHERE p.tenant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM prospect_snapshots s
           WHERE s.prospect_id = p.id
             AND (s.extractor_version LIKE 'enrich-%'
                  OR s.extractor_version = 'enrich-unusable')
             AND s.fetched_at > now() - ($2 || ' days')::interval
        )
      ORDER BY p.id, (c.platform = 'website') DESC, c.audience_count DESC NULLS LAST
      LIMIT $3`

// One insert shape for both an observation and an unusable marker. The marker
// reuses conservative field values from the analyser (no signals, no price,
// flags false) and differs only in extractor_version.
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

  let enriched = 0
  let unusable = 0
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
      await db.query(SNAPSHOT_INSERT_SQL, [
        tenantId, row.id, result.whatTheySell, result.priceMinMinor, result.priceMaxMinor,
        result.currency, result.priceVisible, result.hasWebsite, result.hasLeadMagnet,
        result.hasEmailCapture, result.hasFunnel, result.weaknessSignals,
        row.profile_url,
        result.usable ? EXTRACTOR_VERSION : UNUSABLE_EXTRACTOR_VERSION,
      ])
      // An unread page is recorded only as a retry marker, never counted as
      // evidence: it must not look like a successful reading in the summary.
      if (result.usable) enriched += 1
      else unusable += 1
    } catch (error) {
      failed += 1
      // One unreachable page must not abort the run; the next session retries it
      // because no snapshot was written.
      console.warn(`skip ${row.id}: ${(error as Error).message}`)
    }
  }
  console.log(`enriched ${enriched}, unusable ${unusable}, failed ${failed}, of ${targets.rows.length}`)
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

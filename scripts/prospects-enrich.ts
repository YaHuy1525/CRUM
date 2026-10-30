// scripts/prospects-enrich.ts
//
// Fetches the public page behind each stale prospect channel, turns it into
// evidence with the pure analyser in src/prospects/enrich.ts, and appends one
// snapshot per page. Without snapshots every prospect has no weakness signals,
// so funnel-gap scoring stays at zero and the console has nothing to cite.
//
// Usage: npm run prospects:enrich  (needs DATABASE_URL and PROSPECT_TENANT_ID)
import { getDbClient } from '../src/db/client'
import { analysePage } from '../src/prospects/enrich'

const EXTRACTOR_VERSION = 'enrich-v1'
const STALE_DAYS = 30
const TIMEOUT_MS = 8000
const REQUEST_DELAY_MS = 1000
const LIMIT = Number(process.env.PROSPECT_ENRICH_LIMIT ?? '25')

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
  const targets = await db.query<EnrichmentTarget>(
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
    // A prospect is stale when none of its snapshots is recent, so re-running
    // the command an hour later refetches nothing.
    `SELECT DISTINCT ON (p.id) p.id, p.country, c.platform, c.profile_url,
            EXISTS (
              SELECT 1 FROM prospect_channels w
               WHERE w.prospect_id = p.id AND w.platform = 'website'
            ) AS has_website_channel
       FROM prospects p
       JOIN prospect_channels c ON c.prospect_id = p.id
      WHERE p.tenant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM prospect_snapshots s
           WHERE s.prospect_id = p.id AND s.fetched_at > now() - ($2 || ' days')::interval
        )
      ORDER BY p.id, (c.platform = 'website') DESC, c.audience_count DESC NULLS LAST
      LIMIT $3`,
    [tenantId, String(STALE_DAYS), LIMIT],
  )

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
      await db.query(
        `INSERT INTO prospect_snapshots
           (tenant_id, prospect_id, what_they_sell, price_min_minor, price_max_minor, currency,
            price_visible, has_website, has_lead_magnet, has_email_capture, has_funnel,
            weakness_signals, source_url, extractor_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [tenantId, row.id, result.whatTheySell, result.priceMinMinor, result.priceMaxMinor,
          result.currency, result.priceVisible, result.hasWebsite, result.hasLeadMagnet,
          result.hasEmailCapture, result.hasFunnel, result.weaknessSignals,
          row.profile_url, EXTRACTOR_VERSION],
      )
      enriched += 1
    } catch (error) {
      failed += 1
      // One unreachable page must not abort the run; the next session retries it
      // because no snapshot was written.
      console.warn(`skip ${row.id}: ${(error as Error).message}`)
    }
  }
  console.log(`enriched ${enriched}, failed ${failed}, of ${targets.rows.length}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

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
const LIMIT = Number(process.env.PROSPECT_ENRICH_LIMIT ?? '25')

type EnrichmentTarget = {
  id: string
  country: 'AU' | 'VN'
  platform: string
  profile_url: string
}

async function main(): Promise<void> {
  const tenantId = process.env.PROSPECT_TENANT_ID
  if (!tenantId) throw new Error('PROSPECT_TENANT_ID is required')

  const db = getDbClient()
  const targets = await db.query<EnrichmentTarget>(
    // A prospect is stale when none of its snapshots is recent, so re-running
    // the command an hour later refetches nothing. Biggest audiences first keeps
    // a small PROSPECT_ENRICH_LIMIT focused on the prospects worth scoring.
    `SELECT p.id, p.country, c.platform, c.profile_url
       FROM prospects p
       JOIN prospect_channels c ON c.prospect_id = p.id
      WHERE p.tenant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM prospect_snapshots s
           WHERE s.prospect_id = p.id AND s.fetched_at > now() - ($2 || ' days')::interval
        )
      ORDER BY c.audience_count DESC NULLS LAST
      LIMIT $3`,
    [tenantId, String(STALE_DAYS), LIMIT],
  )

  let enriched = 0
  let failed = 0
  for (const row of targets.rows) {
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

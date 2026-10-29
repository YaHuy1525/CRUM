// scripts/prospects-score.ts
//
// Scores every prospect for one tenant and upserts the result into
// prospect_scores. Without it the console shows every prospect as "unscored".
// Pure scoring lives in src/prospects/score.ts; this file only reads the latest
// channel/snapshot data and writes the flattened row.
//
// Usage: npm run prospects:score  (needs DATABASE_URL and PROSPECT_TENANT_ID)
import { getDbClient } from '../src/db/client'
import { toScoreRow } from '../src/prospects/persist-score'
import type { AudienceBasis } from '../src/prospects/normalize'
import type { Reachability } from '../src/prospects/score'

const REACHABILITY_BY_PLATFORM: Record<string, Reachability> = {
  email: 'email',
  instagram: 'dm',
  linkedin: 'linkedin',
  website: 'form',
}

type ProspectScoreSource = {
  id: string
  audience_count: number | null
  audience_basis: string | null
  price_min_minor: number | null
  what_they_sell: string | null
  weakness_signals: string[] | null
  platform: string | null
}

async function main(): Promise<void> {
  const tenantId = process.env.PROSPECT_TENANT_ID
  if (!tenantId) throw new Error('PROSPECT_TENANT_ID is required')

  const result = await getDbClient().query<ProspectScoreSource>(
    `SELECT p.id,
            MAX(c.audience_count) AS audience_count,
            (array_agg(c.audience_basis ORDER BY c.audience_count DESC NULLS LAST))[1] AS audience_basis,
            s.price_min_minor, s.what_they_sell, s.weakness_signals,
            (array_agg(c.platform))[1] AS platform
       FROM prospects p
       LEFT JOIN prospect_channels c ON c.prospect_id = p.id
       LEFT JOIN LATERAL (
         SELECT price_min_minor, what_they_sell, weakness_signals
           FROM prospect_snapshots
          WHERE prospect_id = p.id
          ORDER BY fetched_at DESC LIMIT 1
       ) s ON true
      WHERE p.tenant_id = $1
      GROUP BY p.id, s.price_min_minor, s.what_they_sell, s.weakness_signals`,
    [tenantId],
  )

  for (const row of result.rows) {
    const mapped = toScoreRow({
      prospectId: row.id,
      tenantId,
      audience: {
        count: row.audience_count === null ? null : Number(row.audience_count),
        basis: (row.audience_basis as AudienceBasis | null) ?? 'unknown',
      },
      offers: {
        priceVisible: row.price_min_minor !== null,
        sellsSomething: row.what_they_sell !== null,
      },
      weaknessSignals: row.weakness_signals ?? [],
      reachability: REACHABILITY_BY_PLATFORM[row.platform ?? ''] ?? 'none',
    })

    await getDbClient().query(
      `INSERT INTO prospect_scores
         (prospect_id, tenant_id, audience_score, monetisation_score, funnel_gap_score,
          reachability_score, total, band, weights_version, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (prospect_id) DO UPDATE SET
         audience_score = EXCLUDED.audience_score,
         monetisation_score = EXCLUDED.monetisation_score,
         funnel_gap_score = EXCLUDED.funnel_gap_score,
         reachability_score = EXCLUDED.reachability_score,
         total = EXCLUDED.total,
         band = EXCLUDED.band,
         weights_version = EXCLUDED.weights_version,
         computed_at = now()`,
      [mapped.prospectId, mapped.tenantId, mapped.audienceScore, mapped.monetisationScore,
        mapped.funnelGapScore, mapped.reachabilityScore, mapped.total, mapped.band, mapped.weightsVersion],
    )
  }

  console.log(`scored ${result.rows.length} prospects`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

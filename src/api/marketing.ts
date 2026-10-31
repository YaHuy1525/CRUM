import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { stagePromotion, stageRetry } from '../mastra/tools/marketing-writes'
import { getMarketingBundle, listAllCampaigns, listMarketingActions, listMarketingArtifacts } from '../db/marketing'
import { listRecentSnapshots, type MetricsSnapshotRow } from '../db/marketing-metrics'
import { bundleForLeadToken, countLeadsSince, normalizeEmail, recordLead } from '../db/marketing-leads'
import { sendConversionEvent, type ConversionsApiConfig } from '../marketing/meta-conversions'
import type { CampaignMetrics } from '../../console/lib/types'

// ── Marketing: the read surface and the two staging doors (slice 2) ─────────
//
// The reviewer needs to see the copy a staged bundle is pointing at, and the
// staged payload deliberately carries no prose, so the bundle row is the only
// place a human can read what they are approving. The bundle read also returns
// the outbox rows, because the preview URL a promotion would point at lives
// there and never in an approval payload.
//
// The two POST routes stage the second-click decisions by calling the same
// stagers the Mastra tools call. Neither decides anything: approving still goes
// through POST /api/approvals/drafts/:id/decision, so there is exactly one way
// to say yes.

export interface MarketingRouterDeps {
  env: CrumEnv
  // Optional: when both CRUM_META_PIXEL_ID and CRUM_META_ADS_ACCESS_TOKEN are
  // set, the boot wire-up passes the config in and the lead route fires a
  // server-side Conversions API event in parallel with the DB insert. Absent
  // means the route skips the API call and logs a warning. Spec section 7.5.
  conversionsConfig?: ConversionsApiConfig | null
}

const IdSchema = z.string().uuid()

const LeadFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(3).max(200).email(),
  country: z.enum(['AU', 'VN']),
  budget: z.enum(['under_500', '500_to_2k', '2k_plus', 'not_sure']),
  goal: z.string().trim().min(1).max(500),
  // A honeypot: a real visitor never fills it, a bot usually does.
  website: z.string().max(0).optional().default(''),
})

/**
 * The address as it arrived. Validation runs on a trimmed copy, but the raw
 * string is what the owner reads in the lead row; only the dedupe key is
 * normalised, in recordLead, beside the lookup it protects.
 */
function rawEmailOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const email = (input as Record<string, unknown>)['email']
  return typeof email === 'string' ? email : ''
}

export function createMarketingRouter(deps: MarketingRouterDeps): Hono {
  const { env, conversionsConfig } = deps
  const app = new Hono().basePath('/api/marketing')

  const auth = async (
    c: Context,
  ): Promise<{ identity: TenantRequestContext } | { error: Response }> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  app.get('/bundles/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const bundle = await getMarketingBundle(gate.identity.tenantId, parsed.data)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const artifacts = await listMarketingArtifacts(gate.identity.tenantId, bundle.id)
    const actions = await listMarketingActions(gate.identity.tenantId, bundle.id)
    return c.json({ bundle, artifacts, actions })
  })

  // Two staging doors, no deciding door. These create the same pending write the
  // tools create, by calling the same function, so the console can reach the
  // marketing spine without a chat sentence while `POST
  // /api/approvals/drafts/:id/decision` stays the only way to say yes. Spec
  // section 8.1.
  app.post('/bundles/:id/promote', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stagePromotion({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      bundleId: parsed.data,
    })
    if (!result.ok) return c.json({ error: 'not_promotable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })

  app.post('/bundles/:id/actions/:actionId/retry', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const bundle = IdSchema.safeParse(c.req.param('id'))
    const action = IdSchema.safeParse(c.req.param('actionId'))
    if (!bundle.success || !action.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stageRetry({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      actionId: action.data,
      // The path named a bundle, so the retry is filed under it or refused. The
      // stager keys the row on the action alone, and an approval under a bundle
      // the owner is not looking at is one they cannot read.
      expectedBundleId: bundle.data,
    })
    if (!result.ok) return c.json({ error: 'not_retryable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })

  // ── Campaign metrics for the console dashboard (slice 3) ─────────────────
  //
  // The dashboard component at console/components/CampaignMetricsDashboard.tsx
  // fetches this endpoint with a tenantId query parameter. It returns one
  // CampaignMetrics row per campaign (active or paused) with aggregated metrics
  // from the past 7 days of snapshots and the analyst's recommendation from the
  // bundle's analysis JSON. Spec section 10.1.
  app.get('/campaign-metrics', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const tenantId = c.req.query('tenantId')
    if (!tenantId) return c.json({ error: 'tenantId_required' }, 400)

    const [campaigns, snapshots] = await Promise.all([
      listAllCampaigns(tenantId),
      listRecentSnapshots(tenantId, 7),
    ])

    // Aggregate snapshots per (bundleId, campaignExternalId), summing the
    // numeric fields across all windows in the 7-day range.
    const aggregated = new Map<string, {
      impressions: number
      clicks: number
      spend: number
      leads: number
    }>()
    for (const snap of snapshots) {
      const key = `${snap.bundleId}:${snap.campaignExternalId}`
      const extracted = extractMetricsFromSnapshot(snap)
      const existing = aggregated.get(key)
      if (existing) {
        existing.impressions += extracted.impressions
        existing.clicks += extracted.clicks
        existing.spend += extracted.spend
        existing.leads += extracted.leads
      } else {
        aggregated.set(key, { ...extracted })
      }
    }

    const items: CampaignMetrics[] = campaigns.map((campaign) => {
      const key = `${campaign.bundleId}:${campaign.campaignExternalId}`
      const metrics = aggregated.get(key) ?? { impressions: 0, clicks: 0, spend: 0, leads: 0 }
      const costPerLead = metrics.leads > 0 ? metrics.spend / metrics.leads : 0

      // The analyst recommendation lives in the bundle's `analysis` JSON,
      // written by the campaign-analyst agent. Each campaign has its own entry
      // keyed by campaignExternalId inside the campaigns array.
      const { recommendation, lastAnalystRun } = extractRecommendation(
        campaign.analysis,
        campaign.campaignExternalId,
      )

      return {
        bundleId: campaign.bundleId,
        campaignExternalId: campaign.campaignExternalId,
        campaignName: campaign.campaignName,
        adAccountId: campaign.adAccountId,
        status: campaign.status,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spend: metrics.spend,
        leads: metrics.leads,
        costPerLead,
        recommendation,
        lastAnalystRun,
      }
    })

    return c.json({ items })
  })

  // Deliberately outside the `auth(c)` closure: a stranger filling in a
  // landing-page form has no CRUM identity, and spec section 13 says plainly
  // that this route cannot use the identity gate. The credential is the
  // per-bundle token stamped into the page before its bytes were hashed, and
  // nothing else on this router is public. Spec section 7.1.
  app.post('/leads', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const wantsJson = contentType.includes('application/json')
    const raw: unknown = wantsJson
      ? await c.req.json().catch(() => null)
      : Object.fromEntries(new URLSearchParams(await c.req.text().catch(() => '')).entries())

    // Resolved before the form is judged: a token CRUM cannot name is a 404
    // whether it never existed or was revoked, and no body changes that.
    const token = c.req.query('t') ?? ''
    const bundle = await bundleForLeadToken(token)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const parsed = LeadFormSchema.safeParse(raw)
    if (!parsed.success || parsed.data.website !== '') {
      // A filled honeypot is refused the same way a bad form is, and a form
      // caller is sent back to the page rather than shown a status code.
      if (!wantsJson) {
        return c.redirect(`${bundle.servingUrl}/${bundle.slug}/?lead=invalid`, 303)
      }
      return c.json({ error: 'invalid_lead' }, 400)
    }

    const dayStart = new Date(Date.now() - (Date.now() % 86_400_000)).toISOString()
    const count = await countLeadsSince(bundle.bundleId, dayStart)
    if (count >= env.CRUM_MARKETING_LEAD_DAILY_CAP) {
      // The cap and the success path answer identically on purpose: a visitor
      // is never shown the rate limit, and a prober learns nothing about which
      // of the two happened.
      if (!wantsJson) return c.redirect(`${bundle.servingUrl}/${bundle.slug}/thanks/`, 303)
      return c.json({ status: 'received' }, 200)
    }

    // Slice 3 spec section 7.3: the Conversions API call runs in parallel with
    // the lead insert. A Meta API failure must never cost a lead, so the
    // sender catches its own errors and logs them. The lead_token is the
    // deduplication key (spec section 7.2): the pixel fires with the same
    // token stamped into the page at save time, so Meta collapses the two.
    const thankYouUrl = `${bundle.servingUrl}/${bundle.slug}/thanks/`
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? c.req.header('x-real-ip')
      ?? ''
    const userAgent = c.req.header('user-agent') ?? ''

    const leadPromise = recordLead({
      tenantId: bundle.tenantId,
      bundleId: bundle.bundleId,
      name: parsed.data.name,
      email: rawEmailOf(raw),
      country: parsed.data.country,
      budgetBucket: parsed.data.budget,
      goal: parsed.data.goal,
      sourceUrl: `${bundle.servingUrl}/${bundle.slug}/`,
    })

    if (conversionsConfig) {
      // Fire-and-forget: the promise runs concurrently with the DB insert.
      // Its catch handler logs and swallows errors so a Meta outage never
      // reaches the response path below.
      sendConversionEvent(conversionsConfig, {
        leadToken: token,
        normalizedEmail: normalizeEmail(parsed.data.email),
        sourceUrl: thankYouUrl,
        bundleId: bundle.bundleId,
        campaignId: null,
        clientIpAddress: clientIp,
        clientUserAgent: userAgent,
      }).catch((err) => {
        console.warn('[CRUM] Conversions API call failed unexpectedly', err)
      })
    } else {
      // One warning per unconfigured boot, not per request: the route is
      // public and a bot flood would fill the log.
      if (!createMarketingRouter._warnedMissingConfig) {
        createMarketingRouter._warnedMissingConfig = true
        console.warn(
          '[CRUM] Conversions API not configured (CRUM_META_PIXEL_ID and/or ' +
          'CRUM_META_ADS_ACCESS_TOKEN absent); lead recorded without server-side event',
        )
      }
    }

    await leadPromise

    if (!wantsJson) return c.redirect(thankYouUrl, 303)
    return c.json({ status: 'received' }, 200)
  })

  return app
}

// ── Helpers for the campaign-metrics route ───────────────────────────────────

/**
 * Extracts numeric metrics from a snapshot's raw `metrics` field. The field
 * stores the JSON body returned by Meta's Ads Insights API, which is either the
 * `data` array directly or an object wrapping it. Each snapshot carries string
 * values for impressions, clicks, and spend; leads come from the `actions`
 * array when an `action_type` of `lead` is present.
 *
 * This is the same extraction logic as in scripts/analyst-cron.ts, duplicated
 * here so the route does not depend on a script module.
 */
function extractMetricsFromSnapshot(snapshot: MetricsSnapshotRow): {
  impressions: number
  clicks: number
  spend: number
  leads: number
} {
  const raw = snapshot.metrics as Record<string, unknown> | unknown[] | null
  if (raw === null || raw === undefined) {
    return { impressions: 0, clicks: 0, spend: 0, leads: 0 }
  }

  let dataArr: unknown[]
  if (Array.isArray(raw)) {
    dataArr = raw
  } else {
    const inner = raw.data
    dataArr = Array.isArray(inner) ? inner : []
  }

  let impressions = 0
  let clicks = 0
  let spend = 0
  let leads = 0

  for (const row of dataArr) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    impressions += Number(r.impressions ?? 0)
    clicks += Number(r.clicks ?? 0)
    spend += Number(r.spend ?? 0)
    const actions = r.actions
    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (
          typeof action === 'object' &&
          action !== null &&
          (action as Record<string, unknown>).action_type === 'lead'
        ) {
          leads += Number((action as Record<string, unknown>).value ?? 0)
        }
      }
    }
  }

  return { impressions, clicks, spend, leads }
}

/**
 * Pulls the analyst's recommendation and run timestamp from the bundle's
 * `analysis` JSON. The analysis field is written by the campaign-analyst agent
 * and has the shape `{ campaigns: [{ campaignId, recommendation }], ... }`.
 * Returns `null` for both fields when the analysis is absent or the campaign
 * is not found in it.
 */
function extractRecommendation(
  analysis: unknown,
  campaignExternalId: string,
): { recommendation: 'scale' | 'hold' | 'kill' | null; lastAnalystRun: string | null } {
  if (!analysis || typeof analysis !== 'object') {
    return { recommendation: null, lastAnalystRun: null }
  }
  const obj = analysis as Record<string, unknown>
  const campaigns = obj.campaigns
  if (!Array.isArray(campaigns)) {
    return { recommendation: null, lastAnalystRun: null }
  }
  const entry = campaigns.find(
    (c: Record<string, unknown>) => c.campaignId === campaignExternalId,
  ) as Record<string, unknown> | undefined
  if (!entry) {
    return { recommendation: null, lastAnalystRun: null }
  }
  const rec = entry.recommendation
  const recommendation = (rec === 'scale' || rec === 'hold' || rec === 'kill') ? rec : null
  // The analyst cron does not stamp a run timestamp into the analysis JSON
  // itself; the bundle's updated_at is the closest proxy. Return null here and
  // let the dashboard show '—' when no timestamp is available.
  return { recommendation, lastAnalystRun: null }
}

// One-shot warning flag so an unconfigured boot does not fill the log on
// every inbound lead. Module-level because the function is called once per
// request but the warning should fire at most once per process.
createMarketingRouter._warnedMissingConfig = false

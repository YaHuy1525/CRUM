// scripts/analyst-cron.ts
//
// The weekly analyst cron. Runs on a schedule configured externally (crontab,
// task scheduler, etc.). Reads the past 7 days of metrics snapshots, aggregates
// them per campaign, invokes the campaign-analyst agent, and stages a draft for
// scale or kill recommendations.
//
//   npx tsx scripts/analyst-cron.ts                          # uses CRUM_TENANT_ID from env
//   npx tsx scripts/analyst-cron.ts --tenant <uuid>          # explicit tenant
//
// Env loading follows scripts/publish-drain.ts: a bare tsx process does not
// load .env, so the file is loaded here before parseEnv runs.
import { existsSync } from 'node:fs'
import { parseEnv } from '../src/config/env'
import { closeDbClient } from '../src/db/client'
import { listActiveCampaigns } from '../src/db/marketing'
import { insertSnapshot, listRecentSnapshots, type MetricsSnapshotRow } from '../src/db/marketing-metrics'
import { campaignAnalystAgent } from '../src/mastra/agents/campaign-analyst'
import { makeSetCampaignStatusAdapter, type MetaAdsConfig } from '../src/marketing/meta-ads'
import { readCampaignMetrics, type MetricsReadbackConfig } from '../src/marketing/metrics-readback'
import { registerActionAdapter } from '../src/marketing/outbox'
import { stageCampaignStatusChange } from '../src/mastra/tools/marketing-writes'

interface AggregatedMetrics {
  impressions: number
  clicks: number
  spend: number
  leads: number
  costPerLead: number
}

interface CampaignInput {
  bundleId: string
  campaignId: string
  campaignName: string
  metrics: AggregatedMetrics
}

interface AnalystInput {
  window: { start: string; end: string }
  campaigns: CampaignInput[]
}

interface CampaignRecommendation {
  bundleId: string
  campaignId: string
  recommendation: 'scale' | 'hold' | 'kill'
  reason: string
}

interface AnalystOutput {
  recommendation: 'scale' | 'hold' | 'kill'
  threshold: string
  message: string
  campaigns: CampaignRecommendation[]
}

/**
 * Extracts numeric metrics from a snapshot's raw `metrics` field. The field
 * stores the JSON body returned by Meta's Ads Insights API, which is either the
 * `data` array directly or an object wrapping it. Each row carries string
 * values for impressions, clicks, and spend; leads come from the `actions`
 * array when an `action_type` of `lead` is present.
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

  // The snapshot stores either `{ data: [...] }` or the array directly.
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
 * Groups snapshots by (bundleId, campaignExternalId) and sums their metrics.
 * Multiple snapshots for the same campaign in the 7-day window are aggregated
 * into one totals row.
 */
function aggregateSnapshots(
  snapshots: MetricsSnapshotRow[],
): Map<string, { bundleId: string; campaignExternalId: string; metrics: AggregatedMetrics }> {
  const grouped = new Map<
    string,
    { bundleId: string; campaignExternalId: string; metrics: AggregatedMetrics }
  >()

  for (const snap of snapshots) {
    const key = `${snap.bundleId}:${snap.campaignExternalId}`
    const extracted = extractMetricsFromSnapshot(snap)
    const existing = grouped.get(key)
    if (existing) {
      existing.metrics.impressions += extracted.impressions
      existing.metrics.clicks += extracted.clicks
      existing.metrics.spend += extracted.spend
      existing.metrics.leads += extracted.leads
    } else {
      const costPerLead = extracted.leads > 0 ? extracted.spend / extracted.leads : 0
      grouped.set(key, {
        bundleId: snap.bundleId,
        campaignExternalId: snap.campaignExternalId,
        metrics: { ...extracted, costPerLead },
      })
    }
  }

  // Recompute costPerLead after aggregation.
  for (const entry of grouped.values()) {
    entry.metrics.costPerLead =
      entry.metrics.leads > 0 ? entry.metrics.spend / entry.metrics.leads : 0
  }

  return grouped
}

/**
 * Parses the analyst agent's text response as JSON. The agent is instructed to
 * return one JSON object; this function extracts the first JSON object it finds
 * in the text, tolerating minor formatting variations.
 */
function parseAnalystResponse(text: string): AnalystOutput {
  // Try direct parse first.
  try {
    return JSON.parse(text) as AnalystOutput
  } catch {
    // Fall through to extraction.
  }

  // Extract the first JSON object from the text.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1)) as AnalystOutput
  }

  throw new Error('analyst_response_invalid: could not parse JSON from agent response')
}

function parseArgs(argv: string[]): { tenantId: string | null } {
  let tenantId: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant' && i + 1 < argv.length) {
      tenantId = argv[i + 1]!
      i++
    }
  }
  return { tenantId }
}

/**
 * The Meta lane, read the way boot reads it (src/mastra/index.ts:155-176): the
 * access token and a non-empty JSON array of ad account ids, or nothing at all.
 *
 * The cron never calls the adapter it registers, so this looks odd until the
 * guard is read: stageCampaignStatusChange refuses an action its own process has
 * no adapter for, because an approval that queues work nothing can run is an
 * approval that lies. That check is per process, which is exactly how the
 * publisher works too (scripts/publish-drain.ts:315 registers the two page
 * adapters in the drainer's own process rather than trusting the server's map),
 * and a cron that registered nothing would refuse every recommendation on any
 * host, however well configured the deployment is. Registration costs no request
 * and no credit: the adapter is only a map entry until a drainer executes it.
 *
 * The parse is a deliberate copy of boot's, including the warning, because
 * boot's version is pinned by tests/mastra/marketing-boot.test.ts:50. One helper
 * for both call sites is the cleaner shape and is parked for the final review.
 */
export function statusAdapterConfigFromEnv(env: {
  CRUM_META_ADS_ACCESS_TOKEN?: string | undefined
  CRUM_META_AD_ACCOUNTS?: string | undefined
}): MetaAdsConfig | null {
  const accessToken = env.CRUM_META_ADS_ACCESS_TOKEN
  const raw = env.CRUM_META_AD_ACCOUNTS
  if (!accessToken || !raw) return null

  let adAccounts: string[]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((account) => typeof account === 'string')) {
      throw new Error('CRUM_META_AD_ACCOUNTS must be a JSON array of strings')
    }
    adAccounts = parsed
  } catch (err) {
    console.warn(
      '[analyst-cron] Failed to parse CRUM_META_AD_ACCOUNTS:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
  return adAccounts.length > 0 ? { accessToken, adAccounts } : null
}

/**
 * The main entry point. Exported so tests can invoke it with a mock agent and
 * controlled inputs without spawning a child process.
 */
export async function runAnalystCron(args: {
  tenantId: string
  windowStart?: Date
  windowEnd?: Date
  metricsReadback?: MetricsReadbackConfig | null
  analystUserId?: string | null
  invokeAgent?: (input: AnalystInput) => Promise<string>
  stageStatus?: typeof stageCampaignStatusChange
}): Promise<{
  campaignsProcessed: number
  recommendations: CampaignRecommendation[]
  stagedDrafts: Array<{ campaignId: string; status: string; draftId: string }>
  errors: string[]
  snapshotsCollected: number
}> {
  const end = args.windowEnd ?? new Date()
  const start = args.windowStart ?? new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)
  const invokeAgent = args.invokeAgent ?? defaultInvokeAgent
  const stageStatus = args.stageStatus ?? stageCampaignStatusChange
  const readbackConfig = args.metricsReadback ?? null

  // 1. Query active campaigns.
  const activeCampaigns = await listActiveCampaigns(args.tenantId)

  if (activeCampaigns.length === 0) {
    console.log('[analyst-cron] no active campaigns; nothing to analyse')
    return { campaignsProcessed: 0, recommendations: [], stagedDrafts: [], errors: [], snapshotsCollected: 0 }
  }

  // 2. Collect fresh metrics from Meta's Ads Insights API for each active
  //    campaign and insert a snapshot row. This is the spec section 8.2 step:
  //    "The cron job reads metrics for all active campaigns... then inserts a
  //    snapshot into marketing_metrics_snapshots for each campaign."
  const errors: string[] = []
  let snapshotsCollected = 0

  if (readbackConfig) {
    const collectResults = await Promise.allSettled(
      activeCampaigns.map(async (campaign) => {
        const result = await readCampaignMetrics(campaign.adAccountId, readbackConfig, {
          since: start.toISOString().slice(0, 10),
          until: end.toISOString().slice(0, 10),
        })
        if (result.error) {
          throw new Error(
            `metrics_api_error for ${campaign.adAccountId}: ${result.error.message} (HTTP ${result.error.httpStatus})`,
          )
        }
        await insertSnapshot(
          args.tenantId,
          campaign.bundleId,
          campaign.campaignExternalId,
          start,
          end,
          result.data,
        )
      }),
    )

    for (let i = 0; i < collectResults.length; i++) {
      const r = collectResults[i]!
      if (r.status === 'fulfilled') {
        snapshotsCollected++
      } else {
        const reason: unknown = r.reason
        const message = reason instanceof Error ? reason.message : String(reason)
        errors.push(`metrics_collection_failed: ${activeCampaigns[i]!.campaignExternalId}: ${message}`)
        console.error(`[analyst-cron] metrics collection failed for ${activeCampaigns[i]!.campaignExternalId}: ${message}`)
      }
    }
  } else {
    console.log('[analyst-cron] no metricsReadback config; skipping live collection, using existing snapshots')
  }

  // 3. Query recent snapshots (including the ones just inserted) and aggregate.
  const snapshots = await listRecentSnapshots(args.tenantId, 7)

  // 4. Aggregate snapshots per campaign.
  const aggregated = aggregateSnapshots(snapshots)

  // 5. Build the analyst input, one entry per active campaign.
  const campaigns: CampaignInput[] = activeCampaigns.map((c) => {
    const key = `${c.bundleId}:${c.campaignExternalId}`
    const entry = aggregated.get(key)
    return {
      bundleId: c.bundleId,
      campaignId: c.campaignExternalId,
      campaignName: c.campaignName,
      metrics: entry?.metrics ?? { impressions: 0, clicks: 0, spend: 0, leads: 0, costPerLead: 0 },
    }
  })

  const input: AnalystInput = {
    window: { start: start.toISOString(), end: end.toISOString() },
    campaigns,
  }

  // 6. Invoke the analyst agent.
  let analystOutput: AnalystOutput
  try {
    const text = await invokeAgent(input)
    analystOutput = parseAnalystResponse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[analyst-cron] agent invocation failed: ${message}`)
    return {
      campaignsProcessed: campaigns.length,
      recommendations: [],
      stagedDrafts: [],
      errors: [...errors, `agent_invocation_failed: ${message}`],
      snapshotsCollected,
    }
  }

  // 7. Process each campaign recommendation.
  const stagedDrafts: Array<{ campaignId: string; status: string; draftId: string }> = []

  for (const rec of analystOutput.campaigns ?? []) {
    if (rec.recommendation === 'hold') {
      console.log(`[analyst-cron] hold: ${rec.campaignId} — ${analystOutput.message}`)
      continue
    }

    const status = rec.recommendation === 'scale' ? 'ACTIVE' : 'PAUSED'

    // An unattributed draft is not a smaller approval, it is no approval: the
    // insert fails on requested_by before anybody can review it. Report the
    // recommendation, say plainly that nothing was staged, and count it in errors
    // so the summary line cannot read "0 error(s)" over a run that staged nothing.
    if (!args.analystUserId) {
      errors.push(`not_staged_no_actor: ${rec.campaignId}`)
      console.log(
        `[analyst-cron] ${rec.recommendation} for ${rec.campaignId} was not staged (${rec.reason}): CRUM_ANALYST_USER_ID is unset, so no owner could be named as the requester`,
      )
      continue
    }
    try {
      const draftId = await stageStatus({
        tenantId: args.tenantId,
        userId: args.analystUserId,
        bundleId: rec.bundleId,
        campaignExternalId: rec.campaignId,
        status,
        reason: rec.reason,
        userRole: 'campaign-analyst',
      })
      stagedDrafts.push({ campaignId: rec.campaignId, status, draftId })
      console.log(`[analyst-cron] staged ${status} draft ${draftId} for ${rec.campaignId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`stage_failed: ${rec.campaignId}: ${message}`)
      console.error(`[analyst-cron] stage failed for ${rec.campaignId}: ${message}`)
    }
  }

  return {
    campaignsProcessed: campaigns.length,
    recommendations: analystOutput.campaigns ?? [],
    stagedDrafts,
    errors,
    snapshotsCollected,
  }
}

/**
 * The default agent invocation. Calls `campaignAnalystAgent.generate` with a
 * JSON prompt and returns the text response.
 */
async function defaultInvokeAgent(input: AnalystInput): Promise<string> {
  const prompt =
    'Analyse the following campaign metrics for the past 7 days and give your recommendation.\n\n' +
    JSON.stringify(input, null, 2)
  const result = await campaignAnalystAgent.generate(prompt)
  return result.text
}

async function main(): Promise<void> {
  const envPath = new URL('../.env', import.meta.url)
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const env = parseEnv()
  if (!env.DATABASE_URL) {
    console.error('[analyst-cron] DATABASE_URL is unset; the analyst has no database to read.')
    process.exit(1)
  }

  const opts = parseArgs(process.argv.slice(2))
  const tenantId = opts.tenantId ?? process.env.CRUM_TENANT_ID ?? ''
  if (!tenantId) {
    console.error('[analyst-cron] tenant ID required: pass --tenant <uuid> or set CRUM_TENANT_ID')
    process.exit(1)
  }

  // Build the metrics readback config from env. When the access token is absent
  // the cron falls back to using only pre-existing snapshots (useful for local
  // dev or when Meta credentials are not provisioned on the scheduler host).
  const metaToken = env.CRUM_META_ADS_ACCESS_TOKEN ?? null
  const metricsReadback: MetricsReadbackConfig | null = metaToken
    ? { accessToken: metaToken }
    : null
  if (!metricsReadback) {
    console.warn('[analyst-cron] CRUM_META_ADS_ACCESS_TOKEN is unset; skipping live metrics collection')
  }

  // Staging now asks whether this process can run the action it is queuing, so a
  // cron with a configured Meta lane has to say so in its own registry. The
  // adapter is never executed from here; the drainer does that.
  const statusConfig = statusAdapterConfigFromEnv(env)
  if (statusConfig) {
    registerActionAdapter(makeSetCampaignStatusAdapter(statusConfig))
  } else {
    console.warn(
      '[analyst-cron] no set_campaign_status adapter in this process; a scale or kill recommendation will refuse to stage rather than queue work nothing can run',
    )
  }

  // The requester of a staged draft is a column that means who asked, so a run
  // without this cannot produce an approvable row. Warn before the work rather
  // than let a silent run report "0 draft(s) staged" as if nothing were missing.
  const analystUserId = env.CRUM_ANALYST_USER_ID ?? null
  if (!analystUserId) {
    console.warn(
      '[analyst-cron] CRUM_ANALYST_USER_ID is unset; recommendations will be reported but never staged',
    )
  }

  try {
    const result = await runAnalystCron({ tenantId, metricsReadback, analystUserId })
    console.log(
      `[analyst-cron] done: ${result.campaignsProcessed} campaign(s), ` +
        `${result.snapshotsCollected} snapshot(s) collected, ` +
        `${result.stagedDrafts.length} draft(s) staged, ` +
        `${result.errors.length} error(s)`,
    )
  } catch (err) {
    console.error('[analyst-cron] fatal:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  } finally {
    await closeDbClient()
  }
}

// Only run main when executed directly, not when imported by tests.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('analyst-cron.ts') || process.argv[1].endsWith('analyst-cron'))
if (isDirectRun) {
  void main()
}

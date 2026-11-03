// tests/integration/analyst-cron.test.ts
//
// Integration tests for the analyst cron script. These tests exercise the full
// runAnalystCron function against a real Postgres, verifying that snapshots are
// aggregated correctly, the agent is invoked with the right input, and drafts
// are staged for scale/kill recommendations.
//
// Same lazy contract as the other integration files: no URL, no run, and the
// skip is reported rather than faked.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDbClient, getDbClient } from '../../src/db/client'
import type { MetricsReadbackConfig, MetricsReadbackResult } from '../../src/marketing/metrics-readback'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { uuidFromSeed } from '../../src/marketing/hash'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-analyst-cron-secret-0123456789'

const TENANT = 'a4000000-0000-4000-8000-000000000020'
const BUNDLE_A = 'b4000000-0000-4000-8000-000000000020'
const BUNDLE_B = 'b4000000-0000-4000-8000-000000000021'
const CAMPAIGN_A = 'camp-ext-20-a'
const CAMPAIGN_B = 'camp-ext-20-b'
// The owner the cron names as the requester of a staged draft. requested_by is a
// uuid column that means who asked, so this file has to carry a person, and
// CRUM_ANALYST_USER_ID is where the real cron gets one.
const ANALYST = 'c4000000-0000-4000-8000-000000000020'

// Staging now refuses an action this process has no adapter for, so the cases
// below that expect a draft need one present. It never runs here: the drainer is
// not part of this file, and an adapter that would talk to Meta never belongs in a
// test (the standing rule).
let unregisterStatus: () => void = () => {}

async function setupFixtures() {
  const db = getDbClient()

  // Clean up any prior run.
  await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_actions WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_artifacts WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_bundles WHERE tenant_id = $1`, [TENANT])

  // Insert two bundles.
  await db.query(
    `INSERT INTO marketing_bundles
       (id, tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
     VALUES
       ($1, $2, 'Analyst cron test A', 'inbound_leads', 'live', $3, 'marketing-v1', 'hash-a'),
       ($4, $2, 'Analyst cron test B', 'outreach_support', 'live', $5, 'marketing-v1', 'hash-b')`,
    [
      BUNDLE_A, TENANT,
      JSON.stringify({ page: { slug: 'analyst-a' } }),
      BUNDLE_B,
      JSON.stringify({ page: { slug: 'analyst-b' } }),
    ],
  )

  // Insert succeeded create_campaign actions for both.
  await db.query(
    `INSERT INTO marketing_actions
       (tenant_id, bundle_id, action, status, payload, result, attempts)
     VALUES
       ($1, $2, 'create_campaign', 'succeeded', $3, $4, 1),
       ($1, $5, 'create_campaign', 'succeeded', $6, $7, 1)`,
    [
      TENANT, BUNDLE_A,
      JSON.stringify({ adAccountId: 'act_123' }),
      JSON.stringify({ externalId: CAMPAIGN_A }),
      BUNDLE_B,
      JSON.stringify({ adAccountId: 'act_456' }),
      JSON.stringify({ externalId: CAMPAIGN_B }),
    ],
  )
}

async function insertSnapshot(params: {
  bundleId: string
  campaignExternalId: string
  metrics: unknown
  daysAgo?: number
}) {
  const db = getDbClient()
  const daysAgo = params.daysAgo ?? 1
  // The snapshot's own window has to START inside the cron's lookback, because
  // listRecentSnapshots filters `window_start >= now() - 7 days`
  // (src/db/marketing-metrics.ts:124). This helper used to build a full seven-day
  // window and then shift both ends backwards by daysAgo, which pushed every
  // window_start past the boundary, so the aggregation case was asserting totals
  // over rows the query could not return and read zero. A one-day window that ends
  // daysAgo days ago stays inside for every daysAgo this file uses.
  //
  // The green case below is not evidence that the lookback is right. Production
  // writes a seven-day window (analyst-cron.ts:251 computes start as now - 7d and
  // :283 inserts it), so a run's own fresh snapshot starts seconds outside the
  // filter and is invisible to the run that wrote it; that is a defect in the query
  // or the stamp, not in this fixture, and fixing it would change what the analyst
  // sees. It is carried to the final review, and this file deliberately keeps a
  // window shape production does not write so that the aggregation logic has
  // something visible to aggregate. Read the passing case as "totals add up", not
  // "the lookback works".
  const windowEnd = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000)

  await db.query(
    `INSERT INTO marketing_metrics_snapshots
       (tenant_id, bundle_id, campaign_external_id, window_start, window_end, metrics)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [TENANT, params.bundleId, params.campaignExternalId, windowStart.toISOString(), windowEnd.toISOString(), JSON.stringify(params.metrics)],
  )
}

async function countPendingWrites(targetId: string): Promise<number> {
  const db = getDbClient()
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`,
    [TENANT, targetId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

afterAll(async () => {
  unregisterStatus()
  if (!url) return
  const db = getDbClient()
  await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_actions WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])
  await db.query(`DELETE FROM marketing_bundles WHERE tenant_id = $1`, [TENANT])
  await closeDbClient()
})

describe.skipIf(!url)('analyst cron', () => {
  beforeAll(async () => {
    // Staging a status draft asks whether this process can run the action, so the
    // staging cases need an adapter registered. The cron gets its own in main(),
    // built from CRUM_META_ADS_ACCESS_TOKEN and CRUM_META_AD_ACCOUNTS by
    // statusAdapterConfigFromEnv (scripts/analyst-cron.ts:206, unit-covered in
    // tests/scripts/analyst-cron-config.test.ts), which this file does not run: the
    // cases call runAnalystCron directly with an injected agent, so the
    // registration here stands in for main()'s. It is a stub on purpose, and
    // nothing reaches Meta: the drainer never runs in this file and the stub answers
    // without a network. The case below that unregisters again is what pins the
    // difference between "registered" and "refused".
    unregisterStatus = registerActionAdapter({
      name: 'set_campaign_status',
      execute: () => Promise.resolve({ externalId: 'analyst-cron-test-stub' }),
    })
    await setupFixtures()
  })

  it('runs successfully with no active campaigns when snapshots are absent', async () => {
    // Remove campaigns so listActiveCampaigns returns empty.
    const db = getDbClient()
    await db.query(`DELETE FROM marketing_actions WHERE tenant_id = $1 AND action = 'create_campaign'`, [TENANT])

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () => Promise.resolve('{"recommendation":"hold","threshold":"","message":"no campaigns","campaigns":[]}'),
    })

    expect(result.campaignsProcessed).toBe(0)
    expect(result.stagedDrafts).toEqual([])
    expect(result.errors).toEqual([])

    // Re-insert for subsequent tests.
    await db.query(
      `INSERT INTO marketing_actions
         (tenant_id, bundle_id, action, status, payload, result, attempts)
       VALUES
         ($1, $2, 'create_campaign', 'succeeded', $3, $4, 1),
         ($1, $5, 'create_campaign', 'succeeded', $6, $7, 1)`,
      [
        TENANT, BUNDLE_A,
        JSON.stringify({ adAccountId: 'act_123' }),
        JSON.stringify({ externalId: CAMPAIGN_A }),
        BUNDLE_B,
        JSON.stringify({ adAccountId: 'act_456' }),
        JSON.stringify({ externalId: CAMPAIGN_B }),
      ],
    )
  })

  it('aggregates metrics correctly from multiple snapshots', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])

    // Insert two snapshots for campaign A.
    await insertSnapshot({
      bundleId: BUNDLE_A,
      campaignExternalId: CAMPAIGN_A,
      metrics: {
        data: [
          { impressions: '500', clicks: '20', spend: '10.00', actions: [{ action_type: 'lead', value: '3' }] },
        ],
      },
      daysAgo: 1,
    })
    await insertSnapshot({
      bundleId: BUNDLE_A,
      campaignExternalId: CAMPAIGN_A,
      metrics: {
        data: [
          { impressions: '300', clicks: '15', spend: '8.00', actions: [{ action_type: 'lead', value: '2' }] },
        ],
      },
      daysAgo: 3,
    })

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    let capturedInput: unknown = null
    await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: (input) => {
        capturedInput = input
        return Promise.resolve('{"recommendation":"hold","threshold":"","message":"ok","campaigns":[{"bundleId":"' + BUNDLE_A + '","campaignId":"' + CAMPAIGN_A + '","recommendation":"hold","reason":"ok"}]}')
      },
    })

    const inputObj = capturedInput as { campaigns: Array<{ campaignId: string; metrics: { impressions: number; clicks: number; spend: number; leads: number; costPerLead: number } }> }
    const campA = inputObj.campaigns.find((c) => c.campaignId === CAMPAIGN_A)
    expect(campA).toBeDefined()
    expect(campA!.metrics.impressions).toBe(800)
    expect(campA!.metrics.clicks).toBe(35)
    expect(campA!.metrics.spend).toBeCloseTo(18.0)
    expect(campA!.metrics.leads).toBe(5)
    expect(campA!.metrics.costPerLead).toBeCloseTo(3.6)
  })

  it('invokes the analyst agent with the correct input shape', async () => {
    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    let capturedInput: unknown = null

    await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: (input) => {
        capturedInput = input
        return Promise.resolve('{"recommendation":"hold","threshold":"","message":"ok","campaigns":[]}')
      },
    })

    const inputObj = capturedInput as { window: { start: string; end: string }; campaigns: unknown[] }
    expect(inputObj).toBeDefined()
    expect(inputObj.window).toBeDefined()
    expect(inputObj.window.start).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(inputObj.window.end).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Array.isArray(inputObj.campaigns)).toBe(true)
    expect(inputObj.campaigns.length).toBeGreaterThan(0)
  })

  it('stages a draft for a "scale" recommendation', async () => {
    const db = getDbClient()
    // target_id is a uuid and the draft is keyed by the id derived from Meta's,
    // so this file has to address the derived one or the cast fails before the
    // case can say anything about staging.
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_A}`),
    ])

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      analystUserId: ANALYST,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"scale","threshold":"cost_per_lead_below_5","message":"Scale it","campaigns":[{"bundleId":"' + BUNDLE_A + '","campaignId":"' + CAMPAIGN_A + '","recommendation":"scale","reason":"cost_per_lead_below_5"}]}'),
    })

    expect(result.stagedDrafts.length).toBe(1)
    expect(result.stagedDrafts[0]!.status).toBe('ACTIVE')
    expect(result.stagedDrafts[0]!.campaignId).toBe(CAMPAIGN_A)

    const draftCount = await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_A}`))
    expect(draftCount).toBeGreaterThanOrEqual(1)

    // The columns the fix is about, read back from the row the insert wrote. The
    // unit file can only show what the function handed the data layer.
    const stored = await db.query<{ target_id: string; requested_by: string; payload: { campaignId: string } }>(
      `SELECT target_id, requested_by, payload FROM pending_writes
        WHERE tenant_id = $1 AND target_id = $2`,
      [TENANT, uuidFromSeed(`campaign:${CAMPAIGN_A}`)],
    )
    expect(stored.rows[0]?.requested_by).toBe(ANALYST)
    expect(stored.rows[0]?.target_id).toBe(uuidFromSeed(`campaign:${CAMPAIGN_A}`))
    // The id the adapter will need is the real one, not the derived key.
    expect(stored.rows[0]?.payload.campaignId).toBe(CAMPAIGN_A)
  })

  it('stages a draft for a "kill" recommendation', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_B}`),
    ])

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      analystUserId: ANALYST,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"kill","threshold":"cost_per_lead_above_20","message":"Kill it","campaigns":[{"bundleId":"' + BUNDLE_B + '","campaignId":"' + CAMPAIGN_B + '","recommendation":"kill","reason":"cost_per_lead_above_20"}]}'),
    })

    expect(result.stagedDrafts.length).toBe(1)
    expect(result.stagedDrafts[0]!.status).toBe('PAUSED')
    expect(result.stagedDrafts[0]!.campaignId).toBe(CAMPAIGN_B)

    const draftCount = await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_B}`))
    expect(draftCount).toBeGreaterThanOrEqual(1)
  })

  it('reports a recommendation it cannot stage because no owner is named', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_A}`),
    ])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"scale","threshold":"cost_per_lead_below_5","message":"Scale it","campaigns":[{"bundleId":"' + BUNDLE_A + '","campaignId":"' + CAMPAIGN_A + '","recommendation":"scale","reason":"cost_per_lead_below_5"}]}'),
    })

    // An unattributed draft is no approval at all, so nothing is staged, and the
    // run says so in its error count rather than reading as a clean nothing-to-do.
    expect(result.stagedDrafts).toEqual([])
    expect(result.errors).toContain(`not_staged_no_actor: ${CAMPAIGN_A}`)
    const why = logSpy.mock.calls.map((call) => String(call[0] ?? '')).filter((line) => line.includes('CRUM_ANALYST_USER_ID is unset'))
    expect(why.length).toBe(1)
    // The analyst's own reason reaches the log, because the recommendation is the
    // only thing an operator without a configured actor gets to act on.
    expect(why[0]).toContain('cost_per_lead_below_5')
    expect(await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_A}`))).toBe(0)

    logSpy.mockRestore()
  })

  it('reports a recommendation it cannot stage because this process cannot run the action', async () => {
    // The other half of the actor refusal: an owner named is not enough if the
    // action has no adapter here, because the drainer would then be handed work it
    // records as no_adapter. The cron clears this door only because main()
    // registers the Meta adapter from its own env, so the refusal is pinned in the
    // shape a reader can run: a real recommendation, a real actor, nothing
    // registered, and a counted error rather than a draft nobody can approve.
    const db = getDbClient()
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_B}`),
    ])

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    unregisterStatus()

    try {
      const { runAnalystCron } = await import('../../scripts/analyst-cron')
      const result = await runAnalystCron({
        tenantId: TENANT,
        analystUserId: ANALYST,
        invokeAgent: () =>
          Promise.resolve('{"recommendation":"kill","threshold":"cost_per_lead_above_20","message":"Kill it","campaigns":[{"bundleId":"' + BUNDLE_B + '","campaignId":"' + CAMPAIGN_B + '","recommendation":"kill","reason":"cost_per_lead_above_20"}]}'),
      })

      expect(result.stagedDrafts).toEqual([])
      expect(result.errors.filter((entry) => entry.includes('provider_not_configured')).length).toBe(1)
      expect(result.errors[0]).toContain(CAMPAIGN_B)
      expect(await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_B}`))).toBe(0)
    } finally {
      // Restore what the cases after this one depend on, and leave the single
      // cleanup in afterAll holding the current handle.
      unregisterStatus = registerActionAdapter({
        name: 'set_campaign_status',
        execute: () => Promise.resolve({ externalId: 'analyst-cron-test-stub' }),
      })
      errSpy.mockRestore()
    }
  })

  it('logs message for "hold" recommendation without staging a draft', async () => {
    const db = getDbClient()
    // Clean all pending writes.
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1`, [TENANT])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"hold","threshold":"","message":"Looking good","campaigns":[{"bundleId":"' + BUNDLE_A + '","campaignId":"' + CAMPAIGN_A + '","recommendation":"hold","reason":"metrics_ok"}]}'),
    })

    expect(result.stagedDrafts.length).toBe(0)
    expect(result.errors.length).toBe(0)

    // Verify the hold message was logged.
    const holdLogs = logSpy.mock.calls.filter((c) => String(c[0] ?? '').includes('hold'))
    expect(holdLogs.length).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('handles analyst agent failure gracefully', async () => {
    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () => {
        return Promise.reject(new Error('model_unavailable'))
      },
    })

    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('agent_invocation_failed')
    expect(result.stagedDrafts.length).toBe(0)
  })

  it('collects metrics from Meta API and inserts snapshots when metricsReadback is provided', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])

    // Mock readCampaignMetrics to return fake data for each ad account.
    const mockReadResult: MetricsReadbackResult = {
      data: [
        {
          campaign_name: 'Test Campaign',
          impressions: '1000',
          clicks: '50',
          spend: '25.00',
          actions: [{ action_type: 'lead', value: '5' }],
          date_start: '2026-10-24',
          date_stop: '2026-10-31',
        },
      ],
    }

    const mockConfig: MetricsReadbackConfig = {
      accessToken: 'test-token',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: mockReadResult.data }),
      }),
    }

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      metricsReadback: mockConfig,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"hold","threshold":"","message":"ok","campaigns":[]}'),
    })

    // Both campaigns should have been collected.
    expect(result.snapshotsCollected).toBe(2)
    expect(result.errors).toEqual([])

    // Verify snapshots were inserted into the database.
    const snapResult = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM marketing_metrics_snapshots WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(Number(snapResult.rows[0]!.count)).toBe(2)
  })

  it('skips live collection when metricsReadback is null', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      metricsReadback: null,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"hold","threshold":"","message":"ok","campaigns":[]}'),
    })

    expect(result.snapshotsCollected).toBe(0)
    expect(result.errors).toEqual([])

    // Verify the skip message was logged.
    const skipLogs = logSpy.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('skipping live collection'),
    )
    expect(skipLogs.length).toBeGreaterThan(0)

    // No snapshots should have been inserted.
    const snapResult = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM marketing_metrics_snapshots WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(Number(snapResult.rows[0]!.count)).toBe(0)

    logSpy.mockRestore()
  })

  it('records errors when metrics collection fails for a campaign', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM marketing_metrics_snapshots WHERE tenant_id = $1`, [TENANT])

    // Mock fetch to simulate an API error.
    const mockConfig: MetricsReadbackConfig = {
      accessToken: 'test-token',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { message: 'Invalid access token', type: 'OAuthException', code: 190 },
          }),
      }),
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      metricsReadback: mockConfig,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"hold","threshold":"","message":"ok","campaigns":[]}'),
    })

    // Both campaigns should have failed.
    expect(result.snapshotsCollected).toBe(0)
    expect(result.errors.length).toBe(2)
    expect(result.errors[0]).toContain('metrics_collection_failed')

    errorSpy.mockRestore()
  })
})

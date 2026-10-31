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

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-analyst-cron-secret-0123456789'

const TENANT = 'a4000000-0000-4000-8000-000000000020'
const BUNDLE_A = 'b4000000-0000-4000-8000-000000000020'
const BUNDLE_B = 'b4000000-0000-4000-8000-000000000021'
const CAMPAIGN_A = 'camp-ext-20-a'
const CAMPAIGN_B = 'camp-ext-20-b'

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
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000)
  // Shift both by daysAgo so the snapshot falls within the 7-day lookback.
  windowStart.setDate(windowStart.getDate() - daysAgo)
  windowEnd.setDate(windowEnd.getDate() - daysAgo)

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
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [TENANT, CAMPAIGN_A])

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"scale","threshold":"cost_per_lead_below_5","message":"Scale it","campaigns":[{"bundleId":"' + BUNDLE_A + '","campaignId":"' + CAMPAIGN_A + '","recommendation":"scale","reason":"cost_per_lead_below_5"}]}'),
    })

    expect(result.stagedDrafts.length).toBe(1)
    expect(result.stagedDrafts[0]!.status).toBe('ACTIVE')
    expect(result.stagedDrafts[0]!.campaignId).toBe(CAMPAIGN_A)

    const draftCount = await countPendingWrites(CAMPAIGN_A)
    expect(draftCount).toBeGreaterThanOrEqual(1)
  })

  it('stages a draft for a "kill" recommendation', async () => {
    const db = getDbClient()
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [TENANT, CAMPAIGN_B])

    const { runAnalystCron } = await import('../../scripts/analyst-cron')
    const result = await runAnalystCron({
      tenantId: TENANT,
      invokeAgent: () =>
        Promise.resolve('{"recommendation":"kill","threshold":"cost_per_lead_above_20","message":"Kill it","campaigns":[{"bundleId":"' + BUNDLE_B + '","campaignId":"' + CAMPAIGN_B + '","recommendation":"kill","reason":"cost_per_lead_above_20"}]}'),
    })

    expect(result.stagedDrafts.length).toBe(1)
    expect(result.stagedDrafts[0]!.status).toBe('PAUSED')
    expect(result.stagedDrafts[0]!.campaignId).toBe(CAMPAIGN_B)

    const draftCount = await countPendingWrites(CAMPAIGN_B)
    expect(draftCount).toBeGreaterThanOrEqual(1)
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
})

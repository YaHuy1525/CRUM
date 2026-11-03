/**
 * tests/integration/marketing-campaign-status.test.ts
 *
 * Spec proof 4 for slice 5: an owner approving the analyst's campaign status
 * draft produces a queued work order, and the drainer runs it. Before Task 16
 * `marketing_set_campaign_status` had no branch in applyDraft, so the approval
 * reached `requireTarget`, threw `UnsupportedCommitError`, the click 500ed and
 * the campaign stayed paused with its draft open.
 *
 * Nothing leaves the machine. The Meta call goes through a local `fetchImpl`
 * stand-in that records its arguments and answers `{ success: true }`: the point
 * is to see the URL and the body the adapter would have sent, not to send them.
 * No real token appears anywhere in this file.
 *
 * Ids are in the `a5` band on purpose: the integration database is shared across
 * files and Vitest runs them in parallel workers, so a tenant no other file
 * touches is what keeps these counts honest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient } from '../../src/db/client'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { makeSetCampaignStatusAdapter } from '../../src/marketing/meta-ads'
import { commitWithReceipt, getPendingWrite } from '../../src/db/pending-writes'
import { stageCampaignStatusChange } from '../../src/mastra/tools/marketing-writes'
import { drainOnce } from '../../scripts/publish-drain'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
// commitWithReceipt signs a real receipt, and signReceipt refuses to run without
// this. A test secret, not a credential.
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-campaign-status-secret-0123456789'

const TENANT = 'a5000000-0000-4000-8000-000000000030'
const BUNDLE = 'b5000000-0000-4000-8000-000000000030'
// The uuid `stageCampaignStatusChange` writes into requested_by: a label is not a
// person and the column is a uuid (R-36).
const ANALYST = 'c5000000-0000-4000-8000-000000000030'
const APPROVER = 'd5000000-0000-4000-8000-000000000030'
// A Meta campaign id: decimal, not a uuid, which is why the draft's target_id is
// the derived one and the real id travels in payload.campaignId.
const CAMPAIGN = '23842653876'

// What the adapter would have put on the wire, captured instead of sent.
const fetched: Array<{ url: string; body: string; method: string }> = []

/**
 * The Meta call, recorded and answered locally: no request leaves the machine.
 * The `Response` is constructed here rather than fetched, so the adapter reads a
 * real 200 with `{ success: true }` and the drainer records a real success, which
 * is the whole point — the assertion is on the URL and body it *would* send.
 */
function recordingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  fetched.push({
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    body: typeof init?.body === 'string' ? init.body : '',
    method: init?.method ?? 'GET',
  })
  return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
}

describe.skipIf(!url)('approving a campaign status draft queues the work order', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
    // Only this tenant's rows, so a previous failed run cannot decide these counts.
    await pool.query(`DELETE FROM audit_receipts WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM pending_writes WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM marketing_actions WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM marketing_bundles WHERE tenant_id = $1`, [TENANT])

    await pool.query(
      `INSERT INTO marketing_bundles
         (id, tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, $2, 'A brief long enough to pass the tool floor for this proof', 'inbound_leads',
               'live', jsonb_build_object('page', jsonb_build_object('slug','campaign-status-proof')),
               'v1', 'campaign-status-proof')`,
      [BUNDLE, TENANT],
    )
    // The campaign this tenant created and that is still paused: a succeeded
    // create_campaign whose result names the external id, and whose payload
    // carries the ad account the analyst reads back.
    await pool.query(
      `INSERT INTO marketing_actions
         (tenant_id, bundle_id, action, status, payload, result, attempts)
       VALUES ($1, $2, 'create_campaign', 'succeeded', $3, $4, 1)`,
      [TENANT, BUNDLE, JSON.stringify({ adAccountId: 'act_123' }), JSON.stringify({ externalId: CAMPAIGN })],
    )
  })

  afterAll(async () => {
    if (!url) return
    await pool.query(`DELETE FROM audit_receipts WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM pending_writes WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM marketing_actions WHERE tenant_id = $1`, [TENANT])
    await pool.query(`DELETE FROM marketing_bundles WHERE tenant_id = $1`, [TENANT])
    await pool.end()
    await closeDbClient()
  })

  it('queues one work order over the approved receipt, and the drainer runs it', async () => {
    // One registration covers both halves of the proof. Staging asks whether this
    // process can run the action at all (the executability guard), and the drain
    // below looks the same name up in the same map, so the adapter the analyst
    // cron would install is registered here with the local fetch stand-in.
    const unregister = registerActionAdapter(
      makeSetCampaignStatusAdapter({
        accessToken: 'test-token',
        adAccounts: ['act_123'],
        fetchImpl: recordingFetch,
      }),
    )

    try {
      const draftId = await stageCampaignStatusChange({
        tenantId: TENANT,
        userId: ANALYST,
        bundleId: BUNDLE,
        campaignExternalId: CAMPAIGN,
        status: 'ACTIVE',
        reason: 'cost_per_lead_below_5',
        userRole: 'admin',
      })

      const draft = await getPendingWrite(draftId, TENANT)
      if (!draft) throw new Error('the staged status draft is not visible to its own tenant')
      expect(draft.objectType).toBe('marketing_set_campaign_status')
      expect(draft.operation).toBe('update')
      // Identifiers and a status only: the reason prose the analyst wrote stays out
      // of the scored payload (spec section 5).
      expect(draft.payload).toEqual({ campaignId: CAMPAIGN, status: 'ACTIVE' })

      const { committedId, receiptId } = await commitWithReceipt(draft, {
        approvedBy: APPROVER,
        scope: 'marketing:status',
      })

      const queued = await pool.query<{
        id: string
        status: string
        receipt_id: string | null
        payload: Record<string, unknown>
        bundle_id: string
      }>(
        `SELECT id, status, receipt_id, payload, bundle_id FROM marketing_actions
          WHERE tenant_id = $1 AND bundle_id = $2 AND action = 'set_campaign_status'`,
        [TENANT, BUNDLE],
      )
      // Exactly one work order for one approval, and nothing else was queued.
      expect(queued.rows).toHaveLength(1)
      const action = queued.rows[0]!
      expect(action.status).toBe('queued')
      expect(action.bundle_id).toBe(BUNDLE)
      // NULL, not the receipt id: commitWithReceipt signs after applyDraft returns.
      expect(action.receipt_id).toBeNull()
      // The pair the adapter addresses Meta with, read back from the row.
      expect(action.payload).toEqual({ campaignId: CAMPAIGN, status: 'ACTIVE' })
      expect(committedId).toBe(action.id)

      // The receipt names the work order it signed, which is the trace a reviewer
      // needs to get from an approval to the row the drainer ran.
      const receipt = await pool.query<{ committed_record_id: string; scope: string }>(
        `SELECT committed_record_id, scope FROM audit_receipts WHERE id = $1 AND tenant_id = $2`,
        [receiptId, TENANT],
      )
      expect(receipt.rows[0]?.committed_record_id).toBe(action.id)
      expect(receipt.rows[0]?.scope).toBe('marketing:status')

      // The drainer, scoped to this bundle: the integration database is shared and
      // an unscoped pass would claim other files' queued rows.
      const drained = await drainOnce({ pool, bundleId: BUNDLE })
      expect(drained.succeeded).toBe(1)

      expect(fetched).toHaveLength(1)
      expect(fetched[0]!.method).toBe('POST')
      // The real id from the payload, not the derived uuid in target_id.
      expect(fetched[0]!.url.endsWith(`/${CAMPAIGN}`)).toBe(true)
      expect(fetched[0]!.body).toBe(JSON.stringify({ status: 'ACTIVE' }))

      const after = await pool.query<{ status: string; external_id: string; result: Record<string, unknown> }>(
        `SELECT status, external_id, result FROM marketing_actions WHERE id = $1`,
        [action.id],
      )
      expect(after.rows[0]?.status).toBe('succeeded')
      expect(after.rows[0]?.external_id).toBe(CAMPAIGN)
      expect(after.rows[0]?.result.success).toBe(true)
    } finally {
      unregister()
    }
  })
})

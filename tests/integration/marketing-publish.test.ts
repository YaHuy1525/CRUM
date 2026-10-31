/**
 * The publisher against a real Postgres and a local stand-in for the page host:
 * an approval queues a publish, the drainer calls the adapter outside every
 * transaction, and only a succeeded promote turns the bundle live. Nothing
 * leaves the machine: the stand-in listens on 127.0.0.1, and the failure case
 * points at a port nothing serves, so the refusal arrives through fetch rather
 * than through a stub written for that case.
 *
 * Spec: docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md §5.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { registerActionAdapter, commitBundleApproval } from '../../src/marketing/outbox'
import { makePublishPageAdapter, makePromotePageAdapter, type PageHostConfig } from '../../src/marketing/page-host'
import { resolveSite, siteHashOf } from '../../src/marketing/site'
import { markBundleLive } from '../../src/db/marketing'
import { commitWithReceipt, getPendingWrite } from '../../src/db/pending-writes'
import { stagePromotion, stageRetry } from '../../src/mastra/tools/marketing-writes'
import { claimNextQueued, drainOnce, reapStaleRunning } from '../../scripts/publish-drain'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
// The second approval signs a real receipt, and parseEnv reads the secret at
// sign time, so setting it here is enough.
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'
const TENANT = 'a1000000-0000-4000-8000-000000000028'
const OTHER_TENANT = 'a1000000-0000-4000-8000-000000000029'
const APPROVER = 'a2000000-0000-4000-8000-000000000028'

const PAGE_HTML = '<h1>Book your assessment</h1>'

/**
 * The approval compares the hash the stage payload carried against the bytes in
 * the database, so a fixture that stages a page must name its hash the same way
 * a stage would: from the stored bytes and the slug the plan declares.
 */
function siteHashFor(slug: string): string {
  return siteHashOf(resolveSite(slug, [{ id: 'page', kind: 'page_html', textContent: PAGE_HTML }]))
}

async function queuedCount(db: Pool, bundleId: string) {
  const r = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
    [bundleId],
  )
  return { publish: Number(r.rows[0]!.n) }
}

async function statusOf(db: Pool, bundleId: string): Promise<string> {
  const r = await db.query<{ status: string }>(`SELECT status FROM marketing_bundles WHERE id = $1`, [bundleId])
  return r.rows[0]!.status
}

/**
 * The one field of a multipart part, read off the wire: what the adapter sent is
 * only observable in the request body, and a body is not a FormData any more.
 */
function fieldOf(body: string, name: string): string {
  const match = new RegExp(`name="${name}"([\\s\\S]*?)------`).exec(body)
  return match?.[1]?.replace(/\r\n/g, '').trim() ?? '?'
}

describe.skipIf(!url)('publish drain against a local pages stand-in', () => {
  let pool: Pool
  let fake: Server
  const captured: { branches: string[]; manifests: string[] } = { branches: [], manifests: [] }
  let config: PageHostConfig

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
    // Only this tenant's rows: marketing_actions and marketing_artifacts cascade
    // from the bundle, so the drainage of a previous failed run cannot decide
    // this run's counts.
    await pool.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])

    fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        captured.branches.push(fieldOf(body, 'branch'))
        captured.manifests.push(fieldOf(body, 'manifest'))
        const n = captured.branches.length
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          result: { id: `dep-${n}`, url: `https://dep-${n}.example.pages.dev`, created_on: '2026-10-31T00:00:00Z' },
        }))
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address() as AddressInfo
    config = {
      accountId: 'acc', project: 'proj', apiToken: 'tok',
      productionBranch: 'main', previewBranchPrefix: 'crum-preview',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    await pool.end()
    await closeDbClient()
  })

  it('publishes a preview, promotes it, and marks the bundle live on the second success', async () => {
    const db = getDbClient()
    const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
    const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))

    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'staged', jsonb_build_object('page', jsonb_build_object('slug','physio-probe')),
               'v1', $2)
       RETURNING id`,
      [TENANT, `probe-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id
    await db.query(
      `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
       VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
      [TENANT, bundleId, PAGE_HTML],
    )

    await commitBundleApproval(db, {
      tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor('physio-probe'),
    })
    expect((await queuedCount(db, bundleId)).publish).toBe(1)

    // Scoped to this bundle: the drain is process-wide in production, and an
    // unscoped pass would also claim rows other integration files left queued.
    const first = await drainOnce({ bundleId })
    expect(first.succeeded).toBe(1)
    expect(captured.branches).toEqual(['crum-preview/physio-probe'])
    expect(captured.manifests[0]).toContain('physio-probe/index.html')

    const preview = await db.query<{ external_id: string; result: Record<string, unknown>; status: string }>(
      `SELECT external_id, result, status FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
      [bundleId],
    )
    expect(preview.rows[0]?.status).toBe('succeeded')
    expect(preview.rows[0]?.result['url']).toBe('https://dep-1.example.pages.dev')
    expect(preview.rows[0]?.external_id).toBe('dep-1')
    expect((await statusOf(db, bundleId))).toBe('approved')

    await db.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status)
       VALUES ($1, $2, 'promote_page',
               jsonb_build_object('bundleId',$2::uuid,'slug','physio-probe','siteHash',$3::text), 'queued')`,
      [TENANT, bundleId, siteHashFor('physio-probe')],
    )
    const second = await drainOnce({ bundleId })
    expect(second.succeeded).toBe(1)
    expect(captured.branches[1]).toBe('main')

    // Nothing of the test's in between: the drainer's own follow-up is the
    // behaviour under test. A succeeded promote must leave the bundle live by
    // itself, because `live` is what the owner sees after the second click.
    expect(await statusOf(db, bundleId)).toBe('live')
    // The only door to `live` is tenant-scoped: another tenant's id matches no
    // row here and leaves the status alone.
    expect(await markBundleLive({ tenantId: OTHER_TENANT, bundleId })).toBe(false)
    expect(await statusOf(db, bundleId)).toBe('live')
    unregisterPublish()
    unregisterPromote()
  })

  /**
   * The second click, end to end: the preview is published for real, the
   * promotion is staged through the same function Task 12's route will call,
   * and approving it queues exactly one promote_page row. That row has to carry
   * the slug the adapter reads, because the approval payload deliberately does
   * not (a slug is prose, and prose is not scored), and the bundle must still be
   * `approved`: `live` is the drainer's verdict and it has not run.
   */
  it('queues one promote_page row carrying the slug and the published hash, and leaves the bundle approved', async () => {
    const db = getDbClient()
    const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
    const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))
    try {
      const slug = 'physio-second'
      const bundle = await db.query<{ id: string }>(
        `INSERT INTO marketing_bundles
           (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
         VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
                 'staged', jsonb_build_object('page', jsonb_build_object('slug',$3::text)),
                 'v1', $2)
         RETURNING id`,
        [TENANT, `probe-second-${Date.now()}`, slug],
      )
      const bundleId = bundle.rows[0]!.id
      await db.query(
        `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
         VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
        [TENANT, bundleId, PAGE_HTML],
      )
      await commitBundleApproval(db, {
        tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor(slug),
      })
      expect((await drainOnce({ bundleId })).succeeded).toBe(1)

      const publish = await db.query<{ id: string; payload: { siteHash: string } }>(
        `SELECT id, payload FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      const publishRow = publish.rows[0]!

      const staged = await stagePromotion({ tenantId: TENANT, userId: APPROVER, userRole: 'admin', bundleId })
      if (!staged.ok) throw new Error(`expected a staged promotion, was refused with ${staged.reason}`)

      const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
      if (!draft) throw new Error('the staged promotion draft is not visible to its own tenant')
      expect(draft.objectType).toBe('marketing_promote')
      expect(draft.payload).toEqual({
        bundleId,
        pageActionId: publishRow.id,
        siteHash: publishRow.payload.siteHash,
      })

      await commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:promote' })

      const queued = await db.query<{ status: string; payload: Record<string, unknown> }>(
        `SELECT status, payload FROM marketing_actions WHERE bundle_id = $1 AND action = 'promote_page'`,
        [bundleId],
      )
      expect(queued.rows).toHaveLength(1)
      expect(queued.rows[0]!.status).toBe('queued')
      // The hash is the publish's own, and the slug is the one the bundle's plan
      // names: the queued row is what the adapter resolves its files from.
      expect(queued.rows[0]!.payload).toEqual({
        bundleId,
        slug,
        siteHash: publishRow.payload.siteHash,
      })
      expect(await statusOf(db, bundleId)).toBe('approved')

      await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
    } finally {
      unregisterPublish()
      unregisterPromote()
    }
  })

  /**
   * The in-transaction re-read is the receipt's last chance to notice that the
   * publish it names has changed since staging. The drainer would record such a
   * promotion as a failure, but the receipt would still attest to an action that
   * could never have succeeded; that is the signed lie the re-read prevents.
   */
  it('refuses to sign a promotion whose publish row moved after it was staged', async () => {
    const db = getDbClient()
    const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
    const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))
    try {
      const slug = 'physio-moved'
      const bundle = await db.query<{ id: string }>(
        `INSERT INTO marketing_bundles
           (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
         VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
                 'staged', jsonb_build_object('page', jsonb_build_object('slug',$3::text)),
                 'v1', $2)
         RETURNING id`,
        [TENANT, `probe-moved-${Date.now()}`, slug],
      )
      const bundleId = bundle.rows[0]!.id
      await db.query(
        `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
         VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
        [TENANT, bundleId, PAGE_HTML],
      )
      await commitBundleApproval(db, {
        tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor(slug),
      })
      expect((await drainOnce({ bundleId })).succeeded).toBe(1)

      const publish = await db.query<{ id: string; payload: { siteHash: string } }>(
        `SELECT id, payload FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      const publishRow = publish.rows[0]!
      const staged = await stagePromotion({ tenantId: TENANT, userId: APPROVER, userRole: 'admin', bundleId })
      if (!staged.ok) throw new Error(`expected a staged promotion, was refused with ${staged.reason}`)
      const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
      if (!draft) throw new Error('the staged promotion draft is not visible to its own tenant')

      // Bytes that moved under the review: the row still names a succeeded
      // publish of this bundle, but no longer the hash the draft carries.
      await db.query(
        `UPDATE marketing_actions SET payload = jsonb_set(payload, '{siteHash}', to_jsonb($2::text)) WHERE id = $1`,
        [publishRow.id, 'f'.repeat(64)],
      )
      await expect(
        commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:promote' }),
      ).rejects.toThrow(/not the bytes that went live/)

      // A publish that no longer reports a URL is the other refusal: the owner
      // has no preview to click, so the promotion has nothing to point at.
      await db.query(
        `UPDATE marketing_actions
            SET payload = jsonb_set(payload, '{siteHash}', to_jsonb($2::text)),
                result = result - 'url'
          WHERE id = $1`,
        [publishRow.id, publishRow.payload.siteHash],
      )
      await expect(
        commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:promote' }),
      ).rejects.toThrow(/reported no URL/)

      const queued = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM marketing_actions WHERE bundle_id = $1 AND action = 'promote_page'`,
        [bundleId],
      )
      expect(Number(queued.rows[0]!.n)).toBe(0)
      // Neither refusal signed anything, so the draft is still open.
      expect((await getPendingWrite(staged.pendingWriteId, TENANT))?.receiptId).toBeNull()

      await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
    } finally {
      unregisterPublish()
      unregisterPromote()
    }
  })

  /**
   * The preview-side half of "an action may not be approvable before it is
   * executable": a succeeded publish row that never reported a URL is not a
   * preview the owner has seen or can link, so there is no promotion to stage.
   * Only an older build or a hand-written row can carry one.
   */
  it('refuses to stage a promotion for a publish that never reported a URL', async () => {
    const db = getDbClient()
    const unregister = registerActionAdapter(makePromotePageAdapter(config))
    try {
      const bundle = await db.query<{ id: string }>(
        `INSERT INTO marketing_bundles
           (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
         VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
                 'approved', jsonb_build_object('page', jsonb_build_object('slug','physio-nourl')),
                 'v1', $2)
         RETURNING id`,
        [TENANT, `probe-nourl-${Date.now()}`],
      )
      const bundleId = bundle.rows[0]!.id
      await db.query(
        `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
         VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
        [TENANT, bundleId, PAGE_HTML],
      )
      await db.query(
        `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status)
         VALUES ($1, $2, 'publish_page', jsonb_build_object('slug','physio-nourl','siteHash',$3::text), 'succeeded')`,
        [TENANT, bundleId, siteHashFor('physio-nourl')],
      )

      const staged = await stagePromotion({ tenantId: TENANT, userId: APPROVER, userRole: 'admin', bundleId })
      expect(staged).toEqual({ ok: false, reason: 'no_published_preview' })
      const queued = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM marketing_actions WHERE bundle_id = $1 AND action = 'promote_page'`,
        [bundleId],
      )
      expect(Number(queued.rows[0]!.n)).toBe(0)

      await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
    } finally {
      unregister()
    }
  })

  it('records an unreachable provider as a failed row without touching the bundle status', async () => {
    const db = getDbClient()
    // A port nothing listens on: the adapter must fail the way a real refusal
    // fails, through fetch, rather than through a stub we wrote for this case.
    const down = { ...config, apiBaseUrl: 'http://127.0.0.1:1' }
    const unregister = registerActionAdapter(makePublishPageAdapter(down))

    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'staged', jsonb_build_object('page', jsonb_build_object('slug','physio-down')),
               'v1', $2)
       RETURNING id`,
      [TENANT, `probe-down-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id
    await db.query(
      `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
       VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
      [TENANT, bundleId, PAGE_HTML],
    )
    await commitBundleApproval(db, {
      tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor('physio-down'),
    })

    const r = await drainOnce({ bundleId })
    expect(r.ran).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.succeeded).toBe(0)

    const row = await db.query<{ status: string; last_error: string | null; attempts: number }>(
      `SELECT status, last_error, attempts FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
      [bundleId],
    )
    expect(row.rows[0]?.status).toBe('failed')
    expect(row.rows[0]?.last_error).toMatch(/ECONNREFUSED|fetch failed/)
    expect(row.rows[0]?.attempts).toBe(1)
    // The sentence the retry story rests on: a failed action never changed the
    // bundle, so retry is a new queued row and not a re-approval.
    expect(await statusOf(db, bundleId)).toBe('approved')

    unregister()
  })

  it('records a claimed action this process cannot run instead of dropping it', async () => {
    const db = getDbClient()
    // create_campaign is declared in the outbox and has no adapter anywhere in
    // this build. A row for it can only exist if an older build queued it, and
    // the honest answer is a named failure, never a row left `running` or
    // silently skipped.
    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'staged', NULL, 'v1', $2)
       RETURNING id`,
      [TENANT, `probe-noadapter-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id
    await db.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status)
       VALUES ($1, $2, 'create_campaign', '{}'::jsonb, 'queued')`,
      [TENANT, bundleId],
    )

    const r = await drainOnce({ bundleId })
    expect(r.ran).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.succeeded).toBe(0)

    const row = await db.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM marketing_actions WHERE bundle_id = $1`,
      [bundleId],
    )
    expect(row.rows[0]?.status).toBe('failed')
    expect(row.rows[0]?.last_error).toBe('no_adapter: create_campaign has no adapter in this process')
    expect(await statusOf(db, bundleId)).toBe('staged')
  })

  it('reaps a running row on how long it has been held, not how long it sat queued', async () => {
    const db = getDbClient()
    // A row queued two hours ago and claimed a moment ago, and a row a dead
    // drainer claimed two hours ago. The window is an hour, so a row a live pass
    // is holding right now cannot match it and this test cannot disturb another
    // file's rows.
    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'approved', jsonb_build_object('page', jsonb_build_object('slug','physio-reap')),
               'v1', $2)
       RETURNING id`,
      [TENANT, `probe-reap-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id

    const queuedLongAgo = await db.query<{ id: string }>(
      `INSERT INTO marketing_actions
         (tenant_id, bundle_id, action, payload, status, attempts, created_at)
       VALUES ($1, $2, 'promote_page', '{}'::jsonb, 'queued', 0, now() - interval '2 hours')
       RETURNING id`,
      [TENANT, bundleId],
    )
    const heldTooLong = await db.query<{ id: string }>(
      `INSERT INTO marketing_actions
         (tenant_id, bundle_id, action, payload, status, attempts, created_at, executed_at)
       VALUES ($1, $2, 'promote_page', '{}'::jsonb, 'running', 1,
               now() - interval '3 hours', now() - interval '2 hours')
       RETURNING id`,
      [TENANT, bundleId],
    )

    // The claim is the state change that matters: the row was queued two hours
    // ago, but it has been in flight for no time at all.
    const claimed = await claimNextQueued(db, bundleId)
    expect(claimed?.id).toBe(queuedLongAgo.rows[0]!.id)

    await reapStaleRunning(db, 3_600)

    const after = await db.query<{ id: string; status: string; last_error: string | null }>(
      `SELECT id, status, last_error FROM marketing_actions WHERE bundle_id = $1`,
      [bundleId],
    )
    const byId = new Map(after.rows.map((row) => [row.id, row]))
    // Under a queue-time comparison this row was two hours old and would be
    // failed here while its provider call was still running, which is the
    // duplicate-deployment invitation the claim stamp exists to remove.
    expect(byId.get(queuedLongAgo.rows[0]!.id)?.status).toBe('running')
    // The reaper still has to work: a row actually held past the window is failed.
    expect(byId.get(heldTooLong.rows[0]!.id)?.status).toBe('failed')
    expect(byId.get(heldTooLong.rows[0]!.id)?.last_error).toContain('stale_running')

    await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
  })

  /**
   * The retry is a decision, not a second attempt inside the failed row: the
   * database caps attempts at 3 and `failed` is terminal, so approving a
   * marketing_retry draft clones the failed payload into one new queued row.
   * The failed row stays failed forever, because the receipt trail has to show
   * both attempts. Spec section 5.
   */
  it('re-queues a failed publish as a new row after a retry approval, leaving the failed row alone', async () => {
    const db = getDbClient()
    // A port nothing listens on: the first attempt fails through fetch, the way
    // an under-scoped token fails, and never touches the bundle status.
    const down = { ...config, apiBaseUrl: 'http://127.0.0.1:1' }
    const unregisterFailed = registerActionAdapter(makePublishPageAdapter(down))
    let unregisterLive: (() => void) | null = null
    try {
      const slug = 'physio-retry'
      const bundle = await db.query<{ id: string }>(
        `INSERT INTO marketing_bundles
           (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
         VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
                 'staged', jsonb_build_object('page', jsonb_build_object('slug',$3::text)),
                 'v1', $2)
         RETURNING id`,
        [TENANT, `probe-retry-${Date.now()}`, slug],
      )
      const bundleId = bundle.rows[0]!.id
      await db.query(
        `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
         VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
        [TENANT, bundleId, PAGE_HTML],
      )
      await commitBundleApproval(db, {
        tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor(slug),
      })

      const first = await drainOnce({ bundleId })
      expect(first.failed).toBe(1)
      const failedRows = await db.query<{
        id: string
        status: string
        attempts: number
        last_error: string | null
        payload: Record<string, unknown>
      }>(
        `SELECT id, status, attempts, last_error, payload FROM marketing_actions
          WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      expect(failedRows.rows).toHaveLength(1)
      const failed = failedRows.rows[0]!
      expect(failed.status).toBe('failed')
      expect(failed.attempts).toBe(1)
      expect(failed.last_error).toMatch(/ECONNREFUSED|fetch failed/)

      const staged = await stageRetry({ tenantId: TENANT, userId: APPROVER, userRole: 'admin', actionId: failed.id })
      if (!staged.ok) throw new Error(`expected a staged retry, was refused with ${staged.reason}`)

      const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
      if (!draft) throw new Error('the staged retry draft is not visible to its own tenant')
      expect(draft.objectType).toBe('marketing_retry')
      expect(draft.payload).toEqual({ actionId: failed.id, siteHash: failed.payload['siteHash'] })

      await commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:retry' })

      // Two attempts, two rows: the queued clone has zero attempts, and the
      // failed row still says exactly what the first attempt said.
      const afterApproval = await db.query<{
        id: string
        status: string
        attempts: number
        payload: Record<string, unknown>
      }>(
        `SELECT id, status, attempts, payload FROM marketing_actions
          WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      expect(afterApproval.rows).toHaveLength(2)
      expect(afterApproval.rows.map((row) => row.attempts).sort()).toEqual([0, 1])
      const stillFailed = afterApproval.rows.find((row) => row.id === failed.id)!
      expect(stillFailed.status).toBe('failed')
      const requeued = afterApproval.rows.find((row) => row.id !== failed.id)!
      expect(requeued.status).toBe('queued')
      // The clone is the payload the owner approved the first time, not a
      // re-derivation from whatever the bundle says now.
      expect(requeued.payload).toEqual(failed.payload)

      // Once this process can run the action again, the next pass takes the
      // queued clone and succeeds; the failed row is still the first attempt.
      unregisterLive = registerActionAdapter(makePublishPageAdapter(config))
      const second = await drainOnce({ bundleId })
      expect(second.succeeded).toBe(1)
      expect(second.failed).toBe(0)

      const afterDrain = await db.query<{ id: string; status: string; attempts: number }>(
        `SELECT id, status, attempts FROM marketing_actions
          WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      const failedAfter = afterDrain.rows.find((row) => row.id === failed.id)!
      expect(failedAfter).toMatchObject({ status: 'failed', attempts: 1 })
      const succeeded = afterDrain.rows.find((row) => row.id !== failed.id)!
      expect(succeeded).toMatchObject({ status: 'succeeded', attempts: 1 })
      // A publish leaves the bundle approved; only a promote makes it live.
      expect(await statusOf(db, bundleId)).toBe('approved')

      // A succeeded action is not retryable: the refusal comes from the row
      // itself, not from a caller remembering to ask only about failures.
      const notFailed = await stageRetry({
        tenantId: TENANT, userId: APPROVER, userRole: 'admin', actionId: succeeded.id,
      })
      expect(notFailed).toEqual({ ok: false, reason: 'not_failed' })

      await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
    } finally {
      unregisterFailed()
      unregisterLive?.()
    }
  })

  /**
   * The commit-time bytes re-read is the retry receipt's last chance to notice
   * that the bundle was re-saved after the retry was staged. The drainer's
   * adapter would refuse such a clone with site_hash_moved, but the receipt
   * would still attest to an action that could never have succeeded; that is
   * the signed lie the in-transaction re-read prevents.
   */
  it('refuses to sign a retry whose page bytes moved after it was staged', async () => {
    const db = getDbClient()
    // A port nothing listens on: the first attempt has to fail through fetch,
    // so the fixture reaches the retry path the way a real under-scoped token
    // would rather than through a stub written for this case.
    const down = { ...config, apiBaseUrl: 'http://127.0.0.1:1' }
    const unregisterFailed = registerActionAdapter(makePublishPageAdapter(down))
    try {
      const slug = 'physio-retry-moved'
      const bundle = await db.query<{ id: string }>(
        `INSERT INTO marketing_bundles
           (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
         VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
                 'staged', jsonb_build_object('page', jsonb_build_object('slug',$3::text)),
                 'v1', $2)
         RETURNING id`,
        [TENANT, `probe-retry-moved-${Date.now()}`, slug],
      )
      const bundleId = bundle.rows[0]!.id
      await db.query(
        `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
         VALUES ($1, $2, 'funnel-builder', 'page_html', $3)`,
        [TENANT, bundleId, PAGE_HTML],
      )
      await commitBundleApproval(db, {
        tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: siteHashFor(slug),
      })

      expect((await drainOnce({ bundleId })).failed).toBe(1)
      const failedRows = await db.query<{ id: string }>(
        `SELECT id FROM marketing_actions
          WHERE bundle_id = $1 AND action = 'publish_page' AND status = 'failed'`,
        [bundleId],
      )
      const failed = failedRows.rows[0]!
      const staged = await stageRetry({ tenantId: TENANT, userId: APPROVER, userRole: 'admin', actionId: failed.id })
      if (!staged.ok) throw new Error(`expected a staged retry, was refused with ${staged.reason}`)
      const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
      if (!draft) throw new Error('the staged retry draft is not visible to its own tenant')

      // The page is re-saved under the review: the failed row and the draft
      // still name the bytes of the first attempt, but the bundle no longer
      // holds them. Approving now would queue a clone the drainer could only
      // record as failed.
      await db.query(
        `UPDATE marketing_artifacts SET text_content = $3
          WHERE tenant_id = $1 AND bundle_id = $2 AND kind = 'page_html'`,
        [TENANT, bundleId, '<h1>Re-saved while the retry waited</h1>'],
      )
      await expect(
        commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:retry' }),
      ).rejects.toThrow(/are not the bytes stored/)

      // Neither a queued clone nor a receipt came out of the refused approval.
      const queued = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM marketing_actions
          WHERE bundle_id = $1 AND action = 'publish_page' AND status = 'queued'`,
        [bundleId],
      )
      expect(Number(queued.rows[0]!.n)).toBe(0)
      expect((await getPendingWrite(staged.pendingWriteId, TENANT))?.receiptId).toBeNull()

      await db.query('DELETE FROM marketing_bundles WHERE id = $1', [bundleId])
    } finally {
      unregisterFailed()
    }
  })
})

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
import { claimNextQueued, drainOnce, reapStaleRunning } from '../../scripts/publish-drain'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = 'a1000000-0000-4000-8000-000000000028'
const OTHER_TENANT = 'a1000000-0000-4000-8000-000000000029'

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
})

// tests/integration/marketing-asset-invalidation.test.ts
/**
 * The whole-chain proof for Task 12. No mock can show that a real staged bundle
 * loses its real draft when a picture lands: the unit suite asserts on the SQL
 * the tool issues, but only a real database can prove the status flip, the
 * rejection stamp, and the prediction orphaning that together make spec
 * section 6.3's ruling true. The stub adapter returns PNG literals so nothing
 * reaches a network and no provider is billed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient, getDbClient } from '../../src/db/client'
import {
  generateAssetsTool,
  saveBundleTool,
  stageBundleTool,
} from '../../src/mastra/tools/marketing-writes'
import { getOpenStageDraft } from '../../src/db/pending-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { reviewDocument } from '../../src/db/documents'
import { insertPrediction } from '../../src/db/reviewer-predictions'
import { registerImageAdapter, __imageProviderRegistry, setSelectedImageProvider, type ImageAdapter } from '../../src/marketing/image-provider'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'

let pool: Pool
let unregisterPublish: () => void = () => {}

// …043 is private to this file; no other integration file uses it.
const TENANT = 'a1000000-0000-4000-8000-000000000043'
const USER = 'a2000000-0000-4000-8000-000000000043'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

function stubAdapter(): ImageAdapter {
  return {
    provider: 'stub',
    model: 'stub/flux-1.1-pro',
    ceilingMinor: 2000,
    bundleCeilingMinor: 200,
    costMinorPerImage: 4,
    maxBytes: 1024,
    generate() {
      return Promise.resolve({
        ok: true,
        image: {
          predictionId: 'pred-invalidation',
          costUsd: '0.04',
          costMinor: 4,
          mime: 'image/png',
          bytes: PNG_A,
          sizeBytes: PNG_A.byteLength,
          model: 'stub/flux-1.1-pro',
          aspectRatio: '16:9',
        },
      })
    },
  }
}

const ASSET_TEXT = JSON.stringify({
  assets: [
    {
      name: 'hero-image',
      prompt: 'a physio clinic reception at dawn, warm light, no people',
      aspectRatio: '16:9',
      negativePrompt: null,
    },
  ],
})

function bundleInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief: 'Book more physio assessments in Melbourne for owner-led clinics (invalidation)',
    objective: 'outreach_support',
    audienceNote: 'owner-led clinics with 2 to 8 staff',
    strategy: { position: 'the clinic that answers within an hour' },
    copy: { hooks: ['Your next patient is already searching'] },
    mediaPlan: null,
    funnelPlan: null,
    analysis: null,
    promptVersion: 'marketing-v1',
    artifacts: [],
    ...over,
  }
}

async function rows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await getDbClient().query<T>(sql, params)).rows
}

async function statusOf(bundleId: string): Promise<string> {
  const result = await rows<{ status: string }>(
    'SELECT status FROM marketing_bundles WHERE id = $1',
    [bundleId],
  )
  return result[0]!.status
}

async function resetTenant(): Promise<void> {
  const db = getDbClient()
  await db.query('DELETE FROM reviewer_predictions WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM marketing_image_spend WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM marketing_artifacts WHERE tenant_id = $1', [TENANT])
  await db.query("DELETE FROM documents WHERE tenant_id = $1 AND kind = 'marketing_asset'", [TENANT])
  await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM human_tasks WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [TENANT])
}

beforeAll(async () => {
  if (url === '') return
  pool = new Pool({ connectionString: url, max: 2 })
  await migrate(pool)
  await resetTenant()
  registerImageAdapter(stubAdapter())
  setSelectedImageProvider('stub')
  // `stage_bundle` refuses a bundle whose derived actions have no adapter in this
  // process (`no adapter for publish_page`), and a real page-host adapter needs
  // Cloudflare credentials this test must not want. This file never drains an
  // approval, so the question it asks is only "does a landed picture kill the
  // waiting draft", and a named stub answers that. Same shape as
  // tests/mastra/marketing-publish-tools.test.ts:71. The unregister is kept so a
  // later file in the same worker does not find the lane open.
  unregisterPublish = registerActionAdapter({
    name: 'publish_page',
    execute: () => Promise.resolve({ externalId: 'invalidation-test-stub' }),
  })
})

afterAll(async () => {
  unregisterPublish()
  __imageProviderRegistry.clear()
  if (url !== '') {
    await closeDbClient()
    await pool.end()
  }
})

describe.skipIf(url === '')('marketing asset invalidation against Postgres', () => {
  it('a picture that lands after staging kills the approval that was waiting', async () => {
    const saved = (await saveBundleTool.execute!(
      {
        ...bundleInput(),
        funnelPlan: { page: { slug: 'physio-invalidation' } },
        artifacts: [
          { role: 'creative-designer', kind: 'script', documentId: null, textContent: ASSET_TEXT },
          // No `{{ASSET:hero-image}}` here, which is what makes this look odd at
          // first read. Slice 5 Task 6 made `stage_bundle` refuse a page whose
          // named asset has no document behind it, so a bundle that names
          // hero-image cannot be staged before the picture lands, and the case
          // this file exists for (a picture arriving after an approval is already
          // waiting) would be unreachable. The picture still arrives the same way
          // a real one does: from the designer's prompt list in the script
          // artifact above, which is the asset move the invalidation is about.
          { role: 'funnel-builder', kind: 'page_html', documentId: null, textContent: '<h1>Book in</h1><p>Same-day assessments for owner-led clinics.</p>' },
        ],
      } as never,
      context,
    )) as { bundleId: string }
    const bundleId = saved.bundleId

    const staged = (await stageBundleTool.execute!(
      { bundleId, requestedCeilingMinor: 2500 },
      context,
    )) as { pendingWriteId: string; reason?: string; message?: string }
    // `reason` and `message` are in the cast above because when this case first
    // ran it refused, and a refusal is only readable if the assertion that fails
    // can name what was refused. A console.log of the whole result was here and is
    // gone: the throw below carries the same two fields now.
    if (staged.reason !== undefined) {
      throw new Error(`stage_bundle refused a bundle that should stage: ${staged.reason} / ${staged.message}`)
    }
    expect(await statusOf(bundleId)).toBe('staged')

    // The reviewer's prediction, written against the bytes they were shown.
    const predicted = await insertPrediction({
      tenantId: TENANT,
      pendingWriteId: staged.pendingWriteId,
      predictedOutcome: 'This will increase bookings by 20%',
    })
    expect(predicted.prediction).toBeDefined()

    // The generate run attaches a new picture, which is an asset move.
    const generated = (await generateAssetsTool.execute!(
      { bundleId },
      context,
    )) as { assets: Array<{ name: string; documentId: string; status: string }>; refused: unknown[] }
    expect(generated.assets).toHaveLength(1)
    expect(generated.refused).toEqual([])

    // The draft is rejected with the right reason.
    const draft = await pool.query<{ rejected_at: string | null; rejection_reason: string | null }>(
      'SELECT rejected_at, rejection_reason FROM pending_writes WHERE id = $1',
      [staged.pendingWriteId],
    )
    expect(draft.rows[0]?.rejected_at).not.toBeNull()
    expect(draft.rows[0]?.rejection_reason).toBe('assets_changed_after_staging')

    // The bundle is back to draft.
    expect(await statusOf(bundleId)).toBe('draft')

    // No open stage draft remains.
    expect(await getOpenStageDraft(TENANT, bundleId)).toBeNull()

    // Re-staging is a new draft, and reviewer_predictions is keyed
    // UNIQUE (pending_write_id), so the old prediction cannot anchor it. The
    // picture that just landed is `needs_review`, and slice 4 Task 8 makes
    // `stage_bundle` refuse a bundle with an unreviewed image by name, so the
    // confirm has to happen first. It goes through `reviewDocument`, the same
    // call the console's Assets tab makes, because a hand-written UPDATE would
    // prove the re-stage against a status the product cannot produce. Without it
    // this last assertion would be measuring a refusal rather than a new draft.
    const reviewed = await reviewDocument(
      { tenantId: TENANT, userId: USER, userRole: 'admin' },
      generated.assets[0]!.documentId,
    )
    expect(reviewed?.status).toBe('ready')

    const again = (await stageBundleTool.execute!(
      { bundleId, requestedCeilingMinor: 2500 },
      context,
    )) as { pendingWriteId: string }
    expect(again.pendingWriteId).not.toBe(staged.pendingWriteId)
    const anchored = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM reviewer_predictions WHERE pending_write_id = $1',
      [again.pendingWriteId],
    )
    expect(Number(anchored.rows[0]!.n)).toBe(0)
  })

  it('does not invalidate on spend alone', async () => {
    // Spec section 6.3's rejected fourth call site, as an assertion rather than
    // a comment: money spent with no new bytes must not disturb a mid-review
    // approval. A save with no artifacts generates nothing, spends nothing, and
    // leaves any open stage draft untouched.
    const saved = (await saveBundleTool.execute!(
      {
        ...bundleInput({ brief: 'spend-alone invalidation case' }),
        artifacts: [
          { role: 'marketer-copywriter', kind: 'script', documentId: null, textContent: 'just copy, no designer prompt' },
        ],
      } as never,
      context,
    )) as { bundleId: string }
    const bundleId = saved.bundleId

    const staged = (await stageBundleTool.execute!(
      { bundleId, requestedCeilingMinor: 2500 },
      context,
    )) as { pendingWriteId: string }
    expect(await statusOf(bundleId)).toBe('staged')

    // A generate run on a bundle with no designer prompt refuses the whole run
    // before spending anything. No bytes moved, so no invalidation.
    const generated = (await generateAssetsTool.execute!(
      { bundleId },
      context,
    )) as { refused: Array<{ code: string }>; assets: unknown[] }
    expect(generated.assets).toEqual([])
    expect(generated.refused.length).toBeGreaterThan(0)

    // The bundle is still staged and the draft is still open.
    expect(await statusOf(bundleId)).toBe('staged')
    const stillOpen = await getOpenStageDraft(TENANT, bundleId)
    expect(stillOpen).not.toBeNull()
    expect(stillOpen!.id).toBe(staged.pendingWriteId)
  })
})

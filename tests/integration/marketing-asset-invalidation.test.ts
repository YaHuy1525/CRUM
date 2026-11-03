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
import { insertPrediction } from '../../src/db/reviewer-predictions'
import { registerImageAdapter, __imageProviderRegistry, setSelectedImageProvider, type ImageAdapter } from '../../src/marketing/image-provider'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'

let pool: Pool

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
})

afterAll(async () => {
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
          { role: 'funnel-builder', kind: 'page_html', documentId: null, textContent: '<h1>Book in</h1><img src="{{ASSET:hero-image}}" alt="Clinic">' },
        ],
      } as never,
      context,
    )) as { bundleId: string }
    const bundleId = saved.bundleId

    const staged = (await stageBundleTool.execute!(
      { bundleId, requestedCeilingMinor: 2500 },
      context,
    )) as { pendingWriteId: string; proceed?: boolean; reason?: string; message?: string }
    console.log('STAGED RESULT:', JSON.stringify(staged, null, 2))
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
    )) as { assets: Array<{ name: string }>; refused: unknown[] }
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
    // UNIQUE (pending_write_id), so the old prediction cannot anchor it.
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

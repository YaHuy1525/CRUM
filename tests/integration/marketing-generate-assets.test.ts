// tests/integration/marketing-generate-assets.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient, getDbClient } from '../../src/db/client'
import { generateAssetsTool, saveBundleTool } from '../../src/mastra/tools/marketing-writes'
import { setImageAdapter, type ImageAdapter } from '../../src/marketing/image-provider'
import { committedSpendMinor, committedBundleSpendMinor } from '../../src/marketing/image-spend'

/**
 * The paid lane without the payment. The adapter is a stub that returns two
 * distinct PNGs, so nothing here reaches a network and no provider is ever
 * billed; what this file buys is the proof that the rows the tool writes satisfy
 * the constraints the mock suite cannot see. Spec section 12 keeps provider bytes
 * for the manual walkthrough, and this file stays inside that rule on purpose:
 * it tests the database half, not the HTTP half.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'

let pool: Pool

const TENANT = 'a1000000-0000-4000-8000-000000000021'
const USER = 'a2000000-0000-4000-8000-000000000021'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])

const promptsAskedFor: string[] = []

function stubAdapter(ceilingMinor = 40, bundleCeilingMinor = 200): ImageAdapter {
  return {
    provider: 'stub',
    model: 'stub/flux-1.1-pro',
    ceilingMinor,
    bundleCeilingMinor,
    costMinorPerImage: 4,
    maxBytes: 1024,
    // Not `async`: this repo's lint fails an async method with no `await` in it,
    // and the adapter contract is a promise, which `Promise.resolve` hands back.
    generate(request) {
      promptsAskedFor.push(request.prompt)
      // Derived from the prompt, not from a call counter. A counter makes the bytes
      // depend on how many cases ran first — case two's re-order would then hand
      // both assets the same PNG and one of them would dedup against the other
      // inside a single run — and an integration file that only passes in one
      // order is a file that cannot be re-run.
      const bytes = request.prompt.includes('reception') ? PNG_A : PNG_B
      return Promise.resolve({
        ok: true,
        image: {
          predictionId: `pred-${promptsAskedFor.length}`,
          costUsd: '0.04',
          costMinor: 4,
          mime: 'image/png',
          bytes,
          sizeBytes: bytes.byteLength,
          model: 'stub/flux-1.1-pro',
          aspectRatio: request.aspectRatio,
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
      negativePrompt: 'watermark',
    },
    {
      name: 'wall-art',
      prompt: 'a framed movement chart on a clinic wall',
      aspectRatio: '1:1',
      negativePrompt: null,
    },
  ],
})

// One bundle per case, named by `tag`. `saveBundleTool` is content-addressed:
// `computeBundleHash` covers the `brief` column (src/mastra/tools/marketing-writes.ts:189-200)
// and the draft is keyed `bundle:${draftHash}`, so three saves of one identical
// payload are three names for the SAME bundle. Left identical, case two would find
// case one's two titles already attached, pay nothing on what it calls its first
// pass, and case three would refuse nothing because nothing is pending. The tag is
// the only thing that differs, so each case buys and re-reads a bundle of its own.
async function saveDesignerBundle(tag: string) {
  const saved = (await saveBundleTool.execute!(
    {
      brief: `Book more physio assessments in Melbourne for owner-led clinics (${tag})`,
      objective: 'outreach_support',
      audienceNote: 'owner-led clinics with 2 to 8 staff',
      strategy: { position: 'the clinic that answers within an hour' },
      copy: { hooks: ['Your next patient is already searching'] },
      mediaPlan: null,
      funnelPlan: null,
      analysis: null,
      promptVersion: 'marketing-v1',
      artifacts: [
        { role: 'creative-designer', kind: 'script', documentId: null, textContent: ASSET_TEXT },
      ],
    } as never,
    context,
  )) as { bundleId: string }
  return saved.bundleId
}

async function generate(bundleId: string) {
  return (await generateAssetsTool.execute!({ bundleId }, context)) as {
    assets: Array<{ name: string; documentId: string | null; deduplicated: boolean; costMinor: number }>
    refused: Array<{ name: string; code: string }>
    spentMinor: number
    humanTaskId: string | null
    gate: string
  }
}

// `T extends QueryResultRow` because `getDbClient()` hands back a pg `Pool` and
// `Pool.query<T>` constrains `T` to `QueryResultRow`; the bound is what lets the
// row shapes below stay literal instead of degenerating to `Record<string, unknown>`.
async function rows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await getDbClient().query<T>(sql, params)).rows
}

beforeAll(async () => {
  if (url === '') return
  // The convention of the other integration files (marketing-image-spend.ts:38-41,
  // marketing-assets-migration.ts:27-30, and seven more): a file that needs the
  // schema applies it itself instead of borrowing the state another file left
  // behind. `migrate` is idempotent — it tracks applied versions in its own table
  // — so on an already-migrated cluster this is one extra SELECT, and on a fresh
  // one it is the reason the DELETE below finds `marketing_image_spend` at all.
  // Without it this file only passes after some other integration file has run.
  pool = new Pool({ connectionString: url, max: 2 })
  await migrate(pool)
  // Same habit as `tests/integration/marketing-bundle.test.ts:87-101`: this tenant
  // is private to this file, and the file must be re-runnable. Without the reset,
  // run two finds run one's hashes, its ledger, and its artifact rows, and the very
  // first assertion (`committedSpendMinor` is 8) reads 16 and fails for a reason
  // that has nothing to do with the code under test. `documents` cascades
  // `document_files` (0009:55) and the parse tables; `marketing_artifacts.document_id`
  // references documents WITHOUT a cascade (0018:65), so artifacts go before the
  // rows they point at; and `marketing_image_spend.document_id` has no foreign key
  // at all (0021:35), so only its own tenant filter clears it.
  const db = getDbClient()
  await db.query('DELETE FROM marketing_image_spend WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM marketing_artifacts WHERE tenant_id = $1', [TENANT])
  await db.query("DELETE FROM documents WHERE tenant_id = $1 AND kind = 'marketing_asset'", [TENANT])
  await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM human_tasks WHERE tenant_id = $1', [TENANT])
  // `pending_writes` and its receipts are in the reset too, or the second run of
  // this file cannot start: the draft is content-addressed as well, so a leftover
  // committed row makes `commitAutoWrite` (src/db/pending-writes.ts:722-725) hand
  // back the bundle id it committed last time — a row the statement above has just
  // deleted — and `insertMarketingArtifacts` then dies on
  // `marketing_artifacts_bundle_id_fkey`. Same shape as
  // tests/integration/marketing-bundle.test.ts:87-101.
  await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [TENANT])
  setImageAdapter(stubAdapter())
})

afterAll(async () => {
  setImageAdapter(null)
  if (url !== '') {
    await closeDbClient()
    await pool.end()
  }
})

describe.skipIf(url === '')('marketing.generate_assets against Postgres', () => {
  // CASE ORDER IS LOAD-BEARING: this case must stay first. The reset is
  // `beforeAll`, not `beforeEach`, deliberately — case two reads the tenant's
  // whole day on purpose ("by now the tenant has paid for case one too"), so the
  // ledger is shared state across the file by design. The consequence is that the
  // absolute numbers below (`spentMinor` 8, `committedSpendMinor(TENANT)` 8) are
  // only exact because nothing had spent before them. Reorder this file, or add a
  // case above this one, and those two assertions fail for test order rather than
  // for the tool. `tests/integration/marketing-image-spend.test.ts:28-35` is the
  // alternative shape (a minted tenant per case) if this file ever needs it.
  it('writes the document, the bytes, the artifact and the ledger for two prompts', async () => {
    const bundleId = await saveDesignerBundle('two prompts')
    const out = await generate(bundleId)

    expect(out.gate).toBe('auto')
    expect(out.assets).toHaveLength(2)
    expect(out.refused).toEqual([])
    expect(out.spentMinor).toBe(8)
    expect(out.humanTaskId).toBeNull()

    const docs = await rows<{ id: string; kind: string; status: string; title: string }>(
      `SELECT id, kind, status, title FROM documents
        WHERE tenant_id = $1 AND kind = 'marketing_asset' AND id = ANY($2::uuid[])`,
      [TENANT, out.assets.map((a) => a.documentId)],
    )
    expect(docs).toHaveLength(2)
    // needs_review, not ready: the owner looks at the picture before the plane
    // calls it usable, and Task 8's stage refusal depends on that being the
    // stored state rather than an assumption.
    expect(new Set(docs.map((d) => d.status))).toEqual(new Set(['needs_review']))

    const files = await rows<{ document_id: string; size_bytes: string }>(
      'SELECT document_id, size_bytes FROM document_files WHERE document_id = ANY($1::uuid[])',
      [out.assets.map((a) => a.documentId)],
    )
    expect(files).toHaveLength(2)

    const artifacts = await rows<{ kind: string; document_id: string }>(
      `SELECT kind, document_id FROM marketing_artifacts
        WHERE tenant_id = $1 AND bundle_id = $2 AND kind = 'image'`,
      [TENANT, bundleId],
    )
    expect(artifacts).toHaveLength(2)
    // The CHECK that makes this assertion worth writing: an image artifact with
    // no document is a row that promises a picture and points at nothing.
    expect(artifacts.every((a) => a.document_id !== null)).toBe(true)

    expect(await committedSpendMinor(TENANT)).toBe(8)
  })

  it('buys nothing on the second pass, because every title is already there', async () => {
    const bundleId = await saveDesignerBundle('second pass')
    const first = await generate(bundleId)
    expect(first.spentMinor).toBe(8)
    // The day's total, read back, not the run's number. `spentMinor` is what THIS
    // call paid, and by now the tenant has paid for case one too, so comparing the
    // second pass with a per-run figure compares two different things and fails for
    // a reason that belongs to the test rather than the tool.
    const committedAfterFirst = await committedSpendMinor(TENANT)
    promptsAskedFor.length = 0

    const second = await generate(bundleId)
    expect(promptsAskedFor).toEqual([])
    expect(second.spentMinor).toBe(0)
    expect(second.assets.every((a) => a.deduplicated)).toBe(true)
    expect(await committedSpendMinor(TENANT)).toBe(committedAfterFirst)
  })

  it('refuses the whole pass before paying when the day is already spent', async () => {
    const bundleId = await saveDesignerBundle('already spent')
    setImageAdapter(stubAdapter(4))
    try {
      const out = await generate(bundleId)
      expect(out.assets).toEqual([])
      expect(out.refused.map((r) => r.code)).toEqual([
        'image_spend_ceiling_reached',
        'image_spend_ceiling_reached',
      ])
      expect(out.spentMinor).toBe(0)
      expect(out.humanTaskId).not.toBeNull()

      const tasks = await rows<{
        run_id: string
        kind: string
        tool_name: string
        title: string
        body: string | null
      }>('SELECT run_id, kind, tool_name, title, body FROM human_tasks WHERE id = $1', [
        out.humanTaskId,
      ])
      expect(tasks[0]?.run_id).toBe(`assets:${bundleId}`)
      expect(tasks[0]?.kind).toBe('refusal')
      expect(tasks[0]?.tool_name).toBe('marketing.generate_assets')
      // One row for the whole refusal, naming both assets, rather than one row
      // per asset: the owner reads this list, and a run that stopped early is
      // one decision to make. The refusal text lives in `title` and `body`.
      // There is no `reason` column on `human_tasks` (migrations/0002_crum_spine.sql:186-200),
      // and `createHumanTask` writes exactly these nine columns, so naming the
      // two that carry prose is the whole of the assertion.
      expect(tasks[0]?.title).toContain('refused 2 asset(s)')
      expect(tasks[0]?.body ?? '').toContain('image_spend_ceiling_reached')
    } finally {
      setImageAdapter(stubAdapter())
    }
  })

  it('caps a bundle on its own ledger, while the tenant still has a full day of headroom', async () => {
    setImageAdapter(stubAdapter(2000, 12))
    try {
      const bundleId = await saveDesignerBundle('bundle ceiling first')
      const first = await generate(bundleId)
      expect(first.refused).toHaveLength(0)
      expect(await committedBundleSpendMinor(TENANT, bundleId)).toBeGreaterThan(0)
      // Same tenant, same day, second bundle: the day ceiling has room, so the only
      // thing that can stop this run is the bundle it belongs to.
      const otherId = await saveDesignerBundle('bundle ceiling second')
      const second = await generate(otherId)
      expect(second.refused).toHaveLength(0)
      expect(await committedBundleSpendMinor(TENANT, otherId)).toBeGreaterThan(0)
    } finally {
      setImageAdapter(stubAdapter())
    }
  })
})

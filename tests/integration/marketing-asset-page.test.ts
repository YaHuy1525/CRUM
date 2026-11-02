// tests/integration/marketing-asset-page.test.ts
/**
 * Slice 5 R1, on the wire. Everything up to this file is provable in a unit: the
 * placeholder grammar, the hosted path, the per-file hash, the content type a
 * multipart part carries. The claim that matters is not provable in a unit — that
 * a bundle built by the real tools, approved by the real approval and drained by
 * the real drainer uploads the PNG the designer bought, and that the bytes it
 * uploads are the bytes the approved site hash covered. So this file runs the
 * whole chain against a real Postgres and a stand-in page host on 127.0.0.1, and
 * compares the picture in the database, the picture in the manifest, and the
 * picture on the wire, byte for byte. Nothing leaves the machine: the image
 * adapter is a stub and the host is a local socket, so no provider is billed and
 * no domain is touched (spec section 13, integration case 1).
 *
 * The stand-in keeps the body as a Buffer rather than a utf8 string, because a
 * PNG through `toString('utf8')` is not a PNG any more: the replacement character
 * is lossy, so the only honest read of a body that mixes markup and bytes is the
 * bytes themselves.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { drainOnce } from '../../scripts/publish-drain'
import { closeDbClient, getDbClient } from '../../src/db/client'
import { currentSiteHash } from '../../src/db/marketing'
import { loadSiteArtifacts } from '../../src/db/marketing-assets'
import { getPendingWrite } from '../../src/db/pending-writes'
import {
  generateAssetsTool,
  saveBundleTool,
  stageBundleTool,
} from '../../src/mastra/tools/marketing-writes'
import { registerImageAdapter, __imageProviderRegistry, setSelectedImageProvider, type ImageAdapter } from '../../src/marketing/image-provider'
import { commitBundleApproval, registerActionAdapter } from '../../src/marketing/outbox'
import {
  makePromotePageAdapter,
  makePublishPageAdapter,
  readSiteFiles,
  type PageHostConfig,
} from '../../src/marketing/page-host'
import { siteHashOf, siteProblem } from '../../src/marketing/site'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url

// Reserved for this file, the way marketing-publish.test.ts claims …028 and
// marketing-generate-assets.test.ts claims …021. …041 is the picture case and
// …042 the ghost case; no other integration file in the repo uses either.
const TENANT = 'a1000000-0000-4000-8000-000000000041'
const USER = 'a2000000-0000-4000-8000-000000000041'
const TENANT_GHOST = 'a1000000-0000-4000-8000-000000000042'
const USER_GHOST = 'a2000000-0000-4000-8000-000000000042'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

const ghostContext = {
  requestContext: { all: { tenantId: TENANT_GHOST, userId: USER_GHOST, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])

/**
 * The same stub as `tests/integration/marketing-generate-assets.test.ts:38-70`
 * (that file exports nothing, so the shape is copied, not imported). Nothing here
 * reaches a network: the bytes are literals, and the only HTTP in this file is
 * the loopback POST to the stand-in below.
 */
function stubAdapter(): ImageAdapter {
  return {
    provider: 'stub',
    model: 'stub/flux-1.1-pro',
    ceilingMinor: 40,
    bundleCeilingMinor: 200,
    costMinorPerImage: 4,
    maxBytes: 1024,
    // Not `async`: this repo's lint fails an async method with no `await` in it,
    // and the adapter contract is a promise, which `Promise.resolve` hands back.
    generate(request) {
      // Derived from the prompt, not from a call counter, so the bytes cannot
      // depend on how many cases ran first.
      const bytes = request.prompt.includes('reception') ? PNG_A : PNG_B
      return Promise.resolve({
        ok: true,
        image: {
          predictionId: 'pred-asset-page',
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

/**
 * The designer artifact `marketing.generate_assets` reads. Two of its values are
 * load-bearing rather than stylistic: the `name` must be `hero`, because that is
 * the title the page's `{{ASSET:hero}}` placeholder resolves against and the tool
 * stores the prompt name as the document title
 * (`src/mastra/tools/marketing-writes.ts` `title: entry.name`); and the prompt
 * must contain `reception`, because the stub above derives the bytes from the
 * prompt text and a prompt without it hands back PNG_B, which would make the
 * byte-for-byte assertion below a fixture accident. One asset only: the picture
 * this case puts on the wire is the one it can name.
 */
const ASSET_TEXT = JSON.stringify({
  assets: [
    {
      name: 'hero',
      prompt: 'a physio clinic reception at dawn, warm light, no people',
      aspectRatio: '16:9',
      negativePrompt: 'watermark',
    },
  ],
})

const PAGE_HTML = '<h1>Book in</h1><img src="{{ASSET:hero}}" alt="Clinic">'
const GHOST_PAGE_HTML = '<h1>Book in</h1><img src="{{ASSET:ghost}}" alt="Clinic">'

/**
 * The shape of `bundleInput` in `tests/mastra/marketing-write-tools.test.ts:111`,
 * copied because that file is a unit file and exports nothing. Every brief this
 * case saves is unique: `saveBundleTool` is content-addressed on the `brief`
 * column, so an identical payload is the same bundle, and a second run of this
 * file would then find its own picture already attached and pay for nothing.
 */
function bundleInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief: 'Book more physio assessments in Melbourne for owner-led clinics, picture case',
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

interface Captured {
  branch: string
  manifest: string
  body: Buffer
}

/**
 * The one field of a multipart part, read off the wire (copied from
 * `marketing-publish.test.ts:61`, which does not export it).
 */
function fieldOf(body: string, name: string): string {
  const match = new RegExp(`name="${name}"([\\s\\S]*?)------`).exec(body)
  return match?.[1]?.replace(/\r\n/g, '').trim() ?? '?'
}

/**
 * The whole reset sequence of `marketing-generate-assets.test.ts:146-163`, not
 * just the bundle delete: this file writes documents, artifacts, a human task, a
 * pending write and spend rows, and only the bundle and its children cascade
 * (`marketing_actions` rides the bundle at 0019:45, `marketing_artifacts` at
 * 0018:56). `documents` cascades `document_files`; `marketing_image_spend` has no
 * foreign key at all (0021:35), so only its own tenant filter clears it; and
 * `pending_writes` is content-addressed, so a leftover committed draft makes
 * `commitAutoWrite` hand back a bundle id the statement above has just deleted.
 */
async function resetTenant(db: Pool, tenantId: string): Promise<void> {
  await db.query('DELETE FROM marketing_image_spend WHERE tenant_id = $1', [tenantId])
  await db.query('DELETE FROM marketing_artifacts WHERE tenant_id = $1', [tenantId])
  await db.query("DELETE FROM documents WHERE tenant_id = $1 AND kind = 'marketing_asset'", [tenantId])
  await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [tenantId])
  await db.query('DELETE FROM human_tasks WHERE tenant_id = $1', [tenantId])
  await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [tenantId])
  await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [tenantId])
}

describe.skipIf(!url)('a generated picture, approved and drained to a local pages stand-in', () => {
  let pool: Pool
  let fake: Server
  let config: PageHostConfig
  const captured: Captured[] = []

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
    const db = getDbClient()
    await resetTenant(db, TENANT)
    await resetTenant(db, TENANT_GHOST)

    fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        // `latin1`, and not `utf8`: the body carries a PNG, and a utf8 decode of
        // bytes above 0x7f replaces them, so `fieldOf`'s regex would be reading a
        // body that no longer contains the fields it is looking for. latin1 is a
        // lossless byte-to-code-unit mapping, so the markup fields still match and
        // `body` below still holds the picture untouched.
        captured.push({
          branch: fieldOf(body.toString('latin1'), 'branch'),
          manifest: fieldOf(body.toString('latin1'), 'manifest'),
          body,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            result: {
              id: `dep-${captured.length}`,
              url: `https://dep-${captured.length}.example.pages.dev`,
              created_on: '2026-11-02T00:00:00Z',
            },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address() as AddressInfo
    config = {
      accountId: 'acc',
      project: 'proj',
      apiToken: 'tok',
      productionBranch: 'main',
      previewBranchPrefix: 'crum-preview',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    }
  })

  afterAll(async () => {
    __imageProviderRegistry.clear()
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    await pool.end()
    await closeDbClient()
  })

  it('publishes the generated picture inside the hash the approval signed', async () => {
    const db = getDbClient()
    const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
    const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))
    try {
      registerImageAdapter(stubAdapter())
      setSelectedImageProvider('stub')
      // A page that names the picture the designer has not generated yet: this is
      // the order the tools actually run in, and the reason the handle is a title.
      const saved = (await saveBundleTool.execute!(
        {
          ...bundleInput(),
          funnelPlan: { page: { slug: 'physio-picture' } },
          artifacts: [
            { role: 'creative-designer', kind: 'script', documentId: null, textContent: ASSET_TEXT },
            { role: 'funnel-builder', kind: 'page_html', documentId: null, textContent: PAGE_HTML },
          ],
        } as never,
        context,
      )) as { bundleId: string }
      const bundleId = saved.bundleId

      const generated = (await generateAssetsTool.execute!({ bundleId }, context)) as {
        assets: Array<{ name: string }>
        refused: unknown[]
      }
      // `refused` is asserted empty because it is the difference between this case
      // proving the picture reached the wire and proving nothing at all: a spend
      // ceiling, an unconfigured adapter or an unparsable artifact all leave the
      // bundle without a picture, and every assertion after this one would then be
      // reading a stage refusal.
      expect(generated.refused).toEqual([])
      expect(generated.assets.map((asset) => asset.name)).toEqual(['hero'])
      // The generator writes the document as `needs_review`, and stage refuses on
      // that, so the human flip is part of this path rather than a fixture.
      await db.query("UPDATE documents SET status = 'ready' WHERE tenant_id = $1 AND kind = 'marketing_asset'", [
        TENANT,
      ])
      const staged = (await stageBundleTool.execute!(
        { bundleId, requestedCeilingMinor: 2500 },
        context,
      )) as { pendingWriteId: string; message: string }
      expect(staged.message).toContain('physio-picture')

      const stageDraft = await getPendingWrite(staged.pendingWriteId, TENANT)
      const stageHash = String((stageDraft!.payload as Record<string, unknown>)['siteHash'])

      // One page, four readers. The approval, the retry, the promote and the
      // publisher must all answer the same hash, and the two below are the first
      // and the last of them.
      const viaCurrentSiteHash = await currentSiteHash(TENANT, bundleId)
      expect(viaCurrentSiteHash).toBe(stageHash)

      await commitBundleApproval(db, {
        tenantId: TENANT,
        bundleId,
        receiptId: null,
        expectedSiteHash: stageHash,
      })
      const drained = await drainOnce({ bundleId })
      expect(drained.succeeded).toBe(1)

      const row = await db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
        [bundleId],
      )
      const files = await readSiteFiles(
        { action: 'publish_page', payload: row.rows[0]!.payload } as never,
        TENANT,
      )
      expect(siteHashOf(files)).toBe(stageHash)
      const asset = files.find((f) => f.contentType === 'image/png')
      expect(asset?.path).toMatch(/^physio-picture\/assets\/[0-9a-f-]{36}\.png$/)
      // The load-bearing line: the picture the site hash covered is the picture
      // the stub handed back after a real `bytea` round trip, not a re-encoding of
      // it and not another file's bytes.
      expect(asset?.content).toEqual(PNG_A)

      const upload = captured.at(-1)!
      const manifest = JSON.parse(upload.manifest) as Record<string, string>
      expect(Object.keys(manifest)).toHaveLength(2)
      expect(manifest[asset!.path]).toBe(asset!.sha256)
      // Spec section 13 case 1's other half: the page the host received carries the
      // resolved path and no longer asks for a picture. The leading slash is not a
      // typo: it is what binds the check to the page. `assetPathOf`
      // (`src/marketing/site.ts`) puts `/${slug}/assets/<documentId>.<ext>` into the
      // markup, while the manifest key is the same string without the slash — so the
      // bare form was satisfied by the manifest part and proved nothing about the page.
      expect(upload.body.toString('latin1')).toContain('/' + asset!.path)
      expect(upload.body.toString('latin1')).not.toContain('{{ASSET:')
      // The bytes the hash names are in the body the host received. That is the whole
      // of what these two lines can see: a containment check proves the picture
      // travelled, not which part of the multipart body it sits in — the per-part
      // labelling is proven in the unit lane (`tests/marketing/page-host.test.ts:243-244`).
      // `Uint8Array.from` is the copy the byte lane makes in `plainBytesOf`
      // (`src/db/marketing-assets.ts`): `.subarray()` answers a Buffer, and Vitest
      // compares the two as different types, so the copy makes it a byte comparison.
      const wire = Uint8Array.from(
        upload.body.subarray(upload.body.indexOf(PNG_A), upload.body.indexOf(PNG_A) + PNG_A.length),
      )
      expect(wire).toEqual(PNG_A)
      expect(upload.body.toString('latin1')).toContain('Content-Type: image/png')
      expect(upload.branch).toBe('crum-preview/physio-picture')
    } finally {
      unregisterPublish()
      unregisterPromote()
    }
  })

  /**
   * The null answer the same reader gives a page whose picture does not exist.
   * `siteHashInTransaction` returns null rather than throwing when `siteProblem`
   * has an answer (`src/db/marketing.ts`), and that branch is what turns the asset
   * lane into a refusal on the retry and promote paths, because `currentSiteHash`
   * is their only window on the page. No unit test reaches it with an asset
   * problem: the mocked reads there never carry a `document_files` row, so the byte
   * question is never asked. The second line is what makes the first one evidence:
   * a bundle with no page slug also hashes to null, so a lone `toBeNull` passes for
   * the wrong reason. The positive control is the case above, where the same reader
   * returns the staged hash.
   */
  it('answers null, and names the asset, for a page that asks for a picture it does not have', async () => {
    const saved = (await saveBundleTool.execute!(
      {
        ...bundleInput({
          brief: 'Book more physio assessments in Melbourne for owner-led clinics, ghost case',
          funnelPlan: { page: { slug: 'physio-ghost' } },
          artifacts: [{ role: 'funnel-builder', kind: 'page_html', documentId: null, textContent: GHOST_PAGE_HTML }],
        }),
      } as never,
      ghostContext,
    )) as { bundleId: string }
    const bundleId = saved.bundleId

    expect(await currentSiteHash(TENANT_GHOST, bundleId)).toBeNull()
    expect(siteProblem(await loadSiteArtifacts(TENANT_GHOST, bundleId))).toContain('asset_name_missing')
  })
})

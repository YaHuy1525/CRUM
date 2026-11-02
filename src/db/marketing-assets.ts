// src/db/marketing-assets.ts
// The asset lane for slice 4: one generated image in, one documents row plus one
// document_files row out, and the three reads the tool and the two routes need.
// There is no marketing_assets table, because an image is a document (spec
// section 4.1) and the byte lane already exists.

import { createHash } from 'node:crypto'
import { getDbClient, type Queryable } from './client'
import { insertDocument } from './documents'
import { assetNamesReferenced, type SiteArtifact } from '../marketing/site'

export interface AssetProvenance {
  replicateId: string
  model: string
  aspectRatio: string
  negativePrompt: string | null
  costMinor: number
  seed: number
  prompt: string
}

/**
 * Synchronous on purpose. `createHash` is CPU work on bytes already in memory, and
 * this repo lints with BOTH `require-await` (an `async` function must await
 * something) and `await-thenable` (a caller must not await a non-thenable), so a
 * Promise-returning pure function is illegal on one side and an `await`-ing caller
 * illegal on the other. Same shape as the sync sha256 helper in
 * `src/marketing/meta-conversions.ts:58`.
 */
export function hashImageBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The dedup lookup, on the same uq_document_hash the upload lane uses. For an
 * image the content being fingerprinted is the bytes rather than extracted text,
 * which is the same rule with a different input.
 */
export async function findAssetByHash(
  tenantId: string,
  contentHash: string,
): Promise<{ id: string; status: string } | null> {
  const result = await getDbClient().query<{ id: string; status: string }>(
    `SELECT id, status FROM documents WHERE tenant_id = $1 AND content_hash = $2 LIMIT 1`,
    [tenantId, contentHash],
  )
  const row = result.rows[0]
  return row ? { id: row.id, status: row.status } : null
}

/**
 * One image, through the existing document insert, so a generated asset inherits
 * the hash dedup, the provenance columns and a review status a human can flip.
 *
 * `parse` is null and there are no blocks: nothing was extracted from a PNG. That
 * makes the file write a sibling of the parse write rather than a child of it,
 * which is the guard hoist Task 2 exists for — without it the row below stores its
 * metadata and loses its bytes.
 */
export async function insertAssetDocument(params: {
  tenantId: string
  ownerId: string
  title: string
  bytes: Uint8Array
  mime: string
  provenance: AssetProvenance
}): Promise<{ id: string; status: string; contentHash: string; deduplicated: boolean }> {
  // Refused before the hash rather than after it. `hashImageBytes(new Uint8Array(0))`
  // is `e3b0c442…`, which is also sha256 of the empty string — the fingerprint the
  // text lane gives a document with nothing extracted from it. So an empty image
  // would dedup onto somebody's blank invoice row and return a `document_id` whose
  // kind is not `marketing_asset`: a bytes route that 404s forever, for an asset
  // that was never stored. Task 3's download already refuses zero bytes, so this is
  // the lane defending itself against the caller spec section 9 asks for later.
  if (params.bytes.byteLength === 0) {
    throw new Error(`insertAssetDocument: "${params.title}" carries 0 bytes, which is not an image`)
  }
  const contentHash = hashImageBytes(params.bytes)
  const existing = await findAssetByHash(params.tenantId, contentHash)
  if (existing) {
    // No second insert, so no overwrite of a status a human already set, and no
    // second spend row for the same bytes.
    return { id: existing.id, status: existing.status, contentHash, deduplicated: true }
  }

  const inserted = await insertDocument({
    tenantId: params.tenantId,
    ownerId: params.ownerId,
    kind: 'marketing_asset',
    title: params.title,
    source: 'generated',
    sourceRef: null,
    contentHash,
    contentText: params.provenance.prompt,
    mime: params.mime,
    status: 'needs_review',
    confidence: null,
    customerId: null,
    rawExtract: params.provenance,
    file: { mime: params.mime, sizeBytes: params.bytes.byteLength, data: params.bytes },
    parse: null,
  })

  return { id: inserted.id, status: inserted.status, contentHash, deduplicated: false }
}

/**
 * The bytes lane, with the kind check inside the query rather than after it: the
 * asset route must not become a way to read somebody's invoice PDF (spec section
 * 8.3 says 404 for that reason, and this query is what makes the 404 reachable).
 */
export async function getAssetBytes(
  tenantId: string,
  documentId: string,
): Promise<{ kind: string; status: string; mime: string; data: Uint8Array } | null> {
  const result = await getDbClient().query<{
    kind: string
    status: string
    mime: string
    // node-pg hands a `bytea` back as a Buffer, and `@types/node` declares
    // `interface Buffer extends Uint8Array`, so `Uint8Array` already types both
    // the driver's value and a test's plain view. An explicit
    // `instanceof Uint8Array ? … : new Uint8Array(…)` fallback was here and is
    // gone: TypeScript narrows its false branch to `never`, and the runtime it
    // imagined was worse than the crash it prevented — `new Uint8Array(5)`
    // answers five zero bytes and `new Uint8Array('abc')` answers none, so a
    // malformed driver value would have been served as a silently empty 200.
    data: Uint8Array
  }>(
    `SELECT d.kind, d.status, f.mime, f.data
       FROM document_files f
       JOIN documents d ON d.id = f.document_id
      WHERE f.document_id = $1 AND f.tenant_id = $2 AND d.kind = 'marketing_asset'
      LIMIT 1`,
    [documentId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { kind: row.kind, status: row.status, mime: row.mime, data: row.data }
}

/**
 * A `bytea` comes back from node-pg as a `Buffer`, and `Buffer` *is* a
 * `Uint8Array` — which is the trap rather than the excuse: its `.slice()` answers a
 * view of the driver's shared allocation pool instead of a copy, and the pool is
 * the memory the next small read on that connection writes over. The byte reads
 * hand their value straight to a `sha256` and then to an upload, so the conversion
 * is made here, once, and it copies. What reaches it is the caller's business and
 * not this function's promise: it copies every value it is handed, one per row, and
 * `loadSiteArtifacts` is the caller that keeps the list to the images a page
 * references. `getAssetBytesByIds` itself will copy whatever id list it is given.
 */
function plainBytesOf(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value)
}

/**
 * The one batched byte read. `getAssetBytes` stays for the single-document route
 * because that route needs the kind and status columns too, and a second
 * per-document call in a loop would be N round trips to answer one question the
 * site already knows the whole list of.
 */
export async function getAssetBytesByIds(
  tenantId: string,
  documentIds: readonly string[],
  client: Queryable = getDbClient(),
): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>()
  if (documentIds.length === 0) return found
  const result = await client.query<{ document_id: string; data: Uint8Array }>(
    // `document_id` is unique per document in this lane, and the LIMIT in the
    // sibling read at `getAssetBytes` is there for the same reason. A second file
    // row for one document would silently pick one, so the map keeps the first
    // rather than pretending the question has no answer.
    `SELECT f.document_id, f.data
       FROM document_files f
      WHERE f.tenant_id = $1 AND f.document_id = ANY($2::uuid[])
        AND EXISTS (
              SELECT 1 FROM documents k
               WHERE k.id = f.document_id AND k.kind = 'marketing_asset'
            )
      ORDER BY f.created_at ASC`,
    [tenantId, [...documentIds]],
  )
  for (const row of result.rows) {
    if (!found.has(row.document_id)) found.set(row.document_id, plainBytesOf(row.data))
  }
  return found
}

/**
 * The artifacts of one bundle, in the shape `resolveSite` reads, with the bytes of
 * only the images a page actually references.
 *
 * Two reads rather than one, and the second only when there is something to read:
 * the first names the referenced documents, the second fetches their bytes. A
 * single join that always pulled `document_files.data` would put every megabyte a
 * bundle ever paid for into memory to hash a page that mentions none of them, and
 * Cloudflare's per-request body limit is where that mistake would surface.
 *
 * Every row of the bundle comes back, not just the three kinds a site can carry:
 * `marketing.stage_bundle` counts this list for its payload, and a loader that
 * quietly filtered the count would move a number a reviewer is shown.
 *
 * The `k` alias and the `EXISTS` are load-bearing, not tidiness: this file's
 * sibling status read is matched by the fragment `'JOIN documents d'` in the stub
 * harness of `tests/mastra/marketing-write-tools.test.ts`, and a loader carrying
 * that fragment would be answered with status rows instead of artifact rows. These
 * two reads stay matchable by `'FROM marketing_artifacts'` and
 * `'FROM document_files'` alone.
 */
export async function loadSiteArtifacts(
  tenantId: string,
  bundleId: string,
  client: Queryable = getDbClient(),
): Promise<SiteArtifact[]> {
  const rows = await client.query<{
    id: string
    kind: string
    text_content: string | null
    document_id: string | null
    title: string | null
    mime: string | null
  }>(
    `SELECT a.id, a.kind, a.text_content, a.document_id, k.title, k.mime
       FROM marketing_artifacts a
       LEFT JOIN documents k ON k.id = a.document_id
      WHERE a.tenant_id = $1 AND a.bundle_id = $2
      ORDER BY a.created_at ASC`,
    [tenantId, bundleId],
  )
  const artifacts: SiteArtifact[] = rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    textContent: row.text_content,
    documentId: row.document_id,
    title: row.title,
    mime: row.mime,
  }))

  const referenced = new Set(artifacts.flatMap((a) => (a.kind === 'page_html' || a.kind === 'thank_you_html' ? assetNamesReferenced(a.textContent ?? '') : [])))
  // `typeof … === 'string'` and not `!== null` on both sides: `documentId` is
  // optional on `SiteArtifact`, so the absent key is `undefined`, and a `null` test
  // alone would let it into the byte read. The two predicates below are the same
  // question — which images does this page pay for — so they are written the same
  // way: an image the byte read was asked for but never handed `bytes` would be a
  // resolver refusing `asset_bytes_missing` on a picture that exists.
  const want = artifacts
    .filter((a) => a.kind === 'image' && typeof a.documentId === 'string' && referenced.has((a.title ?? '').trim()))
    .map((a) => a.documentId as string)
  if (want.length === 0) return artifacts

  const bytes = await getAssetBytesByIds(tenantId, want, client)
  for (const artifact of artifacts) {
    if (artifact.kind !== 'image' || typeof artifact.documentId !== 'string') continue
    if (!referenced.has((artifact.title ?? '').trim())) continue
    // Set explicitly rather than left absent, so a document with no file row is
    // `null` — the state `resolveAssets` refuses as `asset_bytes_missing` — and a
    // caller that reads the key gets the same answer the resolver reads.
    artifact.bytes = bytes.get(artifact.documentId) ?? null
  }
  return artifacts
}

/**
 * The prompts the asset pass will spend on, read back from the stored designer
 * artifact rather than from a model's arguments. Newest first, because a bundle
 * re-saved with a revised creative set has two script rows and the pass must
 * render the one the reviewer just read.
 */
export async function getDesignerArtifactText(tenantId: string, bundleId: string): Promise<string | null> {
  const result = await getDbClient().query<{ text_content: string | null }>(
    `SELECT text_content
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2 AND role = 'creative-designer' AND kind = 'script'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, bundleId],
  )
  return result.rows[0]?.text_content ?? null
}

/**
 * Every image artifact in a bundle with the kind and status of the document behind
 * it. One read, two questions: `marketing.generate_assets` uses it as "what does
 * this bundle already carry", keyed on the title, and `marketing.stage_bundle`
 * uses it as "what must a reviewer look at before this bundle can be decided",
 * which is the rows whose kind is `marketing_asset` and whose status is not
 * `ready`. The status filter is deliberately not in the SQL, because the first
 * caller has to keep seeing a reviewed image it has already paid for, and because
 * a refusal a unit test cannot reach is a refusal nobody can prove (Ruling 8a).
 *
 * The artifact's own `status` is deliberately not read here. It is a review state
 * on the attachment row (`pending_review`, `approved`, `rejected` — the CHECK at
 * migrations/0018_crum_marketing.sql:68), which is a different question from
 * whether the picture has been approved, and a `rejected` attachment row still has
 * to name its picture to whoever is staging the bundle. The title travels rather
 * than a bare uuid because an owner told "needs_review" has to work out which
 * picture is meant.
 */
export async function listImageAssetStatuses(
  tenantId: string,
  bundleId: string,
): Promise<Array<{ documentId: string; title: string; status: string; kind: string }>> {
  const result = await getDbClient().query<{
    document_id: string
    title: string
    status: string
    kind: string
  }>(
    `SELECT a.document_id, d.title, d.status, d.kind
       FROM marketing_artifacts a
       JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id = $1 AND a.bundle_id = $2 AND a.kind = 'image' AND a.document_id IS NOT NULL
      ORDER BY d.title ASC, a.id ASC`,
    [tenantId, bundleId],
  )
  return result.rows.map((row) => ({
    documentId: row.document_id,
    title: row.title,
    status: row.status,
    kind: row.kind,
  }))
}

/**
 * Which bundles hold this document. The bytes route gates on the answer: an asset
 * belongs to a bundle, and the prediction gate is a property of the bundle's open
 * stage draft, not of the file.
 */
export async function listBundleIdsForDocument(tenantId: string, documentId: string): Promise<string[]> {
  const result = await getDbClient().query<{ bundle_id: string }>(
    `SELECT DISTINCT bundle_id
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, documentId],
  )
  return result.rows.map((row) => row.bundle_id)
}

// src/db/marketing-assets.ts
// The asset lane for slice 4: one generated image in, one documents row plus one
// document_files row out, and the three reads the tool and the two routes need.
// There is no marketing_assets table, because an image is a document (spec
// section 4.1) and the byte lane already exists.

import { createHash } from 'node:crypto'
import { getDbClient } from './client'
import { insertDocument } from './documents'

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
    data: Uint8Array | Buffer
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
  return {
    kind: row.kind,
    status: row.status,
    mime: row.mime,
    // node-pg hands a bytea back as a Buffer, which IS a Uint8Array; the guard is
    // for the driver-free paths in tests, not for production.
    data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data),
  }
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
 * Every image artifact in a bundle with the status of the document behind it.
 * marketing.stage_bundle refuses on a non-ready row found here and names the
 * title (spec section 6.1), so the title travels rather than a bare uuid: an
 * owner who is told "needs_review" has to work out which picture they mean.
 */
export async function listImageAssetStatuses(
  tenantId: string,
  bundleId: string,
): Promise<Array<{ documentId: string; title: string; status: string }>> {
  const result = await getDbClient().query<{ document_id: string; title: string; status: string }>(
    `SELECT a.document_id, d.title, d.status
       FROM marketing_artifacts a
       JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id = $1 AND a.bundle_id = $2 AND a.kind = 'image' AND a.document_id IS NOT NULL
      ORDER BY d.title ASC, a.id ASC`,
    [tenantId, bundleId],
  )
  return result.rows.map((row) => ({ documentId: row.document_id, title: row.title, status: row.status }))
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

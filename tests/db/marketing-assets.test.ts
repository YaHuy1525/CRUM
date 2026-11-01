// tests/db/marketing-assets.test.ts
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
// `() => Promise.resolve(mockClient)` and not `async () => mockClient`: this repo
// lints with `@typescript-eslint/require-await` as an error, so an async body with
// nothing to await fails the gate. Same shape as tests/db/documents-asset-lane.test.ts:9.
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DOC = '99999999-9999-4999-8999-999999999999'
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10])

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

/**
 * Route by SQL fragment so one mock answers the hash lookup, the document insert
 * and the file insert without any test having to know which call number it is on.
 * The handler returns a resolved Promise instead of being `async` because
 * `require-await` is an error here and there is nothing to await.
 */
function route(handlers: Array<{ match: string; rows: unknown[] }>) {
  mockQuery.mockImplementation((sql: unknown) => {
    for (const handler of handlers) {
      if ((sql as string).includes(handler.match)) return Promise.resolve({ rows: handler.rows })
    }
    return Promise.resolve({ rows: [] })
  })
}

async function load() {
  return await import('../../src/db/marketing-assets')
}

const PROVENANCE = {
  replicateId: 'pred-1',
  model: 'black-forest-labs/flux-1.1-pro',
  aspectRatio: '16:9',
  negativePrompt: 'watermark',
  costMinor: 4,
  seed: 4217,
  prompt: 'a physio clinic reception at dawn',
}

const HASHED = sha(BYTES)

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('insertAssetDocument', () => {
  it('writes the widened kind, the generated source, needs_review, and the bytes', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    expect(result).toEqual({ id: DOC, status: 'needs_review', contentHash: HASHED, deduplicated: false })

    const [insert] = calls('INSERT INTO documents')
    expect(insert!.params).toContain('marketing_asset')
    expect(insert!.params).toContain('generated')
    expect(insert!.params).toContain('needs_review')
    expect(insert!.params).toContain(HASHED)
    // The prompt is content_text, because the column is NOT NULL and the prompt is
    // the provenance a reviewer needs (spec 4.1).
    expect(insert!.params).toContain(PROVENANCE.prompt)

    const [file] = calls('INSERT INTO document_files')
    expect(file!.params).toEqual([DOC, TENANT, 'image/png', BYTES.byteLength, BYTES])
  })

  it('reuses an identical image and never re-pays for it', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [{ id: DOC, status: 'ready' }] },
    ])
    const { insertAssetDocument } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    expect(result.deduplicated).toBe(true)
    expect(result.id).toBe(DOC)
    expect(result.status).toBe('ready')
    // The lookup behind the reuse is the tenant-scoped hash read, and its pair is
    // ordered (tenant, hash). A swapped pair asks Postgres for "the tenant whose
    // id is this digest", matches nothing, and pays for an image the tenant
    // already owns — which no other assertion in this case can see.
    const [lookup] = calls('FROM documents WHERE tenant_id = $1 AND content_hash = $2')
    expect(lookup!.params).toEqual([TENANT, HASHED])
    // A reused hash must not touch the byte lane a second time, and must not
    // overwrite a status a human already set.
    expect(calls('INSERT INTO documents')).toHaveLength(0)
    expect(calls('INSERT INTO document_files')).toHaveLength(0)
  })

  it('keeps the negative prompt in raw_extract, where a future model can use it', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 't',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    const [insert] = calls('INSERT INTO documents')
    // raw_extract is the thirteenth parameter and the thirteenth value is passed
    // through JSON.stringify by insertDocument (src/db/documents.ts:214).
    // The `as Record<string, unknown>` is not decoration: `no-unsafe-assignment`
    // is an error in this repo, and a bare JSON.parse hands back `any`.
    const raw = JSON.parse(insert!.params[12] as string) as Record<string, unknown>
    // All seven provenance fields, not a picked four: raw_extract exists so that a
    // future re-fetch (spec section 9) can redo this exact render, and a model
    // name, an aspect ratio or a cost that quietly stopped travelling is precisely
    // the loss a subset assertion cannot see. `toEqual` rather than
    // `toMatchObject` because this column holds the provenance and nothing else.
    expect(raw).toEqual(PROVENANCE)
  })

  it('names the sha256 of the bytes, not of the prompt, as the content hash', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument, hashImageBytes } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    // Both sides go through the module's own helper, so this compares two things
    // the code hashed rather than two things the test hashed: `sha()` above is the
    // test's copy of the digest, so an implementation that stringified its input
    // still satisfied it. The first line is the discriminator — a lane that hashed
    // the prompt would answer the prompt digest here and fail.
    expect(result.contentHash).toBe(hashImageBytes(BYTES))
    expect(result.contentHash).not.toBe(hashImageBytes(new TextEncoder().encode(PROVENANCE.prompt)))
    // And the value that reached the hash column is the value returned, position 7
    // of the INSERT list (`content_hash` is the seventh column at
    // src/db/documents.ts:197).
    const [insert] = calls('INSERT INTO documents')
    expect(insert!.params[6]).toBe(result.contentHash)
  })

  it('refuses an image with no bytes, because its digest is the empty-text digest', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    await expect(
      insertAssetDocument({
        tenantId: TENANT,
        ownerId: OWNER,
        title: 'empty',
        bytes: new Uint8Array(0),
        mime: 'image/png',
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/0 bytes/)
    // The refusal is before the database, so neither door is reached: a row written
    // here would be a document whose bytes are absent, which is the state this
    // guard exists to keep out of the asset lane.
    expect(calls('FROM documents WHERE tenant_id')).toHaveLength(0)
    expect(calls('INSERT INTO documents')).toHaveLength(0)
  })
})

describe('the reads', () => {
  it('reads bytes back scoped to the tenant, and only for an asset kind', async () => {
    route([
      {
        match: 'FROM document_files f',
        rows: [{ kind: 'marketing_asset', status: 'needs_review', mime: 'image/png', data: BYTES }],
      },
    ])
    const { getAssetBytes } = await load()
    expect(await getAssetBytes(TENANT, DOC)).toEqual({
      kind: 'marketing_asset',
      status: 'needs_review',
      mime: 'image/png',
      data: BYTES,
    })
    const [call] = calls('FROM document_files f')
    expect(call!.sql).toContain("d.kind = 'marketing_asset'")
    expect(call!.params).toEqual([DOC, TENANT])
  })

  it('returns null for a document that is not a marketing asset', async () => {
    route([{ match: 'FROM document_files f', rows: [] }])
    const { getAssetBytes } = await load()
    expect(await getAssetBytes(TENANT, DOC)).toBeNull()
  })

  it('reads the newest creative-designer script artifact text', async () => {
    route([{ match: 'FROM marketing_artifacts', rows: [{ text_content: '{"assets":[]}' }] }])
    const { getDesignerArtifactText } = await load()
    expect(await getDesignerArtifactText(TENANT, BUNDLE)).toBe('{"assets":[]}')
    const [call] = calls('FROM marketing_artifacts')
    expect(call!.sql).toContain("role = 'creative-designer'")
    expect(call!.sql).toContain("kind = 'script'")
    expect(call!.params).toEqual([TENANT, BUNDLE])
  })

  it('names each image artifact with its document status, for the stage refusal', async () => {
    route([
      {
        match: 'FROM marketing_artifacts a',
        rows: [{ document_id: DOC, title: 'hero-image', status: 'needs_review' }],
      },
    ])
    const { listImageAssetStatuses } = await load()
    expect(await listImageAssetStatuses(TENANT, BUNDLE)).toEqual([
      { documentId: DOC, title: 'hero-image', status: 'needs_review' },
    ])
    const [call] = calls('FROM marketing_artifacts a')
    expect(call!.sql).toContain("a.kind = 'image'")
    expect(call!.sql).toContain('JOIN documents d')
    // The predicate and the pair, not only the projection. Task 8 reads an EMPTY
    // list as "this bundle has no images, so there is nothing to refuse", so a
    // dropped `a.tenant_id = $1` or a swapped [bundleId, tenantId] shows another
    // tenant's images as absent and stages a bundle full of unreviewed faces. The
    // mock answers that broken query with the same row this test supplies, which
    // is exactly why the SQL text and the parameter order have to be asserted here
    // rather than inferred from the mapped result.
    expect(call!.sql).toContain('a.tenant_id = $1')
    expect(call!.sql).toContain('a.bundle_id = $2')
    expect(call!.params).toEqual([TENANT, BUNDLE])
  })

  it('lists the bundles that carry a document, for the bytes-route gate', async () => {
    route([{ match: 'FROM marketing_artifacts', rows: [{ bundle_id: BUNDLE }] }])
    const { listBundleIdsForDocument } = await load()
    expect(await listBundleIdsForDocument(TENANT, DOC)).toEqual([BUNDLE])
    // Same reason as the stage list above, with the directions reversed: this read
    // gates Task 12's bytes route, so an unscoped version answers SOME bundle for
    // any caller and serves a document to a tenant that does not own it. Asserting
    // only the mapped array would pass against that query.
    const [call] = calls('DISTINCT bundle_id')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('document_id = $2')
    expect(call!.params).toEqual([TENANT, DOC])
  })
})

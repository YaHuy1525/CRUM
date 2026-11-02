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

type Row = Record<string, unknown>

/**
 * The documents behind the artifact fixtures. The byte read is keyed on
 * `document_id`, so one test has to name the same uuid in two places — the
 * artifact row the first query answers and the file row the second one does —
 * and a literal uuid pasted twice proves nothing about the key the loader
 * actually joined on.
 */
const DOC_IDS: Record<string, string> = {
  a1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa1',
  a2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa2',
  a3: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa3',
}

function docId(artifactId: string): string {
  const id = DOC_IDS[artifactId]
  if (id === undefined) throw new Error(`docId: no document id is registered for artifact ${artifactId}`)
  return id
}

/**
 * One artifact row, shaped exactly as `loadSiteArtifacts`' first query selects
 * it: the artifact columns plus the two enrichment columns that come from the
 * joined document row (`title`, `mime`). `textContent` is accepted beside
 * `text_content` because the field the resolver reads is camelCase, and a fixture
 * that set the wrong key would read as a page with no copy rather than as a page.
 */
function artifactRow(over: Row = {}): Row {
  const id = typeof over.id === 'string' ? over.id : 'a1'
  const kind = typeof over.kind === 'string' ? over.kind : 'page_html'
  const { textContent, ...rest } = over
  return {
    id,
    kind,
    // Only an image row carries a document: that is the key the byte read is made
    // from, and a page row's `document_id` is never read.
    document_id: kind === 'image' ? docId(id) : null,
    text_content: '<h1>hi</h1>',
    title: null,
    mime: null,
    ...(textContent === undefined ? {} : { text_content: textContent }),
    ...rest,
  }
}

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
        rows: [{ document_id: DOC, title: 'hero-image', status: 'needs_review', kind: 'marketing_asset' }],
      },
    ])
    const { listImageAssetStatuses } = await load()
    expect(await listImageAssetStatuses(TENANT, BUNDLE)).toEqual([
      { documentId: DOC, title: 'hero-image', status: 'needs_review', kind: 'marketing_asset' },
    ])
    const [call] = calls('FROM marketing_artifacts a')
    // The kind travels as a projected column rather than as a WHERE predicate, so
    // the caller can tell a generated image from an invoice an image artifact
    // happens to point at (Ruling 8b).
    expect(call!.sql).toContain('d.kind')
    // Ruling 8a's guard rail, stated as a prohibition: `d.kind` and `d.status`
    // may appear as projected columns and nowhere else, because a SQL-side
    // filter hides the `ready` rows Task 6's carry check reads and the bundle
    // re-buys an image the tenant already owns.
    expect(call!.sql).not.toMatch(/d\.(status|kind)\s*(=|<>|!=)/)
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

  it('carries the document kind and still returns a reviewed image, because the caller decides', async () => {
    route([
      {
        match: 'FROM marketing_artifacts a',
        rows: [
          { document_id: DOC, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
          { document_id: DOC, title: 'founder-portrait', status: 'needs_review', kind: 'marketing_asset' },
        ],
      },
    ])
    const { listImageAssetStatuses } = await load()
    const rows = await listImageAssetStatuses(TENANT, BUNDLE)
    // Both rows survive the read. Task 6's carry check is the reason: it pays for
    // an asset only when this list does not already name it, so a `ready` row
    // filtered out here would re-buy an image the tenant owns. The stage refusal
    // is the other caller, and it does its own filtering (Ruling 8a).
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.title).sort()).toEqual(['founder-portrait', 'hero-image'])
    expect(rows.every((row) => row.kind === 'marketing_asset')).toBe(true)
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

describe('loadSiteArtifacts', () => {
  it('reads the artifact rows without touching the data column', async () => {
    const { loadSiteArtifacts } = await load()
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [artifactRow()] }) }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client)
    expect(artifacts[0]).toMatchObject({ kind: 'page_html', textContent: '<h1>hi</h1>' })
    expect(client.query.mock.calls[0]![0]).not.toContain('f.data')
    expect(client.query.mock.calls[0]![0]).toContain('k.title')
    // The order is the promise the interface makes — the same `created_at ASC`
    // `listMarketingArtifacts` reads with, so the two reads of one bundle agree on
    // which artifact is first. The mock answers with whatever rows the fixture
    // supplies, so only the SQL text can show the sort was dropped.
    expect(client.query.mock.calls[0]![0]).toContain('ORDER BY a.created_at ASC')
    // The alias is a test-harness requirement, not a style choice. Read the note
    // under Step 2: eight stage fixtures route their artifact read by SQL
    // fragment, and a loader whose SQL contains `JOIN documents d` gets answered
    // with the wrong rows.
    expect(client.query.mock.calls[0]![0]).not.toContain('JOIN documents d')
    expect(client.query.mock.calls[0]![0]).not.toContain('FROM document_files')
  })

  it('reads bytes for exactly the documents a page references, in one second query', async () => {
    const { loadSiteArtifacts } = await load()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [artifactRow({ kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' }), artifactRow({ id: 'a2', kind: 'image', text_content: null, title: 'hero', mime: 'image/png' }), artifactRow({ id: 'a3', kind: 'image', text_content: null, title: 'unused', mime: 'image/png' })] })
        .mockResolvedValueOnce({ rows: [{ document_id: docId('a2'), data: new Uint8Array([1]) }] }),
    }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client)
    const second = client.query.mock.calls[1]!
    expect(String(second[0])).toContain('ANY($2::uuid[])')
    expect(second[1]).toEqual([TENANT, [docId('a2')]])
    expect(artifacts.find((a) => a.id === 'a2')?.bytes).toEqual(new Uint8Array([1]))
    expect(artifacts.find((a) => a.id === 'a3')?.bytes).toBeUndefined()
  })

  it('asks for no bytes at all when no page has a placeholder', async () => {
    const { loadSiteArtifacts } = await load()
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [artifactRow()] }) }
    await loadSiteArtifacts(TENANT, BUNDLE, client)
    expect(client.query).toHaveBeenCalledTimes(1)
  })

  it('hands back a null bytes for an image whose document has no file row', async () => {
    const { loadSiteArtifacts } = await load()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [artifactRow({ kind: 'page_html', textContent: '{{ASSET:hero}}' }), artifactRow({ id: 'a2', kind: 'image', text_content: null, title: 'hero', mime: 'image/png' })] })
        .mockResolvedValueOnce({ rows: [] }),
    }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client)
    expect(artifacts.find((a) => a.id === 'a2')?.bytes).toBeNull()
  })
})

describe('getAssetBytesByIds', () => {
  it('reads one batch of bytes, tenant-scoped and asset-kind only', async () => {
    const { getAssetBytesByIds } = await load()
    // A `Buffer`, because that is what node-pg hands back for a `bytea` column and
    // the interface promises a plain `Uint8Array`. The conversion is the finding:
    // a Buffer keeps `.slice()` as a view of the driver's pooled ArrayBuffer, which
    // the driver recycles, so a caller that hashed these bytes after a second query
    // could hash somebody else's.
    const source = Buffer.from([1, 2, 3])
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ document_id: docId('a2'), data: source }] }) }
    const found = await getAssetBytesByIds(TENANT, [docId('a2')], client)
    expect([...found.keys()]).toEqual([docId('a2')])
    const bytes = found.get(docId('a2'))!
    // `constructor.name` and not `instanceof`: a `Buffer` *is* a `Uint8Array`, so
    // the instanceof question answers yes to both and proves nothing about which
    // one the caller was handed.
    expect(bytes.constructor.name).toBe('Uint8Array')
    // And a copy rather than an alias: node-pg builds a small `bytea` inside a
    // shared allocation pool that the next read on the connection writes over, so
    // an aliased byte here is a hash of somebody else's picture later.
    source[0] = 9
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(String(client.query.mock.calls[0]![0])).toContain("k.kind = 'marketing_asset'")
    expect(client.query.mock.calls[0]![1]).toEqual([TENANT, [docId('a2')]])
  })

  it('issues no query at all for an empty list of documents', async () => {
    const { getAssetBytesByIds } = await load()
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const found = await getAssetBytesByIds(TENANT, [], client)
    // Not "one query that matches nothing": an empty array against `= ANY($2::uuid[])`
    // is a round trip to Postgres for an answer the caller already knows, and a
    // `[]` parameter the driver can render as an untypeable literal.
    expect(found.size).toBe(0)
    expect(client.query).not.toHaveBeenCalled()
  })
})

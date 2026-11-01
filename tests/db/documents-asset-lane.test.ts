// tests/db/documents-asset-lane.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
// One mock function for both doors, the way tests/db/marketing.test.ts:3 does
// it: queryRows goes through pool.query and insertDocument goes through
// client.query, so a separate mock for each records only half the calls.
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const DOC = '99999999-9999-4999-8999-999999999999'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/documents')
}

/**
 * insertDocument's RETURNING row decides everything downstream: is_new gates the
 * file write, so a test that wants the byte lane exercised has to answer with a
 * fresh row.
 */
function answerDocumentInsert(over: { id?: string; is_new?: boolean } = {}) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO documents')) {
      return {
        rows: [
          {
            id: over.id ?? DOC,
            status: 'needs_review',
            confidence: null,
            is_new: over.is_new ?? true,
          },
        ],
      }
    }
    return { rows: [] }
  })
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('a generated image as a document', () => {
  it('writes the byte lane for a document that has bytes and no parse run', async () => {
    answerDocumentInsert()
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'marketing_asset',
      title: 'hero-image',
      source: 'generated',
      sourceRef: null,
      contentHash: 'a'.repeat(64),
      contentText: 'a photorealistic clinic reception',
      mime: 'image/png',
      status: 'needs_review',
      confidence: null,
      customerId: null,
      rawExtract: { model: 'black-forest-labs/flux-1.1-pro' },
      file: { mime: 'image/png', sizeBytes: 4, data: new Uint8Array([1, 2, 3, 4]) },
      parse: null,
      blocks: undefined,
    })
    const fileWrites = calls('INSERT INTO document_files')
    expect(fileWrites).toHaveLength(1)
    expect(fileWrites[0]!.params).toEqual([DOC, TENANT, 'image/png', 4, expect.any(Uint8Array)])
  })

  it('still writes parse artifacts for an upload that has both', async () => {
    answerDocumentInsert()
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'invoice',
      title: 'bill',
      source: 'upload',
      sourceRef: null,
      contentHash: 'b'.repeat(64),
      contentText: 'text',
      mime: 'application/pdf',
      status: 'ready',
      confidence: 0.9,
      customerId: null,
      rawExtract: {},
      file: { mime: 'application/pdf', sizeBytes: 2, data: new Uint8Array([1, 2]) },
      parse: { parser: 'unpdf', parserVersion: '1', status: 'ok', durationMs: 5, meta: {} },
      blocks: [],
    })
    expect(calls('INSERT INTO document_files')).toHaveLength(1)
    expect(calls('INSERT INTO document_parses')).toHaveLength(1)
  })

  it('does not write the byte lane a second time for a duplicate hash', async () => {
    answerDocumentInsert({ is_new: false })
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'marketing_asset',
      title: 'hero-image',
      source: 'generated',
      sourceRef: null,
      contentHash: 'a'.repeat(64),
      contentText: 'a photorealistic clinic reception',
      mime: 'image/png',
      status: 'needs_review',
      confidence: null,
      customerId: null,
      rawExtract: {},
      file: { mime: 'image/png', sizeBytes: 4, data: new Uint8Array([1, 2, 3, 4]) },
      parse: null,
    })
    expect(calls('INSERT INTO document_files')).toHaveLength(0)
  })
})

describe('listDocuments', () => {
  it('excludes generated assets when the caller named no kind', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments({ tenantId: TENANT, userId: OWNER, userRole: 'admin' })
    const [call] = calls('FROM documents d')
    expect(call!.sql).toContain("d.kind <> 'marketing_asset'")
  })

  it('returns assets when a kind filter asks for exactly them', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments({ tenantId: TENANT, userId: OWNER, userRole: 'admin' }, {
      kind: 'marketing_asset',
    })
    const [call] = calls('FROM documents d')
    expect(call!.sql).not.toContain("d.kind <> 'marketing_asset'")
    expect(call!.params).toContain('marketing_asset')
  })
})

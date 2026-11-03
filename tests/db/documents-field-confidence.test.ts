// tests/db/documents-field-confidence.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  connect: vi.fn(() => Promise.resolve(mockClient)),
  end: vi.fn(),
}

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
  }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const DOC = '99999999-9999-4999-8999-999999999999'

const ADMIN_CTX = { tenantId: TENANT, userId: OWNER, userRole: 'admin' as const }

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

async function load() {
  return await import('../../src/db/documents')
}

describe('getDocument field_confidence resolution via LEFT JOINs', () => {
  it('resolves field_confidence from the invoice when the document has one', async () => {
    const invoiceConfidence = { vendor_name: 0.95, total: 0.88 }
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: DOC,
          tenant_id: TENANT,
          owner_id: OWNER,
          kind: 'invoice',
          title: 'Bill',
          source: 'upload',
          source_ref: null,
          content_hash: 'abc',
          mime: 'application/pdf',
          status: 'ready',
          confidence: '0.9',
          customer_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          invoice_field_confidence: invoiceConfidence,
          contract_field_confidence: null,
        },
      ],
    })

    const { getDocument } = await load()
    const doc = await getDocument(ADMIN_CTX, DOC)

    expect(doc).not.toBeNull()
    expect(doc!.field_confidence).toEqual(invoiceConfidence)

    // Verify the SQL uses LEFT JOINs to invoices and contracts
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('LEFT JOIN invoices i ON i.document_id = d.id')
    expect(sql).toContain('LEFT JOIN contracts c ON c.document_id = d.id')
    expect(sql).toContain('i.field_confidence as invoice_field_confidence')
    expect(sql).toContain('c.field_confidence as contract_field_confidence')
  })

  it('resolves field_confidence from the contract when no invoice exists', async () => {
    const contractConfidence = { counterparty: 0.82, contract_value: 0.75 }
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: DOC,
          tenant_id: TENANT,
          owner_id: OWNER,
          kind: 'contract',
          title: 'Service Agreement',
          source: 'upload',
          source_ref: null,
          content_hash: 'def',
          mime: 'application/pdf',
          status: 'ready',
          confidence: '0.8',
          customer_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          invoice_field_confidence: null,
          contract_field_confidence: contractConfidence,
        },
      ],
    })

    const { getDocument } = await load()
    const doc = await getDocument(ADMIN_CTX, DOC)

    expect(doc).not.toBeNull()
    expect(doc!.field_confidence).toEqual(contractConfidence)
  })

  it('returns null field_confidence when neither invoice nor contract has it', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: DOC,
          tenant_id: TENANT,
          owner_id: OWNER,
          kind: 'other',
          title: 'Misc',
          source: 'upload',
          source_ref: null,
          content_hash: 'ghi',
          mime: 'text/plain',
          status: 'ready',
          confidence: null,
          customer_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          invoice_field_confidence: null,
          contract_field_confidence: null,
        },
      ],
    })

    const { getDocument } = await load()
    const doc = await getDocument(ADMIN_CTX, DOC)

    expect(doc).not.toBeNull()
    expect(doc!.field_confidence).toBeNull()
  })

  it('prefers invoice field_confidence over contract when both are present', async () => {
    const invoiceConfidence = { vendor_name: 0.9 }
    const contractConfidence = { counterparty: 0.8 }
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: DOC,
          tenant_id: TENANT,
          owner_id: OWNER,
          kind: 'invoice',
          title: 'Both',
          source: 'upload',
          source_ref: null,
          content_hash: 'jkl',
          mime: 'application/pdf',
          status: 'ready',
          confidence: '0.85',
          customer_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          invoice_field_confidence: invoiceConfidence,
          contract_field_confidence: contractConfidence,
        },
      ],
    })

    const { getDocument } = await load()
    const doc = await getDocument(ADMIN_CTX, DOC)

    // invoice_field_confidence is checked first in the OR chain
    expect(doc!.field_confidence).toEqual(invoiceConfidence)
  })
})

describe('listDocuments minFieldConfidence filter', () => {
  it('adds a NOT EXISTS jsonb_each clause when minFieldConfidence is provided', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments(ADMIN_CTX, { minFieldConfidence: 0.7 })

    const sql = mockQuery.mock.calls[0]![0] as string
    const params = mockQuery.mock.calls[0]![1] as unknown[]

    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('jsonb_each(d.field_confidence)')
    expect(params).toContain(0.7)
  })

  it('omits the NOT EXISTS clause when minFieldConfidence is not provided', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments(ADMIN_CTX)

    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).not.toContain('NOT EXISTS')
    expect(sql).not.toContain('jsonb_each')
  })
})

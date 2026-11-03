import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  insertDocument: vi.fn(),
  replaceValidation: vi.fn(),
  resolveCustomerByEntity: vi.fn(() => Promise.resolve(null)),
  dbQuery: vi.fn(),
}))

vi.mock('../../../src/db/documents', () => ({
  insertDocument: h.insertDocument,
  resolveCustomerByEntity: h.resolveCustomerByEntity,
}))
vi.mock('../../../src/db/validation', () => ({ replaceValidation: h.replaceValidation }))
vi.mock('../../../src/db/client', () => ({ getDbClient: () => ({ query: h.dbQuery }) }))

import { persistStructuredStep } from '../../../src/mastra/workflows/document-intake.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '22222222-2222-4222-8222-222222222222'
const DOC = '99999999-9999-4999-8999-999999999999'

const BAD_SUM = {
  kind: 'invoice',
  normalized: {
    header: {
      vendor_name: 'Acme', vendor_email: 'billing@acme.example', invoice_number: 'INV-1',
      invoice_date: '2026-10-01', due_date: '2026-10-31', currency: 'AUD',
      subtotal: '1000.00', tax: '100.00', total: '1200.00',
    },
    lines: [{ description: 'x', quantity: '2', unit_price: '600', amount: '1200' }],
  },
  confidence: 0.95,
  needsReview: false,
  fieldConfidence: { total: 0.95 },
  customerId: null,
  tenantId: TENANT, ownerId: OWNER, title: 't', text: 'body', contentType: 'text',
  documentTitle: 't', mime: 'text/plain', source: 'upload', sourceRef: null, extract: {},
  parse: { parser: 'plain' as const, parser_version: '', status: 'ok' as const, duration_ms: 0, meta: null },
  blocks: [],
}

// WARN_ONLY: correct sum (1000+100=1100) but invalid currency shape 'AUD$'
const WARN_ONLY = {
  ...BAD_SUM,
  normalized: {
    ...BAD_SUM.normalized,
    header: { ...BAD_SUM.normalized.header, currency: 'AUD$', total: '1100.00' },
  },
}

// COMPLIANT: correct sum and valid currency
const COMPLIANT = {
  ...BAD_SUM,
  normalized: {
    ...BAD_SUM.normalized,
    header: { ...BAD_SUM.normalized.header, total: '1100.00' },
  },
}

function ctx(inputData: unknown) {
  return {
    inputData,
    getStepResult: () => undefined,
    requestContext: {},
    mastra: {},
    tracingContext: {},
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  h.insertDocument.mockResolvedValue({ id: DOC, status: 'ready', confidence: 0.95 })
  h.replaceValidation.mockResolvedValue({ openErrors: 1, openWarnings: 0 })
})

type PersistResult = { status: string; validationCount: number; openErrors: number; documentId: string }

describe('persistStructuredStep validation wiring', () => {
  it('queues a document at high confidence because the arithmetic is wrong', async () => {
    h.insertDocument.mockResolvedValue({ id: DOC })
    h.replaceValidation.mockResolvedValue({ openErrors: 1, openWarnings: 0 })
    const out = await persistStructuredStep.execute(ctx(BAD_SUM)) as unknown as PersistResult
    expect(out.status).toBe('needs_review')
    expect(out.validationCount).toBeGreaterThan(0)
  })

  it('does not let a warning alone queue a clean document', async () => {
    h.insertDocument.mockResolvedValue({ id: DOC })
    h.replaceValidation.mockResolvedValue({ openErrors: 0, openWarnings: 1 })
    const out = await persistStructuredStep.execute(ctx(WARN_ONLY)) as unknown as PersistResult
    expect(out.status).toBe('ready')
  })

  it('passes the document id and the tenant to the writer, not a guessed tenant', async () => {
    h.insertDocument.mockResolvedValue({ id: DOC })
    h.replaceValidation.mockResolvedValue({ openErrors: 1, openWarnings: 0 })
    await persistStructuredStep.execute(ctx(BAD_SUM))
    expect(h.replaceValidation).toHaveBeenCalledWith(
      expect.anything(), DOC, TENANT, expect.arrayContaining([
        expect.objectContaining({ ruleId: 'invoice.total.sum', severity: 'error' }),
      ]), 'v1',
    )
  })

  it('does not validate a document that extracted nothing', async () => {
    const out = await persistStructuredStep.execute(ctx({ ...BAD_SUM, normalized: null })) as unknown as PersistResult
    expect(h.replaceValidation).not.toHaveBeenCalled()
    expect(out.validationCount).toBe(0)
  })

  it('leaves a compliant invoice at ready', async () => {
    h.replaceValidation.mockResolvedValue({ openErrors: 0, openWarnings: 0 })
    const out = await persistStructuredStep.execute(ctx(COMPLIANT)) as unknown as PersistResult
    expect(out.status).toBe('ready')
    expect(out.validationCount).toBe(0)
  })
})

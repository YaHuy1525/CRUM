/**
 * Generates synthetic CRM business documents (invoices + contracts) as real PDF
 * and DOCX files, for testing the document-intake pipeline end to end.
 *
 * Vendor and counterparty names come from tenant 0 of the simulation seed, so
 * the extractor's entity-resolution step can match documents to `customers`
 * rows that actually exist in the database.
 *
 * Ground truth is written to fixtures/documents/manifest.csv: one row per file
 * with the values an extractor should produce, plus the defect the file was
 * built to expose (so `needs_review` cases are verifiable, not decorative).
 *
 * Run: npm run fixtures:docs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import PDFDocument from 'pdfkit'
import { generateTenantRows, type CustomerRow } from './sim-seed'

export const OUT_DIR = 'fixtures/documents'

export type DocKind = 'invoice' | 'contract' | 'other'
export type DocFormat = 'pdf' | 'docx'
export type ExpectedStatus = 'ready' | 'needs_review' | 'failed'

export interface InvoiceLineFixture {
  description: string
  quantity: number
  unitPrice: number
  amount: number
}

export interface InvoiceExpected {
  /** Supplier — the party the document was issued by. Resolves to customer.company. */
  vendorName: string
  vendorEmail: string
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  currency: string
  subtotal: number | null
  tax: number | null
  total: number | null
  lineItems: InvoiceLineFixture[]
}

export interface ContractTermFixture {
  clauseType: string
  title: string
  text: string
}

export interface ContractExpected {
  /** Counterparty — the outside organisation we signed with. */
  counterparty: string
  counterpartyEmail: string
  effectiveDate: string | null
  expiryDate: string | null
  termMonths: number | null
  contractValue: number | null
  currency: string
  autoRenewal: boolean | null
  renewalNoticeDays: number | null
  terms: ContractTermFixture[]
}

/** Format-neutral view of a document, rendered to PDF or DOCX. */
export interface DocModel {
  title: string
  blocks: Array<{ heading?: string; lines: string[] }>
}

export interface FixturePlan {
  /** Path relative to fixtures/documents, e.g. invoices/invoice-....pdf */
  file: string
  kind: DocKind
  format: DocFormat
  expectedStatus: ExpectedStatus
  /** Machine-readable defect this fixture was built to expose, or null. */
  defect: string | null
  customerId: string | null
  customerName: string | null
  invoice: InvoiceExpected | null
  contract: ContractExpected | null
  notes: string
  model: DocModel
}

// ── Deterministic helpers ────────────────────────────────────────────────

const DAY = 86_400_000
const INVOICE_BASE = Date.UTC(2026, 8, 1) // 2026-09-01
const CONTRACT_BASE = Date.UTC(2026, 6, 1) // 2026-07-01
const OUR_COMPANY = 'CRUM Pty Ltd (Accounts Payable)'
const CURRENCY = 'AUD'

const LINE_POOL = [
  'Consulting retainer',
  'Implementation services',
  'Licence - standard seat',
  'Support hours (business hours)',
  'Onboarding workshop',
  'Data migration',
  'API access - annual',
  'Training session',
  'Hardware - sensor kit',
  'Freight and handling',
] as const

const SIM_CUSTOMERS = generateTenantRows(0, { customers: 30 }).customers

function seededCustomer(index: number): CustomerRow {
  const row = SIM_CUSTOMERS[index % SIM_CUSTOMERS.length]
  if (!row) throw new Error('sim seed produced no customers — cannot build fixtures')
  return row
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 1234.5 -> "1,234.50" */
function fmt(n: number): string {
  const [whole, cents] = n.toFixed(2).split('.')
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${grouped}.${cents ?? '00'}`
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46)
}

function invoiceLines(index: number): InvoiceLineFixture[] {
  const count = 2 + (index % 3)
  return Array.from({ length: count }, (_, j) => {
    const description = LINE_POOL[(index + j) % LINE_POOL.length] ?? 'Consulting services'
    const quantity = 1 + ((index + j) % 5)
    const unitPrice = 120 + ((index * 7 + j * 13) % 40) * 25
    return { description, quantity, unitPrice, amount: round2(quantity * unitPrice) }
  })
}

function invoiceModel(input: {
  vendor: CustomerRow
  invoiceNumber: string | null
  invoiceDate: string
  dueDate: string | null
  lines: InvoiceLineFixture[]
  subtotal: number
  tax: number | null
  total: number
}): DocModel {
  const header = [
    `Invoice Date: ${input.invoiceDate}`,
    ...(input.dueDate ? [`Due Date: ${input.dueDate}`] : []),
    ...(input.invoiceNumber ? [`Invoice Number: ${input.invoiceNumber}`] : []),
    `Currency: ${CURRENCY}`,
  ]
  const totals = [`Subtotal: ${fmt(input.subtotal)}`]
  if (input.tax !== null) totals.push(`GST (10%): ${fmt(input.tax)}`)
  totals.push(`Total Due: ${fmt(input.total)}`)

  return {
    title: 'TAX INVOICE',
    blocks: [
      { heading: 'From', lines: [input.vendor.company, input.vendor.email, 'ABN 51 824 753 556'] },
      { heading: 'Bill To', lines: [OUR_COMPANY, 'Level 4, 120 Collins Street, Melbourne VIC 3000'] },
      { heading: 'Invoice Details', lines: header },
      {
        heading: 'Line Items',
        lines: input.lines.map(
          (l) => `${l.description} | ${l.quantity} x ${fmt(l.unitPrice)} | ${fmt(l.amount)}`,
        ),
      },
      { heading: 'Totals', lines: totals },
      {
        heading: 'Payment',
        lines: ['Please pay by bank transfer quoting the invoice number.', 'Terms: 30 days from invoice date.'],
      },
    ],
  }
}

function contractModel(input: {
  counterparty: CustomerRow
  effectiveDate: string | null
  expiryDate: string | null
  termMonths: number | null
  value: number | null
  autoRenewal: boolean | null
  noticeDays: number | null
  terms: ContractTermFixture[]
}): DocModel {
  const termLines = [
    ...(input.effectiveDate ? [`Effective date: ${input.effectiveDate}`] : []),
    ...(input.expiryDate ? [`Expiry date: ${input.expiryDate}`] : []),
    ...(input.termMonths !== null ? [`Term: ${input.termMonths} months`] : []),
    ...(input.autoRenewal !== null ? [`Auto renewal: ${input.autoRenewal ? 'yes' : 'no'}`] : []),
    ...(input.noticeDays !== null ? [`Renewal notice: ${input.noticeDays} days`] : []),
  ]
  const commercialLines =
    input.value !== null
      ? [`Contract value: ${fmt(input.value)} ${CURRENCY}`, 'Payment: invoiced quarterly in advance.']
      : ['Payment: invoiced quarterly in advance.']

  return {
    title: 'SUPPLIER AGREEMENT',
    blocks: [
      {
        heading: 'Parties',
        lines: [
          `This agreement is made between ${OUR_COMPANY} ("the Customer") and`,
          `${input.counterparty.company} ("the Supplier"), ${input.counterparty.email}.`,
        ],
      },
      { heading: 'Term', lines: termLines },
      { heading: 'Commercial Terms', lines: commercialLines },
      {
        heading: 'Clauses',
        lines: input.terms.map((t, i) => `${i + 1}. ${t.title} [${t.clauseType}] ${t.text}`),
      },
    ],
  }
}

const DEFAULT_TERMS: Array<Omit<ContractTermFixture, 'title'> & { title: string }> = [
  {
    clauseType: 'liability_cap',
    title: 'Limitation of Liability',
    text: 'Each party limits its aggregate liability to the fees paid in the preceding 12 months.',
  },
  {
    clauseType: 'termination',
    title: 'Termination',
    text: 'Either party may terminate for material breach with 30 days written notice to cure.',
  },
  {
    clauseType: 'confidentiality',
    title: 'Confidentiality',
    text: 'Each party keeps the other party information confidential for five years after expiry.',
  },
  {
    clauseType: 'data_protection',
    title: 'Data Protection',
    text: 'The Supplier processes personal data only on documented instructions of the Customer.',
  },
]

// ── Invoice fixtures ─────────────────────────────────────────────────────

interface InvoiceOpts {
  format: DocFormat
  status: ExpectedStatus
  defect?: string | null
  notes?: string
  omitDueDate?: boolean
  omitTax?: boolean
  omitInvoiceNumber?: boolean
  mismatchTotal?: boolean
  useSeededCustomer?: boolean
}

function invoiceFixture(index: number, customerIndex: number, opts: InvoiceOpts): FixturePlan {
  const vendor = seededCustomer(customerIndex)
  const lines = invoiceLines(index)
  const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0))
  const tax = round2(subtotal * 0.1)
  const total = round2(subtotal + tax)
  const printedTax = opts.omitTax ? null : tax
  const printedTotal = opts.mismatchTotal ? round2(total - 50) : total
  const invoiceNumber = opts.omitInvoiceNumber ? null : `INV-2026-${1000 + index}`
  const invoiceDate = isoDate(INVOICE_BASE + index * 2 * DAY)
  const dueDate = opts.omitDueDate ? null : isoDate(INVOICE_BASE + (index * 2 + 30) * DAY)

  const tag = opts.status === 'ready' ? '' : '-review'
  const file = `invoices/invoice-${invoiceNumber ?? `unumbered-${index}`}-${slug(vendor.company)}${tag}.${opts.format}`

  return {
    file,
    kind: 'invoice',
    format: opts.format,
    expectedStatus: opts.status,
    defect: opts.defect ?? null,
    customerId: opts.useSeededCustomer === false ? null : vendor.id,
    customerName: opts.useSeededCustomer === false ? null : vendor.name,
    invoice: {
      vendorName: vendor.company,
      vendorEmail: vendor.email,
      invoiceNumber,
      invoiceDate,
      dueDate,
      currency: CURRENCY,
      subtotal,
      tax: printedTax,
      total: printedTotal,
      lineItems: lines,
    },
    contract: null,
    notes: opts.notes ?? '',
    model: invoiceModel({
      vendor,
      invoiceNumber,
      invoiceDate,
      dueDate,
      lines,
      subtotal,
      tax: printedTax,
      total: printedTotal,
    }),
  }
}

// ── Contract fixtures ────────────────────────────────────────────────────

interface ContractOpts {
  format: DocFormat
  status: ExpectedStatus
  defect?: string | null
  notes?: string
  omitDates?: boolean
  omitValue?: boolean
  omitTerms?: boolean
  fileStem?: string
}

function contractFixture(index: number, customerIndex: number, opts: ContractOpts): FixturePlan {
  const counterparty = seededCustomer(customerIndex + 3)
  const termMonths = [12, 24, 36][index % 3] ?? 12
  const effective = isoDate(CONTRACT_BASE + index * 9 * DAY)
  const expiryMs = Date.UTC(
    Number(effective.slice(0, 4)),
    Number(effective.slice(5, 7)) - 1 + termMonths,
    Number(effective.slice(8, 10)),
  )
  const effectiveDate = opts.omitDates ? null : effective
  const expiryDate = opts.omitDates ? null : isoDate(expiryMs)
  const value = opts.omitValue ? null : 18_000 + ((index * 6_500) % 90_000)
  const autoRenewal = index % 2 === 0
  const noticeDays = 30 + (index % 3) * 30
  const terms = opts.omitTerms ? [] : DEFAULT_TERMS.slice(0, 3 + (index % 2))

  const stem = opts.fileStem ?? `contract-${slug(counterparty.company)}`
  const tag = opts.status === 'ready' ? '' : '-review'
  const file = `contracts/${stem}${tag}.${opts.format}`

  return {
    file,
    kind: 'contract',
    format: opts.format,
    expectedStatus: opts.status,
    defect: opts.defect ?? null,
    customerId: counterparty.id,
    customerName: counterparty.name,
    invoice: null,
    contract: {
      counterparty: counterparty.company,
      counterpartyEmail: counterparty.email,
      effectiveDate,
      expiryDate,
      termMonths: opts.omitDates ? null : termMonths,
      contractValue: value,
      currency: CURRENCY,
      autoRenewal: opts.omitDates ? null : autoRenewal,
      renewalNoticeDays: opts.omitDates ? null : noticeDays,
      terms: terms.map((t) => ({ clauseType: t.clauseType, title: t.title, text: t.text })),
    },
    notes: opts.notes ?? '',
    model: contractModel({
      counterparty,
      effectiveDate,
      expiryDate,
      termMonths: opts.omitDates ? null : termMonths,
      value,
      autoRenewal: opts.omitDates ? null : autoRenewal,
      noticeDays: opts.omitDates ? null : noticeDays,
      terms: terms.map((t) => ({ clauseType: t.clauseType, title: t.title, text: t.text })),
    }),
  }
}

// ── Non-business documents (classification traps) ────────────────────────

function otherFixture(input: {
  file: string
  format: DocFormat
  status: ExpectedStatus
  notes: string
  model: DocModel
}): FixturePlan {
  return {
    file: input.file,
    kind: 'other',
    format: input.format,
    expectedStatus: input.status,
    defect: null,
    customerId: null,
    customerName: null,
    invoice: null,
    contract: null,
    notes: input.notes,
    model: input.model,
  }
}

// ── The plan ─────────────────────────────────────────────────────────────

export function buildFixturePlan(): FixturePlan[] {
  const plan: FixturePlan[] = []

  // 11 clean invoices: 9 PDF, 2 DOCX.
  for (let i = 0; i < 11; i += 1) {
    plan.push(
      invoiceFixture(i, i, {
        format: i < 9 ? 'pdf' : 'docx',
        status: 'ready',
        notes: 'Clean invoice: all required fields present, totals reconcile.',
      }),
    )
  }

  // 8 clean contracts: 5 PDF, 3 DOCX.
  for (let i = 0; i < 8; i += 1) {
    plan.push(
      contractFixture(i, 10 + i, {
        format: i < 5 ? 'pdf' : 'docx',
        status: 'ready',
        notes: 'Clean contract: parties, term and clauses present.',
      }),
    )
  }

  // Invoice edge cases — each must trip the confidence gate.
  plan.push(
    invoiceFixture(20, 2, {
      format: 'pdf',
      status: 'needs_review',
      defect: 'missing_due_date',
      notes: 'No due date printed; extractor cannot compute payment terms.',
      omitDueDate: true,
    }),
    invoiceFixture(21, 5, {
      format: 'pdf',
      status: 'needs_review',
      defect: 'missing_tax',
      notes: 'No tax line printed; total cannot be decomposed.',
      omitTax: true,
    }),
    invoiceFixture(22, 7, {
      format: 'pdf',
      status: 'needs_review',
      defect: 'total_mismatch',
      notes: 'Printed total is 50.00 below subtotal + tax; extractor must not "fix" it silently.',
      mismatchTotal: true,
    }),
    invoiceFixture(23, 9, {
      format: 'docx',
      status: 'needs_review',
      defect: 'missing_invoice_number',
      notes: 'Unnumbered invoice; deduplication and follow-up tracking are impossible.',
      omitInvoiceNumber: true,
    }),
  )

  // Contract edge cases.
  plan.push(
    contractFixture(30, 4, {
      format: 'pdf',
      status: 'needs_review',
      defect: 'missing_dates',
      notes: 'No effective or expiry date; renewal risk cannot be calculated.',
      omitDates: true,
    }),
    contractFixture(31, 6, {
      format: 'pdf',
      status: 'needs_review',
      defect: 'missing_value',
      notes: 'No contract value stated; commercial aggregation is impossible.',
      omitValue: true,
    }),
    contractFixture(32, 8, {
      format: 'docx',
      status: 'needs_review',
      defect: 'no_clauses',
      notes: 'One-page agreement with no clause text; term extraction yields nothing.',
      omitTerms: true,
    }),
  )

  // Classification traps: business-looking documents that are neither invoice nor contract,
  // plus a contract deliberately saved under an invoice-shaped filename.
  plan.push(
    otherFixture({
      file: 'other/other-electricity-bill-origin-supply.pdf',
      format: 'pdf',
      status: 'ready',
      notes: 'Utility statement: has an amount due and a due date, but is not a tax invoice. Expect kind=other.',
      model: {
        title: 'ELECTRICITY ACCOUNT',
        blocks: [
          { heading: 'Account', lines: ['Origin Supply Pty Ltd', 'Account number: 8823-1140-77'] },
          { heading: 'Billing Period', lines: ['1 August 2026 to 31 August 2026', 'Next read: 1 October 2026'] },
          { heading: 'Charges', lines: ['Usage 1,240 kWh at 28.4 c/kWh: 352.16', 'Supply charge: 38.50'] },
          { heading: 'Amount', lines: ['Amount due: 390.66', 'Payment due by: 2026-09-21'] },
        ],
      },
    }),
    otherFixture({
      file: 'other/other-purchase-order-PO-88231.pdf',
      format: 'pdf',
      status: 'ready',
      notes: 'Purchase order addressed to a supplier: mentions totals but is our own commitment, not a bill.',
      model: {
        title: 'PURCHASE ORDER',
        blocks: [
          { heading: 'Supplier', lines: [seededCustomer(1).company, seededCustomer(1).email] },
          { heading: 'Order', lines: ['PO number: PO-88231', 'Order date: 2026-09-14', 'Delivery by: 2026-10-05'] },
          { heading: 'Items', lines: ['Sensor kit | 40 x 180.00 | 7,200.00', 'Installation | 1 x 950.00 | 950.00'] },
          { heading: 'Total', lines: ['Order total: 8,150.00 AUD (excl. GST)'] },
        ],
      },
    }),
    {
      ...contractFixture(33, 11, {
        format: 'pdf',
        status: 'ready',
        notes: 'Contract content in an invoice-named file: filename heuristics must not win over content.',
        fileStem: 'mislabelled-supplier-agreement',
      }),
      file: 'invoices/invoice-supplier-agreement-2026.pdf',
    },
  )

  // Degenerate case: a PDF with no extractable text at all.
  plan.push(
    otherFixture({
      file: 'invoices/invoice-blank-scan.pdf',
      format: 'pdf',
      status: 'failed',
      notes: 'Blank page, zero extractable text: the parse step must fail loudly rather than guess.',
      model: { title: '', blocks: [] },
    }),
  )

  return plan
}

// ── Manifest ─────────────────────────────────────────────────────────────

function csv(value: string | number | boolean | null): string {
  if (value === null) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function buildManifestCsv(plan: FixturePlan[]): string {
  const header = [
    'file',
    'kind',
    'format',
    'expected_status',
    'defect',
    'customer_id',
    'customer_name',
    'vendor_or_counterparty',
    'reference',
    'date_a',
    'date_b',
    'currency',
    'subtotal',
    'tax',
    'total',
    'term_months',
    'auto_renewal',
    'notes',
  ]
  const rows = plan.map((p) => {
    const inv = p.invoice
    const con = p.contract
    return [
      p.file,
      p.kind,
      p.format,
      p.expectedStatus,
      p.defect,
      p.customerId,
      p.customerName,
      inv?.vendorName ?? con?.counterparty ?? null,
      inv?.invoiceNumber ?? null,
      inv?.invoiceDate ?? con?.effectiveDate ?? null,
      inv?.dueDate ?? con?.expiryDate ?? null,
      inv ? inv.currency : con ? con.currency : null,
      inv?.subtotal ?? con?.contractValue ?? null,
      inv?.tax ?? null,
      inv?.total ?? null,
      con?.termMonths ?? null,
      con?.autoRenewal ?? null,
      p.notes,
    ]
      .map(csv)
      .join(',')
  })
  return [header.join(','), ...rows].join('\n') + '\n'
}

// ── Renderers ────────────────────────────────────────────────────────────

function renderPdf(model: DocModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    if (model.title) {
      doc.font('Helvetica-Bold').fontSize(18).text(model.title)
      doc.moveDown(0.8)
    }
    for (const block of model.blocks) {
      if (block.heading) doc.font('Helvetica-Bold').fontSize(11).text(block.heading)
      doc.font('Helvetica').fontSize(10)
      for (const line of block.lines) doc.text(line, { lineGap: 2 })
      doc.moveDown(0.7)
    }
    doc.end()
  })
}

async function renderDocx(model: DocModel): Promise<Buffer> {
  const children: Paragraph[] = []
  if (model.title) children.push(new Paragraph({ text: model.title, heading: HeadingLevel.HEADING_1 }))
  for (const block of model.blocks) {
    if (block.heading) children.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_2 }))
    for (const line of block.lines) children.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }))
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function writeFixtures(log: (msg: string) => void = console.log): Promise<void> {
  const plan = buildFixturePlan()
  await rm(OUT_DIR, { recursive: true, force: true })
  for (const fixture of plan) {
    const abs = join(OUT_DIR, fixture.file)
    await mkdir(dirname(abs), { recursive: true })
    const bytes = fixture.format === 'pdf' ? await renderPdf(fixture.model) : await renderDocx(fixture.model)
    await writeFile(abs, bytes)
  }
  await writeFile(join(OUT_DIR, 'manifest.csv'), buildManifestCsv(plan), 'utf8')

  const count = (s: ExpectedStatus) => plan.filter((p) => p.expectedStatus === s).length
  log(`Wrote ${plan.length} fixtures to ${OUT_DIR}/`)
  log(`  ready: ${count('ready')}  needs_review: ${count('needs_review')}  failed: ${count('failed')}`)
  log(`  invoices: ${plan.filter((p) => p.kind === 'invoice').length}  contracts: ${plan.filter((p) => p.kind === 'contract').length}  other: ${plan.filter((p) => p.kind === 'other').length}`)
  log(`  ground truth: ${OUT_DIR}/manifest.csv`)
}

const invoked = process.argv[1] ?? ''
if (invoked.includes('doc-fixtures')) {
  writeFixtures().catch((err: unknown) => {
    console.error('Fixture generation failed:', err)
    process.exit(1)
  })
}

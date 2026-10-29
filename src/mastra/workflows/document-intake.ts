import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { extractText } from 'unpdf'
import mammoth from 'mammoth'
import { documentExtractorAgent } from '../agents/document-extractor'
import { invoiceSchema, contractSchema } from '../schemas/documents'
import type { InvoiceExtract, ContractExtract } from '../schemas/documents'
import { parseEnv } from '../../config/env'
import { BLOCK_TYPES, convertWithDocling, layoutBlocks } from '../docling'
import type { DocumentBlock, ParseRun } from '../docling'
import {
  insertDocument,
  resolveCustomerByEntity,
  type InvoiceHeaderWrite,
  type InvoiceLineWrite,
  type ContractHeaderWrite,
  type ContractTermWrite,
} from '../../db/documents'
import { ingestStep } from './ingest'


export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
export const MAX_DOCUMENT_CHARS = 120_000
export const CONFIDENCE_THRESHOLD = 0.7

const kindEnum = z.enum(['invoice', 'contract', 'other'])

const workflowInputSchema = z.object({
  tenantId: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string().min(1).max(500),
  mime: z.string().default(''),
  source: z.enum(['upload', 'email']).default('upload'),
  sourceRef: z.string().nullish(),
  dataBase64: z.string().min(1),
})


export function parseMoneyValue(raw: string | undefined | null): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function parseDateValue(raw: string | undefined | null): string | null {
  if (!raw) return null
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const parsed = Date.parse(raw.trim())
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 10)
}

export function parseIntValue(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null
  const cleaned = raw.replace(/[^0-9-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export const REQUIRED_FIELDS: Record<'invoice' | 'contract', (keyof InvoiceExtract | keyof ContractExtract)[]> = {
  invoice: ['vendorName', 'total', 'invoiceDate'],
  contract: ['counterparty', 'effectiveDate', 'contractValue'],
}

export function coverageScore(extract: Record<string, unknown>, kind: 'invoice' | 'contract'): number {
  const fields = REQUIRED_FIELDS[kind]
  const present = fields.filter((f) => {
    const v = extract[f]
    return v !== undefined && v !== null && v !== ''
  }).length
  return fields.length === 0 ? 0 : present / fields.length
}

export function computeConfidence(modelConf: number | undefined, coverage: number): number {
  const rounded = modelConf != null && Number.isFinite(modelConf) ? 0.5 * modelConf + 0.5 * coverage : coverage
  return Math.max(0, Math.min(1, Number(rounded.toFixed(3))))
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

export function classifyKindHeuristic(title: string, text: string): {
  kind: 'invoice' | 'contract' | 'other'
  ambiguous: boolean
} {
  const haystack = `${title}\n${text}`.toLowerCase()
  const invoiceTerms = ['invoice', 'bill to', 'amount due', 'total due', 'subtotal', 'gst', 'vat', 'tax id', 'invoice number', 'due date']
  const contractTerms = ['agreement', 'contract', 'whereas', 'parties', 'term of agreement', 'effective date', 'expiration', 'renewal', 'shall', 'clause', 'hereby']
  const score = (terms: string[]) => terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0)
  const inv = score(invoiceTerms)
  const con = score(contractTerms)
  if (inv === 0 && con === 0) return { kind: 'other', ambiguous: false }
  if (inv === con) return { kind: inv > 0 ? 'invoice' : 'other', ambiguous: true }
  return { kind: inv > con ? 'invoice' : 'contract', ambiguous: Math.abs(inv - con) <= 1 }
}


const parsedSchema = z.object({
  tenantId: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string(),
  mime: z.string(),
  source: z.enum(['upload', 'email']),
  sourceRef: z.string().nullable(),
  text: z.string(),
})

// One parsed block plus its character span into `text`. bbox/offsets may be
// null: the fallback parsers cannot localize.
const blockSchema = z.object({
  page_number: z.number().int().min(1),
  block_index: z.number().int().min(0),
  block_type: z.enum(BLOCK_TYPES),
  content_md: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  confidence: z.number().nullable(),
  char_start: z.number().int().nullable(),
  char_end: z.number().int().nullable(),
})

const parseRunSchema = z.object({
  parser: z.enum(['docling', 'unpdf', 'mammoth', 'plain']),
  parser_version: z.string(),
  status: z.enum(['ok', 'failed']),
  duration_ms: z.number().int().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
})

// parse-binary's output. dataBase64 stays HERE only: the relay schemas
// downstream strip it, and persist-structured reads the bytes back out of this
// step's result, so the base64 is never copied through four more step results.
const parseOutputSchema = parsedSchema.extend({
  dataBase64: z.string().min(1),
  blocks: z.array(blockSchema),
  parse: parseRunSchema,
})

const IMAGE_EXT = /\.(png|jpe?g|tiff|tif|bmp|webp)$/i

function fallbackBlocks(text: string, parser: 'unpdf' | 'mammoth' | 'plain'): DocumentBlock[] {
  // unpdf gives per-page strings; the others give one blob. Paragraph-split
  // the single-blob case so blocks at least exist for the citation layer.
  const pages = parser === 'unpdf' ? [text] : text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  const blocks: DocumentBlock[] = []
  pages.forEach((pageText, pageIdx) => {
    const chunks = parser === 'unpdf' ? [pageText] : [pageText]
    chunks.forEach((content, blockIdx) => {
      if (content.trim() === '') return
      blocks.push({
        page_number: pageIdx + 1,
        block_index: blockIdx,
        block_type: 'text',
        content_md: content,
        bbox: null,
        confidence: null,
      })
    })
  })
  return blocks.length > 0 ? blocks : [{ page_number: 1, block_index: 0, block_type: 'other', content_md: '', bbox: null, confidence: null }]
}

const parseBinaryStep = createStep({
  id: 'parse-binary',
  inputSchema: workflowInputSchema,
  outputSchema: parseOutputSchema,
  execute: async ({ inputData }) => {
    const bytes = Buffer.from(inputData.dataBase64, 'base64')
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error(`document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
    }

    const started = Date.now()
    const mime = inputData.mime.toLowerCase()
    const isPdf = mime.includes('pdf') || inputData.title.toLowerCase().endsWith('.pdf')
    const isDocx = mime.includes('wordprocessingml') || inputData.title.toLowerCase().endsWith('.docx')
    const isImage = mime.startsWith('image/') || IMAGE_EXT.test(inputData.title)

    let blocks: DocumentBlock[] | null = null
    let parse: ParseRun | null = null

    // Preferred path: the Docling sidecar (layout + tables + bboxes).
    const doclingUrl = parseEnv().DOCLING_URL
    if (doclingUrl && (isPdf || isDocx || isImage)) {
      try {
        const conv = await convertWithDocling(doclingUrl, bytes, inputData.title, mime)
        blocks = conv.blocks
        parse = {
          parser: 'docling',
          parser_version: conv.parserVersion,
          status: 'ok',
          duration_ms: null,
          meta: { page_count: conv.pageCount },
        }
      } catch (err) {
        console.warn(`[document-intake] parse sidecar failed, falling back: ${String(err)}`)
        blocks = null
      }
    }

    // Fallback path: the in-process extractors (gap-1 behavior, unchanged).
    if (!blocks) {
      let text: string
      let parser: 'unpdf' | 'mammoth' | 'plain'
      if (isPdf) {
        const result = await extractText(new Uint8Array(bytes), { mergePages: false })
        text = result.text.join('\n\n')
        parser = 'unpdf'
        blocks = result.text
          .map((pageText, i) => ({
            page_number: i + 1,
            block_index: 0,
            block_type: 'text' as const,
            content_md: pageText,
            bbox: null,
            confidence: null,
          }))
          .filter((b) => b.content_md.trim() !== '')
      } else if (isDocx) {
        const result = await mammoth.extractRawText({ buffer: bytes })
        text = result.value
        parser = 'mammoth'
        blocks = fallbackBlocks(text, parser)
      } else {
        text = bytes.toString('utf8')
        parser = 'plain'
        blocks = fallbackBlocks(text, parser)
      }
      if (blocks.length === 0) blocks = fallbackBlocks('', 'plain')
      parse = { parser, parser_version: '', status: 'ok', duration_ms: null, meta: null }
    }

    // One layout contract: content_text is the '\n\n' join of block content,
    // so every block's char span cites exactly what the RAG layer embeds.
    const laid = layoutBlocks(blocks, MAX_DOCUMENT_CHARS)
    // Both branches above assign `parse` when `blocks` is non-null, which TS
    // cannot see through the `!blocks` check, so the nulls are narrowed here.
    const run: ParseRun = {
      parser: parse?.parser ?? 'plain',
      parser_version: parse?.parser_version ?? '',
      status: parse?.status ?? 'ok',
      meta: parse?.meta ?? null,
      duration_ms: Date.now() - started,
    }

    return {
      tenantId: inputData.tenantId,
      ownerId: inputData.ownerId,
      title: inputData.title,
      mime: inputData.mime,
      source: inputData.source,
      sourceRef: inputData.sourceRef ?? null,
      dataBase64: inputData.dataBase64,
      text: laid.text,
      blocks: blocks.map((b, i) => ({
        ...b,
        char_start: laid.spans[i]?.char_start ?? null,
        char_end: laid.spans[i]?.char_end ?? null,
      })),
      parse: run,
    }
  },
})


const kindChoiceSchema = z.object({ kind: kindEnum })

const classifiedSchema = parsedSchema.extend({
  kind: kindEnum,
  blocks: z.array(blockSchema),
  parse: parseRunSchema,
})

const classifyKindStep = createStep({
  id: 'classify-kind',
  inputSchema: parseOutputSchema,
  outputSchema: classifiedSchema,
  execute: async ({ inputData }) => {
    const heuristic = classifyKindHeuristic(inputData.title, inputData.text)
    let kind = heuristic.kind

    if (heuristic.ambiguous) {
      try {
        const result = await documentExtractorAgent.generate(
          `Which single kind best describes this document? Reply with the kind only.\n\n<document>\n${inputData.text.slice(0, 4000)}\n</document>`,
          {
            structuredOutput: {
              schema: kindChoiceSchema,
              errorStrategy: 'fallback',
              fallbackValue: { kind: heuristic.kind },
              jsonPromptInjection: true,
            },
          },
        )
        const chosen = (result as { object?: { kind?: unknown } }).object?.kind
        if (chosen === 'invoice' || chosen === 'contract' || chosen === 'other') kind = chosen
      } catch {
        kind = heuristic.kind
      }
    }

    return { ...inputData, kind }
  },
})


const extractedSchema = classifiedSchema.extend({
  extract: z.record(z.string(), z.unknown()).nullable(),
  needsReview: z.boolean(),
})

const extractStructuredStep = createStep({
  id: 'extract-structured',
  inputSchema: classifiedSchema,
  outputSchema: extractedSchema,
  execute: async ({ inputData }) => {
    if (inputData.kind === 'other') {
      return { ...inputData, extract: null, needsReview: false }
    }

    const prompt = `Extract the requested fields from this ${inputData.kind}. Return only values literally present.\n\n<document>\n${inputData.text}\n</document>`

    const runOnce = () =>
      inputData.kind === 'invoice'
        ? documentExtractorAgent.generate(prompt, {
            structuredOutput: {
              schema: invoiceSchema,
              errorStrategy: 'fallback',
              fallbackValue: {},
              jsonPromptInjection: true,
            },
          })
        : documentExtractorAgent.generate(prompt, {
            structuredOutput: {
              schema: contractSchema,
              errorStrategy: 'fallback',
              fallbackValue: {},
              jsonPromptInjection: true,
            },
          })

    let result = await runOnce()
    if (result.usedFallbackValue) {
      result = await runOnce()
    }

    const extract = asRecord((result as { object?: unknown }).object)
    const usable = !result.usedFallbackValue && extract !== null
    return { ...inputData, extract: usable ? extract : null, needsReview: !usable }
  },
})


const normalizedSchema = extractedSchema.extend({
  normalized: z.record(z.string(), z.unknown()).nullable(),
  customerId: z.string().uuid().nullable(),
  confidence: z.number().nullable(),
  needsReview: z.boolean(),
})

export function normalizeInvoice(extract: InvoiceExtract): {
  header: InvoiceHeaderWrite
  lines: InvoiceLineWrite[]
} {
  return {
    header: {
      vendor_name: extract.vendorName ?? null,
      vendor_email: extract.vendorEmail ?? null,
      invoice_number: extract.invoiceNumber ?? null,
      invoice_date: parseDateValue(extract.invoiceDate),
      due_date: parseDateValue(extract.dueDate),
      currency: extract.currency ?? null,
      subtotal: extract.subtotal != null ? parseMoneyValue(extract.subtotal) : null,
      tax: extract.tax != null ? parseMoneyValue(extract.tax) : null,
      total: extract.total != null ? parseMoneyValue(extract.total) : null,
    },
    lines: (extract.lines ?? []).map((l) => ({
      description: l.description ?? null,
      quantity: parseMoneyValue(l.quantity),
      unit_price: parseMoneyValue(l.unitPrice),
      amount: parseMoneyValue(l.amount),
      currency: l.currency ?? null,
    })),
  }
}

export function normalizeContract(extract: ContractExtract, fullText: string): {
  header: ContractHeaderWrite
  terms: ContractTermWrite[]
} {
  const haystack = fullText.toLowerCase()
  return {
    header: {
      counterparty: extract.counterparty ?? null,
      counterparty_email: extract.counterpartyEmail ?? null,
      effective_date: parseDateValue(extract.effectiveDate),
      expiry_date: parseDateValue(extract.expiryDate),
      term_months: parseIntValue(extract.termMonths),
      contract_value: extract.contractValue != null ? parseMoneyValue(extract.contractValue) : null,
      currency: extract.currency ?? null,
      auto_renewal: extract.autoRenewal ?? null,
      renewal_notice_days: parseIntValue(extract.renewalNoticeDays),
    },
    terms: (extract.terms ?? []).map((t) => {
      const needle = (t.text ?? '').toLowerCase()
      const start = needle.length > 0 ? haystack.indexOf(needle) : -1
      return {
        clause_type: t.clauseType ?? null,
        title: t.title ?? null,
        text: t.text ?? null,
        start_offset: start >= 0 ? start : null,
        end_offset: start >= 0 ? start + (t.text?.length ?? 0) : null,
      }
    }),
  }
}

const normalizeAndResolveStep = createStep({
  id: 'normalize-and-resolve',
  inputSchema: extractedSchema,
  outputSchema: normalizedSchema,
  execute: async ({ inputData }) => {
    if (inputData.kind === 'other' || !inputData.extract) {
      return { ...inputData, normalized: null, customerId: null, confidence: null }
    }

    const extract = inputData.extract
    const modelConf = typeof extract.confidence === 'number' ? extract.confidence : undefined
    const coverage = coverageScore(extract, inputData.kind)
    const confidence = computeConfidence(modelConf, coverage)

    const entityName = (inputData.kind === 'invoice' ? extract.vendorName : extract.counterparty) as string | undefined
    const entityEmail = (inputData.kind === 'invoice' ? extract.vendorEmail : extract.counterpartyEmail) as string | undefined
    const customerId = await resolveCustomerByEntity(inputData.tenantId, {
      email: entityEmail ?? null,
      name: entityName ?? null,
    })

    const needsReview = inputData.needsReview || confidence < CONFIDENCE_THRESHOLD

    const normalized =
      inputData.kind === 'invoice'
        ? normalizeInvoice(extract)
        : normalizeContract(extract, inputData.text)

    return { ...inputData, normalized, customerId, confidence, needsReview }
  },
})


const persistedSchema = normalizedSchema.extend({
  documentId: z.string().uuid(),
  status: z.enum(['ready', 'needs_review']),
  text: z.string(),
  contentType: z.string(),
  documentTitle: z.string(),
})

const persistStructuredStep = createStep({
  id: 'persist-structured',
  inputSchema: normalizedSchema,
  outputSchema: persistedSchema,
  execute: async (context) => {
    const { inputData } = context
    const contentHash = await sha256Hex(inputData.text)
    const status = inputData.needsReview ? 'needs_review' : 'ready'

    // The original bytes live only in parse-binary's step result; pulling them
    // back here keeps the base64 out of every relay schema in between.
    const binary = context.getStepResult<{ dataBase64?: string }>('parse-binary')
    const fileBytes = binary?.dataBase64 ? Buffer.from(binary.dataBase64, 'base64') : null

    const invoicePart = inputData.kind === 'invoice' && inputData.normalized
      ? (inputData.normalized as unknown as { header: InvoiceHeaderWrite; lines: InvoiceLineWrite[] })
      : null
    const contractPart = inputData.kind === 'contract' && inputData.normalized
      ? (inputData.normalized as unknown as { header: ContractHeaderWrite; terms: ContractTermWrite[] })
      : null

    const created = await insertDocument({
      tenantId: inputData.tenantId,
      ownerId: inputData.ownerId,
      kind: inputData.kind,
      title: inputData.title,
      source: inputData.source,
      sourceRef: inputData.sourceRef ?? null,
      contentHash,
      contentText: inputData.text,
      mime: inputData.mime,
      status,
      confidence: inputData.confidence,
      customerId: inputData.customerId,
      rawExtract: inputData.extract ?? {},
      invoice: invoicePart?.header ?? null,
      invoiceLines: invoicePart?.lines ?? [],
      contract: contractPart?.header ?? null,
      contractTerms: contractPart?.terms ?? [],
      file: fileBytes
        ? { mime: inputData.mime, sizeBytes: fileBytes.byteLength, data: fileBytes }
        : null,
      parse: {
        parser: inputData.parse.parser,
        parserVersion: inputData.parse.parser_version,
        status: inputData.parse.status,
        durationMs: inputData.parse.duration_ms,
        meta: inputData.parse.meta,
      },
      blocks: inputData.blocks,
    })

    const finalStatus: 'ready' | 'needs_review' =
      created.status === 'needs_review' ? 'needs_review' : 'ready'

    return {
      ...inputData,
      documentId: created.id,
      status: finalStatus,
      text: inputData.text,
      contentType: 'text',
      documentTitle: inputData.title,
    }
  },
})

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}


const workflowOutputSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(['ready', 'needs_review', 'failed']),
  kind: kindEnum,
  confidence: z.number().nullable(),
  chunkCount: z.number(),
  indexName: z.string(),
})

const finalizeIndexStep = createStep({
  id: 'finalize-index',
  inputSchema: z.object({ chunkCount: z.number(), indexName: z.string() }),
  outputSchema: workflowOutputSchema,
  execute: (context) => {
    const persisted = context.getStepResult<{
      documentId: string
      status: 'ready' | 'needs_review'
      kind: 'invoice' | 'contract' | 'other'
      confidence: number | null
    }>('persist-structured')
    return Promise.resolve({
      documentId: persisted.documentId,
      status: persisted.status,
      kind: persisted.kind,
      confidence: persisted.confidence,
      chunkCount: context.inputData.chunkCount,
      indexName: context.inputData.indexName,
    })
  },
})

export const documentIntakeWorkflow = createWorkflow({
  id: 'crum-document-intake',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(parseBinaryStep)
  .then(classifyKindStep)
  .then(extractStructuredStep)
  .then(normalizeAndResolveStep)
  .then(persistStructuredStep)
  .then(ingestStep)
  .then(finalizeIndexStep)
  .commit()

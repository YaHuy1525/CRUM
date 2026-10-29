import { z } from 'zod'

// Client for the optional Docling parse sidecar (services/docling). The
// sidecar turns a PDF/image/docx into the same structured block intermediate
// the 0011 schema stores. Everything here is fail-soft: an unreachable or
// erroring sidecar throws DoclingUnavailable and intake falls back.

export const BLOCK_TYPES = [
  'header',
  'footer',
  'title',
  'section_header',
  'page_number',
  'list_item',
  'figure',
  'table',
  'key_value',
  'text',
  'comment',
  'signature',
  'other',
] as const

export type BlockType = (typeof BLOCK_TYPES)[number]

export interface DocumentBlock {
  page_number: number
  block_index: number
  block_type: BlockType
  content_md: string
  /** [x0, y0, x1, y1] normalized 0..1, top-left origin; null when unknown. */
  bbox: [number, number, number, number] | null
  confidence: number | null
}

export interface ParseRun {
  parser: 'docling' | 'unpdf' | 'mammoth' | 'plain'
  parser_version: string
  status: 'ok' | 'failed'
  duration_ms: number | null
  meta: Record<string, unknown> | null
}

const blockSchema = z.object({
  page_number: z.number().int().min(1),
  block_index: z.number().int().min(0),
  block_type: z.enum(BLOCK_TYPES),
  content_md: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
})

const convertResponseSchema = z.object({
  parser_version: z.string().default(''),
  page_count: z.number().int().min(0).default(0),
  blocks: z.array(blockSchema).min(1),
})

export class DoclingUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DoclingUnavailable'
  }
}

export interface DoclingConversion {
  blocks: DocumentBlock[]
  parserVersion: string
  pageCount: number
}

/**
 * POST the raw bytes to the sidecar's /convert endpoint and return its
 * structured blocks. Throws DoclingUnavailable on any transport, status, or
 * schema failure so the caller can fall back to the in-process path.
 */
export async function convertWithDocling(
  baseUrl: string,
  bytes: Uint8Array,
  filename: string,
  mime: string,
  timeoutMs = 120_000,
): Promise<DoclingConversion> {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), filename)

  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new DoclingUnavailable(`sidecar request failed: ${String(err)}`)
  }

  if (!response.ok) {
    throw new DoclingUnavailable(`sidecar returned HTTP ${response.status}`)
  }

  const parsed = convertResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new DoclingUnavailable(`sidecar response failed validation: ${parsed.error.message}`)
  }

  return {
    blocks: parsed.data.blocks.map((b) => ({
      page_number: b.page_number,
      block_index: b.block_index,
      block_type: b.block_type,
      content_md: b.content_md,
      bbox: b.bbox,
      confidence: b.confidence,
    })),
    parserVersion: parsed.data.parser_version,
    pageCount: parsed.data.page_count,
  }
}

export interface BlockSpan {
  char_start: number | null
  char_end: number | null
}

/**
 * Lay blocks out into one text and per-block character spans into it. The
 * join separator is part of the layout contract: content_text and the block
 * offsets must agree, or citations point at the wrong passage.
 */
export function layoutBlocks(
  blocks: DocumentBlock[],
  maxChars: number,
): { text: string; spans: BlockSpan[] } {
  const parts: string[] = []
  const spans: { char_start: number | null; char_end: number | null }[] = []
  let cursor = 0
  for (const block of blocks) {
    if (cursor + block.content_md.length > maxChars) {
      // The clipped tail has no home in content_text; cite nothing rather
      // than something wrong.
      spans.push({ char_start: null, char_end: null })
      continue
    }
    parts.push(block.content_md)
    spans.push({ char_start: cursor, char_end: cursor + block.content_md.length })
    cursor += block.content_md.length + 2 // '\n\n' joiner
  }
  return { text: parts.join('\n\n'), spans }
}

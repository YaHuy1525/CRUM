export const OCR_BLOCK_TYPES = [
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
] as const;

export type OcrBlockType = (typeof OCR_BLOCK_TYPES)[number];

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface OcrDocumentBlock {
  page_number: number;
  block_index: number;
  block_type: OcrBlockType;
  content_md: string;
  bbox: [number, number, number, number] | null;
  confidence: number | null;
  words?: OcrWord[];
}

export interface OcrParseRun {
  parser: 'tesseract' | 'aws-textract' | 'azure-doc-intelligence';
  parser_version: string;
  status: 'ok' | 'failed';
  duration_ms: number | null;
  meta: Record<string, unknown> | null;
}

export interface OcrResult {
  text: string;
  blocks: OcrDocumentBlock[];
  confidence: number | null;
  parser: string;
  parser_version: string;
  language?: string;
  psm?: number;
}

export class OcrUnavailable extends Error {
  constructor(message = 'OCR service unavailable') {
    super(message);
    this.name = 'OcrUnavailable';
  }
}

export async function convertWithOcr(
  ocrUrl: string,
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  language = 'eng',
  psm = 3,
): Promise<OcrResult> {
  const formData = new FormData();
  const blob = new Blob([bytes], { type: mimeType });
  formData.append('file', blob, fileName);

  const url = `${ocrUrl.replace(/\/$/, '')}/ocr?lang=${encodeURIComponent(language)}&psm=${psm}`;

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new OcrUnavailable(
      `OCR service returned ${response.status}: ${detail || response.statusText}`,
    );
  }

  const result = (await response.json()) as OcrResult;
  return result;
}

export async function convertBase64WithOcr(
  ocrUrl: string,
  base64Data: string,
  language = 'eng',
  psm = 3,
): Promise<OcrResult> {
  const url = `${ocrUrl.replace(/\/$/, '')}/ocr/base64?lang=${encodeURIComponent(language)}&psm=${psm}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64Data }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new OcrUnavailable(
      `OCR service returned ${response.status}: ${detail || response.statusText}`,
    );
  }

  const result = (await response.json()) as OcrResult;
  return result;
}

export function ocrBlocksToText(blocks: OcrDocumentBlock[]): string {
  return blocks
    .filter((b) => b.content_md.trim() !== '')
    .map((b) => b.content_md)
    .join('\n\n');
}

export function computeOcrConfidence(blocks: OcrDocumentBlock[]): number | null {
  const confidences = blocks
    .map((b) => b.confidence)
    .filter((c): c is number => c !== null && c !== undefined);

  if (confidences.length === 0) return null;

  const avg = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  return Math.round(avg * 1000) / 1000;
}

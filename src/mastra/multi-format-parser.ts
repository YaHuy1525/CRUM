import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import type { DocumentBlock } from './docling.js';

export interface ParsedDocument {
  text: string;
  blocks: DocumentBlock[];
  parser: 'xlsx' | 'docx' | 'html' | 'csv' | 'json' | 'pdf';
  parserVersion: string;
  pageCount?: number;
  metadata?: Record<string, unknown>;
}

export type DocumentParser = (
  bytes: Uint8Array
) => ParsedDocument | Promise<ParsedDocument>;

export function parseXlsx(bytes: Uint8Array): ParsedDocument {
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheets: string[] = [];
  const blocks: DocumentBlock[] = [];

  workbook.SheetNames.forEach((sheetName, sheetIdx) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) return;

    const csv = XLSX.utils.sheet_to_csv(worksheet);
    sheets.push(csv);

    blocks.push({
      page_number: sheetIdx + 1,
      block_index: 0,
      block_type: 'title',
      content_md: `# Sheet: ${sheetName}`,
      bbox: null,
      confidence: null,
    });

    const lines = csv.split('\n').filter((line) => line.trim());
    lines.forEach((line, lineIdx) => {
      blocks.push({
        page_number: sheetIdx + 1,
        block_index: lineIdx + 1,
        block_type: lineIdx === 0 ? 'table' : 'text',
        content_md: line,
        bbox: null,
        confidence: null,
      });
    });
  });

  return {
    text: sheets.join('\n\n'),
    blocks,
    parser: 'xlsx',
    parserVersion: XLSX.version ?? 'unknown',
    pageCount: workbook.SheetNames.length,
    metadata: {
      sheetNames: workbook.SheetNames,
      sheetCount: workbook.SheetNames.length,
    },
  };
}

export function parseCsv(bytes: Uint8Array): ParsedDocument {
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split('\n').filter((line) => line.trim());

  const blocks: DocumentBlock[] = lines.map((line, idx) => ({
    page_number: 1,
    block_index: idx,
    block_type: idx === 0 ? 'table' : 'text',
    content_md: line,
    bbox: null,
    confidence: null,
  }));

  return {
    text,
    blocks,
    parser: 'csv',
    parserVersion: '1.0.0',
    pageCount: 1,
  };
}

export function parseJson(bytes: Uint8Array): ParsedDocument {
  const text = Buffer.from(bytes).toString('utf8');
  const data: unknown = JSON.parse(text);

  const formatted = JSON.stringify(data, null, 2);
  const blocks: DocumentBlock[] = [
    {
      page_number: 1,
      block_index: 0,
      block_type: 'text',
      content_md: formatted,
      bbox: null,
      confidence: null,
    },
  ];

  return {
    text: formatted,
    blocks,
    parser: 'json',
    parserVersion: '1.0.0',
    pageCount: 1,
    metadata: {
      keys: isRecord(data) ? Object.keys(data) : [],
      type: Array.isArray(data) ? 'array' : isRecord(data) ? 'object' : 'scalar',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHtml(bytes: Uint8Array): ParsedDocument {
  const html = Buffer.from(bytes).toString('utf8');

  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const blocks: DocumentBlock[] = [
    {
      page_number: 1,
      block_index: 0,
      block_type: 'text',
      content_md: text,
      bbox: null,
      confidence: null,
    },
  ];

  return {
    text,
    blocks,
    parser: 'html',
    parserVersion: '1.0.0',
    pageCount: 1,
  };
}

export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const buffer = Buffer.from(bytes);
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;

  const blocks: DocumentBlock[] = text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((para, idx) => ({
      page_number: 1,
      block_index: idx,
      block_type: 'text' as const,
      content_md: para,
      bbox: null,
      confidence: null,
    }));

  if (blocks.length === 0) {
    blocks.push({
      page_number: 1,
      block_index: 0,
      block_type: 'text',
      content_md: text,
      bbox: null,
      confidence: null,
    });
  }

  return {
    text,
    blocks,
    parser: 'docx',
    parserVersion: '1.0.0',
    pageCount: 1,
    metadata: {
      messageCount: result.messages.length,
    },
  };
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const result = await extractText(new Uint8Array(bytes), { mergePages: false });
  const text = result.text.join('\n\n');

  const blocks = result.text
    .map((pageText, i) => ({
      page_number: i + 1,
      block_index: 0,
      block_type: 'text' as const,
      content_md: pageText,
      bbox: null,
      confidence: null,
    }))
    .filter((b) => b.content_md.trim() !== '');

  if (blocks.length === 0) {
    blocks.push({
      page_number: 1,
      block_index: 0,
      block_type: 'text',
      content_md: text,
      bbox: null,
      confidence: null,
    });
  }

  return {
    text,
    blocks,
    parser: 'pdf',
    parserVersion: '1.0.0',
    pageCount: result.text.length,
  };
}

export function getParserForMimeType(
  mimeType: string,
  fileName: string
): DocumentParser | null {
  const mime = mimeType.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop();

  if (mime.includes('spreadsheet') || mime.includes('excel') || ext === 'xlsx' || ext === 'xls') {
    return parseXlsx;
  }
  if (mime.includes('csv') || ext === 'csv') {
    return parseCsv;
  }
  if (mime.includes('json') || ext === 'json') {
    return parseJson;
  }
  if (mime.includes('html') || mime.includes('htm') || ext === 'html' || ext === 'htm') {
    return parseHtml;
  }
  if (mime.includes('wordprocessingml') || mime.includes('word') || ext === 'docx' || ext === 'doc') {
    return parseDocx;
  }
  if (mime.includes('pdf') || ext === 'pdf') {
    return parsePdf;
  }

  return null;
}

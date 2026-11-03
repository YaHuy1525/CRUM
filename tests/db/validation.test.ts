import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';

// Load .env before any module that reads process.env at import time.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

import { getDbClient } from '../../src/db/client.js';
import type { Violation } from '../../src/validation/types.js';
import {
  replaceValidation,
  listViolations,
  waiveViolation,
  openCounts,
} from '../../src/db/validation.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

interface IdRow {
  id: string;
}

async function seedInvoice(tag: string): Promise<string> {
  const hash = `hash-val-${tag}-${randomUUID()}`;
  const result = await getDbClient().query<IdRow>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Validation Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, hash],
  );
  return result.rows[0]!.id;
}

async function run(documentId: string, violations: Violation[]) {
  return replaceValidation(getDbClient(), documentId, TENANT, violations, 'v1');
}

const sumFailure: Violation = {
  ruleId: 'invoice.total.sum', field: 'total', severity: 'error',
  message: 'Subtotal plus tax does not equal the total.',
};
const shapeWarning: Violation = {
  ruleId: 'invoice.currency.shape', field: 'currency', severity: 'warning',
  message: 'Currency is not a three-letter code.',
};

describe('validation persistence', () => {
  it('writes both severities and returns their open counts', async () => {
    const doc = await seedInvoice('val-counts');
    expect(await run(doc, [sumFailure, shapeWarning])).toEqual({ openErrors: 1, openWarnings: 1 });
    const rows = await listViolations(doc, TENANT);
    expect(rows.map((r) => r.ruleId)).toEqual(['invoice.total.sum', 'invoice.currency.shape']);
  });

  it('replaces an open finding that no longer fires and keeps the one that still does', async () => {
    const doc = await seedInvoice('val-replace');
    await run(doc, [sumFailure, shapeWarning]);
    await run(doc, [sumFailure]);
    expect((await listViolations(doc, TENANT)).map((r) => r.ruleId)).toEqual(['invoice.total.sum']);
  });

  it('is idempotent: running twice leaves one row per rule and field', async () => {
    const doc = await seedInvoice('val-idem');
    await run(doc, [sumFailure]);
    await run(doc, [sumFailure]);
    expect((await listViolations(doc, TENANT)).length).toBe(1);
  });

  it('never reopens a waived finding on a re-run', async () => {
    const doc = await seedInvoice('val-waive-rerun');
    await run(doc, [sumFailure]);
    const [first] = await listViolations(doc, TENANT);
    const waived = await waiveViolation(first!.id, TENANT, USER, 'credit note nets this invoice off');
    expect(waived.ok).toBe(true);

    const counts = await run(doc, [sumFailure]);
    expect(counts.openErrors).toBe(0);
    const after = await listViolations(doc, TENANT);
    expect(after[0]!.status).toBe('waived');
    expect(after[0]!.waivedBy).toBe(USER);
    expect(after[0]!.waiverReason).toBe('credit note nets this invoice off');
  });

  it('refuses to waive the same finding twice', async () => {
    const doc = await seedInvoice('val-double-waive');
    await run(doc, [sumFailure]);
    const [row] = await listViolations(doc, TENANT);
    expect(await waiveViolation(row!.id, TENANT, USER, 'first override')).toMatchObject({ ok: true });
    expect(await waiveViolation(row!.id, TENANT, USER, 'second override')).toEqual({ ok: false, reason: 'already_waived' });
  });

  it('will not read or waive across tenants', async () => {
    const doc = await seedInvoice('val-isolation');
    await run(doc, [sumFailure]);
    const [row] = await listViolations(doc, TENANT);
    const OTHER = '00000000-0000-4000-8000-000000000099';
    expect(await listViolations(doc, OTHER)).toEqual([]);
    expect(await waiveViolation(row!.id, OTHER, USER, 'trying another tenant')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('drops the findings with the document', async () => {
    const doc = await seedInvoice('val-cascade');
    await run(doc, [sumFailure]);
    await getDbClient().query('DELETE FROM documents WHERE id = $1', [doc]);
    const rows = await getDbClient().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM document_validation WHERE document_id = $1', [doc],
    );
    expect(rows.rows[0]!.n).toBe('0');
  });

  it('openCounts reports one entry per document and none for a clean one', async () => {
    const a = await seedInvoice('val-open-a');
    const b = await seedInvoice('val-open-b');
    await run(a, [sumFailure, shapeWarning]);
    const counts = await openCounts([a, b], TENANT);
    expect(counts.get(a)).toEqual({ errors: 1, warnings: 1 });
    expect(counts.has(b)).toBe(false);
  });
});

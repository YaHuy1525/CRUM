import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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
  reviewQueue,
} from '../../src/db/validation.js';
import { generateCursor } from '../../src/db/cursor.js';

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

function makeContext() {
  return { tenantId: TENANT, userId: USER, userRole: 'admin' as const }
}

async function wipeQueue() {
  await getDbClient().query(
    'DELETE FROM document_validation WHERE tenant_id = $1',
    [TENANT],
  )
  await getDbClient().query(
    "DELETE FROM documents WHERE tenant_id = $1 AND kind IN ('invoice', 'contract')",
    [TENANT],
  )
}

const DB_TIMEOUT = 30_000

describe('reviewQueue with cursor', () => {
  beforeEach(async () => {
    await wipeQueue()
  }, DB_TIMEOUT)

  afterEach(async () => {
    await wipeQueue()
  }, DB_TIMEOUT)

  it('returns first page with hasMore and nextCursor', async () => {
    const context = makeContext()
    // Seed 3 documents with varying error counts to create a deterministic order.
    const d1 = await seedInvoice('rq-cursor-a')
    const d2 = await seedInvoice('rq-cursor-b')
    const d3 = await seedInvoice('rq-cursor-c')
    await run(d1, [sumFailure, shapeWarning]) // 1 error, 1 warning
    await run(d2, [sumFailure]) // 1 error
    await run(d3, [shapeWarning]) // 0 errors, 1 warning

    const result = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 2,
      cursor: undefined,
    })

    expect(result.rows).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBeTruthy()
    expect(result.total).toBe(3)
  }, DB_TIMEOUT)

  it('returns second page with no overlap when cursor from last row of first page', async () => {
    const context = makeContext()
    const d1 = await seedInvoice('rq-cursor2-a')
    const d2 = await seedInvoice('rq-cursor2-b')
    const d3 = await seedInvoice('rq-cursor2-c')
    const d4 = await seedInvoice('rq-cursor2-d')
    await run(d1, [sumFailure, shapeWarning]) // 1 error
    await run(d2, [sumFailure]) // 1 error
    await run(d3, [shapeWarning]) // 0 errors, 1 warning
    await run(d4, []) // clean but status=ready → not in queue

    // d4 is ready with no findings → not in queue. Only d1, d2, d3 are queued.
    // Force d4 into queue via status:
    await getDbClient().query("UPDATE documents SET status = 'needs_review' WHERE id = $1", [d4])

    const firstPage = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 2,
      cursor: undefined,
    })

    expect(firstPage.rows).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBeTruthy()

    const lastRow = firstPage.rows[1]!
    const cursor = generateCursor({
      openErrors: lastRow.open_errors,
      lowestFieldConfidence:
        lastRow.lowest_field_confidence != null ? Number(lastRow.lowest_field_confidence) : null,
      createdAt: lastRow.created_at.toISOString(),
      documentId: lastRow.document_id,
    })

    const secondPage = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 2,
      cursor,
    })

    expect(secondPage.rows.length).toBeGreaterThan(0)
    // No overlap between pages
    const firstPageIds = new Set(firstPage.rows.map(r => r.document_id))
    for (const row of secondPage.rows) {
      expect(firstPageIds.has(row.document_id)).toBe(false)
    }
  }, DB_TIMEOUT)

  it('returns hasMore false and null nextCursor on last page', async () => {
    const context = makeContext()
    const d1 = await seedInvoice('rq-cursor3-a')
    const d2 = await seedInvoice('rq-cursor3-b')
    await run(d1, [sumFailure])
    await run(d2, [shapeWarning])

    // Get first page with large enough limit to fetch all
    const result = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 10,
      cursor: undefined,
    })

    expect(result.rows).toHaveLength(2)
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  }, DB_TIMEOUT)

  it('throws on invalid cursor format', async () => {
    const context = makeContext()
    await expect(
      reviewQueue(context, {
        kind: null,
        severity: null,
        limit: 10,
        cursor: 'not-a-valid-cursor',
      }),
    ).rejects.toThrow('Invalid cursor format')
  }, DB_TIMEOUT)

  it('pages through all rows without overlap or loss', async () => {
    const context = makeContext()
    // Seed 5 documents with varying error counts
    const docs: string[] = []
    for (let i = 0; i < 5; i++) {
      const doc = await seedInvoice(`rq-cursor5-${i}`)
      docs.push(doc)
      // Give each a different number of errors for deterministic ordering
      const violations: Violation[] = []
      for (let e = 0; e < 5 - i; e++) {
        violations.push({
          ruleId: `invoice.rule.${e}`,
          field: `field_${e}`,
          severity: 'error',
          message: `Error ${e}`,
        })
      }
      await run(doc, violations)
    }

    // Collect all rows via cursor pagination with page size 2
    const allRows: string[] = []
    let cursor: string | undefined
    let pageCount = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await reviewQueue(context, {
        kind: null,
        severity: null,
        limit: 2,
        cursor,
      })
      allRows.push(...result.rows.map(r => r.document_id))
      pageCount++

      if (!result.hasMore || !result.nextCursor) {
        break
      }
      cursor = result.nextCursor
    }

    // All 5 documents should be accounted for, with no duplicates
    expect(allRows).toHaveLength(5)
    expect(new Set(allRows).size).toBe(5)
    expect(pageCount).toBe(3) // 2 + 2 + 1
  }, DB_TIMEOUT)
})
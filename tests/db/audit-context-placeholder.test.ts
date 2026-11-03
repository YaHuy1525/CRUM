import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';

// Load .env before any module that reads process.env at import time.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

import { Pool } from 'pg';
import { setAuditContext } from '../../src/db/audit-context.js';
import type { PoolClient } from 'pg';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const HASH_PREFIX = `hash-placeholder-${randomUUID()}`;

const CONNECT_TIMEOUT_MS = 10_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Session-mode gate: same pattern as audit-context-isolation.test.ts.
 * The premise is connection-level — a backend that has already carried a context
 * reads the GUC as '' rather than NULL after RESET — so we need port 6543.
 */
interface Gate {
  connectionString: string;
  skipReason: string;
}

function buildGate(): Gate {
  const raw = process.env.DATABASE_URL ?? '';
  if (raw === '') {
    return {
      connectionString: '',
      skipReason:
        'DATABASE_URL is not set, so there is no live Postgres whose GUC surface this file can measure.',
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    return {
      connectionString: '',
      skipReason: `DATABASE_URL is not a parsable connection string (${errMessage(err)}).`,
    };
  }
  url.port = '6543';
  return { connectionString: url.toString(), skipReason: '' };
}

const gate = buildGate();

const pool = new Pool({
  connectionString: gate.connectionString,
  max: 1,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
});

async function attempt(client: Pool | PoolClient, sql: string, params?: unknown[]): Promise<string> {
  try {
    await client.query(sql, params);
    return '';
  } catch (err) {
    return errMessage(err);
  }
}

async function probeSession(): Promise<string> {
  const target = new URL(gate.connectionString);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return '';
  } catch (err) {
    return `${target.host} did not answer: ${errMessage(err)}`;
  } finally {
    if (client) client.release();
  }
}

const skipReason = gate.skipReason === '' ? await probeSession() : gate.skipReason;

if (skipReason !== '') {
  console.warn(
    `SKIP tests/db/audit-context-placeholder.test.ts — this file did not run, it is not a pass: ${skipReason}`,
  );
}

interface IdRow {
  id: string;
}

const seeded: string[] = [];
const cleanupFailures: string[] = [];

async function seedInvoice(client: PoolClient, tag: string): Promise<string> {
  const docResult = await client.query<IdRow>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Placeholder Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `${HASH_PREFIX}-${tag}`],
  );
  const documentId = docResult.rows[0]!.id;
  seeded.push(documentId);

  await client.query('BEGIN');
  await setAuditContext(client, { userId: USER, changeSource: 'extraction' });
  await client.query(
    `INSERT INTO invoices (document_id, vendor_name, total, invoice_date)
     VALUES ($1, 'Placeholder Corp', 100.00, '2026-11-03')`,
    [documentId],
  );
  await client.query('COMMIT');

  return documentId;
}

async function cleanup(): Promise<string[]> {
  const failures: string[] = [];
  for (const id of seeded) {
    let lastError = '';
    for (let tryNumber = 0; tryNumber < 3; tryNumber++) {
      lastError = await attempt(pool, 'DELETE FROM documents WHERE id = $1 AND tenant_id = $2', [id, TENANT]);
      if (lastError === '') break;
    }
    if (lastError !== '') failures.push(`DELETE FROM documents ${id} -> ${lastError}`);
  }
  try {
    await pool.end();
  } catch (err) {
    failures.push(`pool.end() -> ${errMessage(err)}`);
  }
  return failures;
}

describe.skipIf(skipReason !== '')('audit context placeholder guard', () => {
  afterAll(async () => {
    const failures = [...(await cleanup()), ...cleanupFailures];
    if (failures.length > 0) {
      throw new Error(`tests/db/audit-context-placeholder.test.ts cleanup failed:\n  ${failures.join('\n  ')}`);
    }
  });

  it(
    'still audits a contextless write on a backend that once carried a context',
    async () => {
      // 1. Open a session-mode pool so one pinned backend sees both transactions.
      const client = await pool.connect();
      try {
        // 2. First transaction: set audit context and update a seeded document.
        const docA = await seedInvoice(client, 'placeholder-a');

        await client.query('BEGIN');
        await setAuditContext(client, { userId: USER, changeSource: 'manual_correction' });
        await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['200.00', docA]);
        await client.query('COMMIT');

        // 3. Assert the backend now reads the GUC as '' rather than NULL.
        //    After setAuditContext + COMMIT + RESET, Postgres leaves the placeholder ''.
        await client.query('BEGIN');
        const gucCheck = await client.query<{ is_null: boolean; raw_value: string }>(
          `SELECT current_setting('app.current_user_id', true) IS NULL AS is_null,
                  current_setting('app.current_user_id', true) AS raw_value`,
        );
        await client.query('ROLLBACK');

        // If the read returns NULL rather than '', the premise is wrong on this server
        // version and we should stop.
        if (gucCheck.rows[0]!.is_null) {
          throw new Error(
            `BLOCKED: expected the GUC to read as '' (placeholder) after RESET, but it read as NULL. ` +
              `The premise of this test does not hold on this server version.`,
          );
        }
        expect(gucCheck.rows[0]!.raw_value).toBe('');

        // 4. Second transaction: contextless UPDATE on a second seeded document.
        //    No setAuditContext call at all.
        const docB = await seedInvoice(client, 'placeholder-b');

        await client.query('BEGIN');
        await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['300.00', docB]);
        await client.query('COMMIT');

        // 5. Expect step 4 to resolve, and the second document's audit rows to carry
        //    changed_by IS NULL and change_source = 'extraction'.
        const auditRows = await client.query<{ changed_by: string | null; change_source: string }>(
          `SELECT changed_by, change_source FROM document_field_audit
           WHERE document_id = $1 AND tenant_id = $2 AND action = 'update'`,
          [docB, TENANT],
        );
        expect(auditRows.rows.length).toBeGreaterThan(0);
        expect(auditRows.rows.every((r) => r.changed_by === null)).toBe(true);
        expect(auditRows.rows.every((r) => r.change_source === 'extraction')).toBe(true);
      } finally {
        for (const statement of ['ROLLBACK', 'RESET app.current_user_id', 'RESET app.change_source']) {
          const error = await attempt(client, statement);
          if (error !== '') cleanupFailures.push(`${statement} -> ${error}`);
        }
        client.release();
      }
    },
    30_000,
  );
});

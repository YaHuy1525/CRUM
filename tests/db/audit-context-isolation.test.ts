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
// The actor every seeded row is written as.
const USER = '00000000-0000-4000-8000-000000000002';
// A distinct actor for the correction under test. Reusing USER here — as the first
// version of this file did — makes the positive control unable to discriminate:
// a correction that had leaked the SEED's context instead of carrying its own would
// still be stamped USER and the control would pass.
const CORRECTING_USER = '00000000-0000-4000-8000-000000000003';
// Unique per run to avoid content_hash unique-constraint collisions across reruns
const HASH_PREFIX = `hash-isolation-${randomUUID()}`;

const CONNECT_TIMEOUT_MS = 10_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The premise under test is connection-level: a session-scoped setting survives
 * client.release() and is still set when the pool hands that physical connection
 * to a later request. That is only observable on a session-mode connection.
 * DATABASE_URL is Supabase's transaction-mode pooler (port 5432), where every
 * BEGIN can land on a different server shared with other live sessions, so the
 * handoff this file measures is not observable there. Same Supavisor host, port
 * 6543 is its session mode: one client session is pinned to one backend for its
 * whole lifetime, which is exactly the physical-connection semantics of the
 * shipped handleCorrection pattern this task replaces.
 *
 * Gate: this file lives in tests/db/**, which vitest.config.ts assigns to the
 * `unit` project, so without a gate every unit run requires session-mode port
 * 6543 to be reachable and the run errors when it is not (or, with no .env at
 * all, `new URL('')` throws a bare `TypeError: Invalid URL` at import time).
 * Plan constraint 12 says a skip is not a pass, so a closed gate says so out
 * loud and the task report states ran-vs-skipped; it does not quietly error.
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
        'DATABASE_URL is not set, so there is no live Postgres whose GUC surface this file can ' +
        'measure (it needs the DATABASE_URL from the repository .env, or an exported one).',
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

/**
 * max: 1 is not a resource limit here, it is half of the second test's premise:
 * the connection client.release() hands back is the one the next pool.connect()
 * receives, so a setting that outlived its transaction cannot hide behind a
 * second backend. An empty connectionString means the gate closed, and then
 * nothing below runs and the pool is never asked for a connection.
 */
const pool = new Pool({
  connectionString: gate.connectionString,
  max: 1,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
});

/** Attempts one statement and returns its failure text, '' when it succeeded. */
async function attempt(client: Pool | PoolClient, sql: string, params?: unknown[]): Promise<string> {
  try {
    await client.query(sql, params);
    return '';
  } catch (err) {
    return errMessage(err);
  }
}

/** Asks the session endpoint for a real connection; returns '' if it answered. */
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
    `SKIP tests/db/audit-context-isolation.test.ts — this file did not run, it is not a pass: ${skipReason}`,
  );
}

interface IdRow {
  id: string;
}

interface ContextRow {
  u: string | null;
  s: string | null;
}

const seeded: string[] = [];

/** What the backend reads for each audit GUC, in the current transaction/session. */
async function readContext(client: PoolClient): Promise<ContextRow> {
  const rows = await client.query<ContextRow>(
    `SELECT current_setting('app.current_user_id', true) AS u,
            current_setting('app.change_source', true) AS s`,
  );
  return rows.rows[0]!;
}

async function backendPid(client: PoolClient): Promise<string> {
  const rows = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return String(rows.rows[0]!.pid);
}

/**
 * Cleanup failures collected here and raised from afterAll, so a failed RESET can
 * neither hide inside the test it follows nor overwrite the assertion that failed
 * first.
 */
const cleanupFailures: string[] = [];

/**
 * Reset both audit GUCs and release the client.
 *
 * These RESETs exist to hand back a clean backend: this endpoint pins one backend
 * per client session, and that backend can be shared with a concurrent run (the
 * primary tree's suite, a later task's file). A RESET on a custom GUC does not make
 * the name unknown again — the placeholder Postgres created when the name was first
 * set stays, and the backend answers '' from then on. That materialised '' is
 * precisely why this file no longer attempts an end-to-end unguarded write; see the
 * note at the end of the first test.
 *
 * The leading ROLLBACK is there for the same reason: a body that threw between
 * BEGIN and COMMIT leaves the transaction open, and Postgres then refuses every
 * statement after it, so the RESETs could not run at all.
 */
async function resetAndRelease(client: PoolClient): Promise<void> {
  for (const statement of ['ROLLBACK', 'RESET app.current_user_id', 'RESET app.change_source']) {
    const error = await attempt(client, statement);
    if (error !== '') cleanupFailures.push(`${statement} -> ${error}`);
  }
  client.release();
}

/**
 * Seed a documents row plus its invoices row on the given connection and return
 * the document id. Mirrors the inserts in tests/db/field-audit.test.ts, but as a
 * local helper because that file seeds inline in beforeAll against the pool.
 * The id is tracked before the invoices insert so cleanup still finds it if that
 * insert fails, and the invoices insert carries the audit context
 * transaction-locally (like field-audit.test.ts does).
 */
async function seedInvoice(client: PoolClient, tag: string): Promise<string> {
  const docResult = await client.query<IdRow>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Isolation Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `${HASH_PREFIX}-${tag}`],
  );
  const documentId = docResult.rows[0]!.id;
  seeded.push(documentId);

  await client.query('BEGIN');
  await setAuditContext(client, { userId: USER, changeSource: 'extraction' });
  await client.query(
    `INSERT INTO invoices (document_id, vendor_name, total, invoice_date)
     VALUES ($1, 'Isolation Corp', 100.00, '2026-11-03')`,
    [documentId],
  );
  await client.query('COMMIT');

  return documentId;
}

/** Loud cleanup; audit rows cascade away with the document. Returns its failures. */
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

describe.skipIf(skipReason !== '')('audit context connection isolation', () => {
  afterAll(async () => {
    const failures = [...(await cleanup()), ...cleanupFailures];
    if (failures.length > 0) {
      throw new Error(`tests/db/audit-context-isolation.test.ts cleanup failed:\n  ${failures.join('\n  ')}`);
    }
  });

  it(
    'does not attribute a later write on the same connection to an earlier actor',
    async () => {
      const client = await pool.connect();
      try {
        const docA = await seedInvoice(client, 'isolation-a');

        await client.query('BEGIN');
        await setAuditContext(client, { userId: CORRECTING_USER, changeSource: 'manual_correction' });
        await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['11.00', docA]);
        await client.query('COMMIT');

        // Positive control: inside its own transaction the context reached the
        // trigger on this connection. Without it the locality check below could
        // "pass" by the context never being applied at all. CORRECTING_USER is
        // not the seed's USER, so this also fails if the correction had merely
        // picked up the seed's context.
        const stamped = await client.query<{ changed_by: string | null }>(
          `SELECT changed_by FROM document_field_audit
           WHERE document_id = $1 AND tenant_id = $2 AND action = 'update'`,
          [docA, TENANT],
        );
        expect(stamped.rows.length).toBeGreaterThan(0);
        expect(stamped.rows.every((r) => r.changed_by === CORRECTING_USER)).toBe(true);

        // The locality check: no setAuditContext on this transaction, so on this
        // pinned backend app.current_user_id must no longer hold the correcting
        // actor. A session-scoped set_config(false) — the shipped defect — still
        // does.
        await client.query('BEGIN');
        const carried = await readContext(client);
        await client.query('ROLLBACK');
        expect(
          carried.u === CORRECTING_USER || carried.s === 'manual_correction',
          `the actor context survived its transaction on the connection it was set on: ` +
            `app.current_user_id=${JSON.stringify(carried.u)} app.change_source=${JSON.stringify(carried.s)}`,
        ).toBe(false);

        // The brief's end-to-end half of this check — a second, contextless UPDATE
        // whose audit rows must carry a NULL changed_by — is deliberately not here.
        // It could never run: seedInvoice already called setAuditContext on this
        // pinned backend, so Postgres answers the GUC as '' rather than NULL, and
        // the write would die in 0023's unguarded ''::uuid cast
        // (migrations/0023_crum_field_audit.sql:58) instead of proving anything
        // about provenance. That observation belongs to Task 6, which ships the
        // NULLIF guard as migrations/0025_crum_audit_user_placeholder_guard.sql and
        // asserts it on a backend it controls. The RESETs below are part of why the
        // '' placeholder is the state to expect.
      } finally {
        await resetAndRelease(client);
      }
    },
    30_000,
  );

  it(
    'does not hand the actor to the next checkout after client.release()',
    async () => {
      // The boundary the commit message names, and the one the transaction-locality
      // check above only implies: H1 is a leaked context reaching a LATER request,
      // which happens when the pool hands the same physical connection on. With
      // max: 1 the released connection is the one handed back, and because this is
      // session mode the same backend answers both checkouts. A session-scoped
      // set_config is therefore still readable after the handoff; a
      // transaction-local one is not.
      const first = await pool.connect();
      const firstPid = await backendPid(first);
      try {
        await first.query('BEGIN');
        await setAuditContext(first, { userId: CORRECTING_USER, changeSource: 'manual_correction' });
        // In-transaction control: the setting is on this backend right now, so the
        // read below cannot be empty because setAuditContext set nothing at all.
        const inside = await readContext(first);
        expect(inside.u).toBe(CORRECTING_USER);
        await first.query('COMMIT');
      } finally {
        // Released back to the pool without a RESET: whether it still carries the
        // actor is what the next checkout has to report.
        first.release();
      }

      const second = await pool.connect();
      try {
        const secondPid = await backendPid(second);
        expect(
          secondPid,
          `the pool handed the next checkout a different backend (${firstPid} -> ${secondPid}), ` +
            `so this test measured a second connection instead of the handoff`,
        ).toBe(firstPid);

        const carried = await readContext(second);
        expect(
          carried.u === CORRECTING_USER || carried.s === 'manual_correction',
          `the actor context survived client.release() onto the next checkout of the same ` +
            `backend (pid ${firstPid}): app.current_user_id=${JSON.stringify(carried.u)} ` +
            `app.change_source=${JSON.stringify(carried.s)}`,
        ).toBe(false);
      } finally {
        await resetAndRelease(second);
      }
    },
    30_000,
  );
});

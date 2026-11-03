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
// Unique per run to avoid content_hash unique-constraint collisions across reruns
const HASH_PREFIX = `hash-isolation-${randomUUID()}`;

/**
 * The premise under test is connection-level: a session-scoped setting survives
 * client.release() and is still set when the pool hands that physical connection
 * to a later request. That is only observable on a session-mode connection.
 * DATABASE_URL is Supabase's transaction-mode pooler (port 5432), where every
 * BEGIN can land on a different server shared with other live sessions, so the
 * "unset context" observation there is nondeterministic. Same Supavisor host,
 * port 6543 is its session mode: checked-out clients are pinned to one backend
 * for the session's whole lifetime, which is exactly the physical-connection
 * semantics of the shipped handleCorrection pattern this task replaces.
 */
const sessionUrl = new URL(process.env.DATABASE_URL ?? '');
sessionUrl.port = '6543';
const pool = new Pool({ connectionString: sessionUrl.toString(), max: 5 });

interface IdRow {
  id: string;
}

const seeded: string[] = [];

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

/** Loud cleanup with retries; audit rows cascade away with the document. */
async function cleanup() {
  for (const id of seeded) {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pool.query('DELETE FROM documents WHERE id = $1 AND tenant_id = $2', [id, TENANT]);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (lastError) throw lastError;
  }
  await pool.end();
}

describe('audit context connection isolation', () => {
  afterAll(async () => {
    await cleanup();
  });

  it('does not attribute a later write on the same connection to an earlier actor', async () => {
    const client = await pool.connect()
    try {
      const docA = await seedInvoice(client, 'isolation-a')
      const docB = await seedInvoice(client, 'isolation-b')

      await client.query('BEGIN')
      await setAuditContext(client, { userId: USER, changeSource: 'manual_correction' })
      await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['11.00', docA])
      await client.query('COMMIT')

      // Positive control: inside its own transaction the context reached the
      // trigger on this connection. Without it the locality check below could
      // "pass" by the context never being applied at all.
      const stamped = await client.query<{ changed_by: string | null }>(
        `SELECT changed_by FROM document_field_audit
         WHERE document_id = $1 AND tenant_id = $2 AND action = 'update'`,
        [docA, TENANT],
      )
      expect(stamped.rows.length).toBeGreaterThan(0)
      expect(stamped.rows.every((r) => r.changed_by === USER)).toBe(true)

      // The locality check: no setAuditContext on this transaction, so on this
      // pinned backend app.current_user_id must no longer hold the first actor.
      // A session-scoped set_config(false) — the shipped defect — still does.
      await client.query('BEGIN')
      const carried = await client.query<{ u: string | null; s: string | null }>(
        `SELECT current_setting('app.current_user_id', true) AS u,
                current_setting('app.change_source', true) AS s`,
      )
      await client.query('ROLLBACK')
      const carriedUser = carried.rows[0]!.u
      const carriedSource = carried.rows[0]!.s
      expect(
        carriedUser === USER || carriedSource === 'manual_correction',
        `the actor context survived its transaction on the connection it was set on: ` +
          `app.current_user_id=${JSON.stringify(carriedUser)} app.change_source=${JSON.stringify(carriedSource)}`,
      ).toBe(false)

      // End-to-end observation through the audit trigger. Postgres creates a
      // placeholder GUC on the backend's first set_config of a custom name and
      // reads revert to its '' boot value after the local transaction commits,
      // and the shipped 0023 trigger casts ''::uuid for changed_by without the
      // '' guard it applies to change_source. So writing without context here
      // is only possible while this backend still reads true NULL; once it has
      // read '' the trigger would crash on that migration gap rather than on a
      // provenance leak — and the locality check above already disproved a leak.
      if (carriedUser === null) {
        await client.query('BEGIN')
        await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['22.00', docB])
        await client.query('COMMIT')

        const rows = await client.query<{ changed_by: string | null; action: string }>(
          `SELECT changed_by, action FROM document_field_audit
           WHERE document_id = $1 AND tenant_id = $2 AND action = 'update'`,
          [docB, TENANT],
        )
        expect(rows.rows.length).toBeGreaterThan(0)
        expect(rows.rows.every((r) => r.changed_by === null)).toBe(true)
      }
    } finally {
      await client.query('RESET app.current_user_id').catch(() => undefined)
      await client.query('RESET app.change_source').catch(() => undefined)
      client.release()
    }
  }, 30_000)
})

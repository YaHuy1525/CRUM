import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Load .env before any module that reads process.env at import time.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

import { getDbClient } from '../../src/db/client.js';
import type { PoolClient } from 'pg';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
// Unique per run to avoid content_hash unique-constraint collisions across reruns
const HASH_INVOICE = `hash123-${randomUUID()}`;
const HASH_CONTRACT = `hash456-${randomUUID()}`;

interface IdRow {
  id: string;
}
interface AuditRow {
  field_name: string;
  action: string;
  old_value: unknown;
  new_value: unknown;
  changed_by: string;
  change_source: string;
}
interface FieldNameRow {
  field_name: string;
}
interface ChangeSourceRow {
  change_source: string;
}

/**
 * Set audit session variables on a dedicated connection.
 * Uses set_config() because SET LOCAL does not support parameterised queries.
 * The third argument (true) scopes the setting to the current transaction.
 */
async function setAuditContextOn(client: PoolClient, userId: string, changeSource: string) {
  await client.query('SELECT set_config($1, $2, $3)', ['app.current_user_id', userId, true]);
  await client.query('SELECT set_config($1, $2, $3)', ['app.change_source', changeSource, true]);
}

/** Safely start a fresh transaction, rolling back any leftover aborted state. */
async function safeBegin(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* no transaction — fine */
  }
  await client.query('BEGIN');
}

describe('field audit triggers', () => {
  let documentId: string;
  let client: PoolClient;

  beforeAll(async () => {
    const pool = getDbClient();
    client = await pool.connect();

    const docResult = await pool.query<IdRow>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
       VALUES ($1, $2, 'invoice', 'Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
       RETURNING id`,
      [TENANT, USER, HASH_INVOICE],
    );
    documentId = docResult.rows[0]!.id;
  });

  afterAll(async () => {
    try {
      await client.query('ROLLBACK');
      await client.query('DELETE FROM documents WHERE id = $1', [documentId]);
    } catch {
      // best-effort cleanup
    }
    client.release();
  });

  it('fires on INSERT and logs all non-null fields', async () => {
    await safeBegin(client);
    await setAuditContextOn(client, USER, 'extraction');

    await client.query(
      `INSERT INTO invoices (document_id, vendor_name, total, invoice_date, field_confidence)
       VALUES ($1, 'Acme Corp', 1250.00, '2026-11-03', '{"vendor_name": 0.95, "total": 0.88}')`,
      [documentId],
    );

    const auditResult = await client.query<AuditRow>(
      `SELECT field_name, action, new_value, changed_by, change_source
       FROM document_field_audit
       WHERE document_id = $1 AND table_name = 'invoices'
       ORDER BY changed_at DESC`,
      [documentId],
    );

    await client.query('COMMIT');

    expect(auditResult.rows.length).toBeGreaterThanOrEqual(3);

    const vendorRow = auditResult.rows.find((r) => r.field_name === 'vendor_name');
    expect(vendorRow).toMatchObject({
      action: 'insert',
      new_value: 'Acme Corp',
      changed_by: USER,
      change_source: 'extraction',
    });

    const totalRow = auditResult.rows.find((r) => r.field_name === 'total');
    expect(totalRow).toBeDefined();
    expect(totalRow!.action).toBe('insert');
    // numeric -> jsonb: pg returns the value; coerce to number for comparison
    expect(Number(totalRow!.new_value)).toBe(1250);
  });

  it('fires on UPDATE and logs old and new values', async () => {
    await safeBegin(client);
    await setAuditContextOn(client, USER, 'manual_correction');

    await client.query(`UPDATE invoices SET total = 1300.00 WHERE document_id = $1`, [documentId]);

    const auditResult = await client.query<AuditRow>(
      `SELECT field_name, action, old_value, new_value, change_source
       FROM document_field_audit
       WHERE document_id = $1 AND table_name = 'invoices' AND field_name = 'total'
       ORDER BY changed_at DESC
       LIMIT 1`,
      [documentId],
    );

    await client.query('COMMIT');

    expect(auditResult.rows[0]).toMatchObject({
      field_name: 'total',
      action: 'update',
      change_source: 'manual_correction',
    });
    expect(Number(auditResult.rows[0]!.old_value)).toBe(1250);
    expect(Number(auditResult.rows[0]!.new_value)).toBe(1300);
  });

  it('excludes metadata fields from audit', async () => {
    const auditResult = await client.query<FieldNameRow>(
      `SELECT field_name FROM document_field_audit
       WHERE document_id = $1 AND table_name = 'invoices'`,
      [documentId],
    );

    const fieldNames = auditResult.rows.map((r) => r.field_name);
    expect(fieldNames).not.toContain('id');
    expect(fieldNames).not.toContain('document_id');
    expect(fieldNames).not.toContain('tenant_id');
    expect(fieldNames).not.toContain('created_at');
    expect(fieldNames).not.toContain('updated_at');
    expect(fieldNames).not.toContain('field_confidence');
  });

  it('defaults change_source to extraction when not set', async () => {
    // Reset the session variable so the trigger sees no change_source
    await client.query('RESET app.change_source');

    const docResult = await client.query<IdRow>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
       VALUES ($1, $2, 'contract', 'Test Contract', 'upload', $3, 'Test content', 'text/plain', 'ready')
       RETURNING id`,
      [TENANT, USER, HASH_CONTRACT],
    );
    const contractDocId = docResult.rows[0]!.id;

    await safeBegin(client);
    await client.query('SELECT set_config($1, $2, $3)', ['app.current_user_id', USER, true]);
    // Deliberately do NOT set app.change_source — trigger should default to 'extraction'

    await client.query(
      `INSERT INTO contracts (document_id, counterparty, contract_value)
       VALUES ($1, 'Test Corp', 5000.00)`,
      [contractDocId],
    );

    const auditResult = await client.query<ChangeSourceRow>(
      `SELECT change_source FROM document_field_audit
       WHERE document_id = $1 AND table_name = 'contracts'
       LIMIT 1`,
      [contractDocId],
    );

    await client.query('COMMIT');

    expect(auditResult.rows[0]!.change_source).toBe('extraction');

    await client.query('DELETE FROM documents WHERE id = $1', [contractDocId]);
  });
});

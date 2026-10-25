import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checksum,
  isCrumMigration,
  listMigrations,
  MigrationError,
  MIGRATIONS_TABLE,
  parseVersion,
} from '../../scripts/db-migrate'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations')
const SPINE_PATH = path.join(MIGRATIONS_DIR, '0002_crum_spine.sql')
const SPINE = readFileSync(SPINE_PATH, 'utf8')

/**
 * The nine tables of the spine: §5.1's eight business objects plus human_tasks,
 * which §4.6.1's refuse path writes when a tool is gated at `refuse`.
 */
const SPINE_TABLES = [
  'customers',
  'contacts',
  'followups',
  'tasks',
  'schedules',
  'knowledge_documents',
  'pending_writes',
  'audit_receipts',
  'human_tasks',
] as const

function tableBlock(name: string): string {
  const header = `CREATE TABLE IF NOT EXISTS ${name} (`
  const start = SPINE.indexOf(header)
  expect(start, `${name} is not created`).toBeGreaterThan(-1)
  const end = SPINE.indexOf('\n);', start)
  expect(end, `${name} is not terminated`).toBeGreaterThan(start)
  return SPINE.slice(start, end)
}

describe('the spine schema', () => {
  it('creates all nine tables', () => {
    for (const table of SPINE_TABLES) {
      expect(tableBlock(table).length, table).toBeGreaterThan(0)
    }
  })

  it('scopes every table to a non-nullable tenant', () => {
    for (const table of SPINE_TABLES) {
      expect(tableBlock(table), table).toMatch(/tenant_id\s+uuid\s+NOT NULL/)
    }
  })

  it('names a responsible person on every row a human can act on', () => {
    for (const table of ['customers', 'followups', 'tasks', 'schedules', 'knowledge_documents']) {
      expect(tableBlock(table), table).toMatch(/owner_id\s+uuid\s+NOT NULL/)
    }
    expect(tableBlock('pending_writes')).toMatch(/requested_by\s+uuid\s+NOT NULL/)
    expect(tableBlock('audit_receipts')).toMatch(/approved_by\s+uuid\s+NOT NULL/)
    expect(tableBlock('human_tasks')).toMatch(/requested_by\s+uuid\s+NOT NULL/)
  })

  it('derives contact visibility from the parent customer instead of duplicating an owner', () => {
    expect(tableBlock('contacts')).not.toMatch(/owner_id/)
    expect(tableBlock('contacts')).toMatch(
      /customer_id\s+uuid\s+NOT NULL REFERENCES customers\(id\) ON DELETE CASCADE/,
    )
  })

  it('keeps team sharing on the customer only', () => {
    expect(tableBlock('customers')).toMatch(/team_member_ids\s+uuid\[\]\s+NOT NULL DEFAULT '\{\}'/)
    for (const table of SPINE_TABLES) {
      if (table === 'customers') continue
      expect(tableBlock(table), table).not.toMatch(/team_member_ids/)
    }
  })

  /**
   * §5.1 makes the task/schedule split a product rule: a task has a deadline
   * only, a schedule has a concrete range, and the agent must classify on the
   * presence of a start time. Encoding it in the schema means a misclassified
   * write fails instead of silently storing a task with a start time nobody
   * reads.
   */
  it('enforces the task/schedule split in the schema rather than in prose', () => {
    expect(tableBlock('tasks')).toMatch(/deadline\s+timestamptz/)
    expect(tableBlock('tasks')).not.toMatch(/start_time/)
    expect(tableBlock('schedules')).toMatch(/start_time\s+timestamptz\s+NOT NULL/)
    expect(tableBlock('schedules')).toMatch(/end_time\s+timestamptz\s+NOT NULL/)
    expect(SPINE).toContain('CONSTRAINT schedules_end_after_start CHECK (end_time > start_time)')
  })

  it('orders the approval queue by risk then age', () => {
    expect(SPINE).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pending_queue ON pending_writes (tenant_id, risk_score DESC, created_at ASC)',
    )
    expect(SPINE).toMatch(/WHERE receipt_id IS NULL AND rejected_at IS NULL/)
  })

  it('allows exactly one receipt per staged draft', () => {
    expect(SPINE).toContain('CONSTRAINT uq_receipts_draft UNIQUE (pending_write_id)')
  })

  it('dedupes knowledge uploads by content hash within a tenant', () => {
    expect(SPINE).toContain('CONSTRAINT uq_knowledge_document_hash UNIQUE (tenant_id, content_hash)')
  })

  it('closes the pending_writes / audit_receipts cycle with a guarded ALTER', () => {
    expect(SPINE).toMatch(/pg_constraint WHERE conname = 'fk_pending_writes_receipt'/)
  })

  it('caps risk scores inside the band the scorer produces', () => {
    expect(tableBlock('pending_writes')).toMatch(
      /risk_score\s+integer\s+NOT NULL CHECK \(risk_score BETWEEN 0 AND 100\)/,
    )
  })

  it('only accepts the gates the policy loader can return', () => {
    expect(tableBlock('pending_writes')).toMatch(/CHECK \(gate IN \('auto', 'approval', 'refuse'\)\)/)
  })

  it('leaves transaction control to the runner', () => {
    expect(SPINE).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;\s*$/m)
  })

  it('is idempotent so a half-applied migration can be retried', () => {
    const creates = SPINE.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)/g) ?? []
    const guarded = SPINE.match(/CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/g) ?? []
    expect(guarded.length).toBe(creates.length)
    expect(creates.length).toBeGreaterThan(20)
  })
})

describe('migration discovery', () => {
  it('applies only CRUM-owned migrations', () => {
    expect(isCrumMigration('0002_crum_spine.sql')).toBe(true)
    expect(isCrumMigration('0003_crum_add_foo.sql')).toBe(true)
    expect(isCrumMigration('0001_mastra_core.sql')).toBe(false)
    expect(isCrumMigration('0002_crum_SPINE.sql')).toBe(false)
    expect(isCrumMigration('2_crum_spine.sql')).toBe(false)
    expect(isCrumMigration('README.md')).toBe(false)
  })

  it('lists the spine and never the generated snapshot', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names).toContain('0002_crum_spine.sql')
    expect(names).not.toContain('0001_mastra_core.sql')
  })

  it('returns migrations in version order', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names).toEqual([...names].sort())
  })

  /**
   * crum_schema_migrations.version is the PRIMARY KEY and the runner derives it
   * from the 4-digit filename prefix ALONE, so two files sharing a prefix cannot
   * both be applied: the first INSERT lands, the second collides, the transaction
   * rolls back, and `npm run db:migrate` fails for every environment after it.
   * Nothing else detects this, because both files are individually valid and the
   * collision only appears at apply time against a real database.
   */
  it('gives every migration a distinct version prefix', () => {
    const versions = listMigrations(MIGRATIONS_DIR).map((m) => m.version)
    expect(new Set(versions).size, `duplicate version in ${versions.join(', ')}`).toBe(
      versions.length,
    )
  })

  it('ignores subdirectories and non-SQL files', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names.every((n) => n.endsWith('.sql'))).toBe(true)
    expect(names.every((n) => !n.includes('/'))).toBe(true)
  })

  it('parses the four-digit version prefix', () => {
    expect(parseVersion('0002_crum_spine.sql')).toBe('0002')
    expect(parseVersion('0107_crum_add_foo.sql')).toBe('0107')
  })

  it('rejects a filename it would not apply', () => {
    expect(() => parseVersion('0001_mastra_core.sql')).toThrowError(MigrationError)
    expect(() => parseVersion('nope.sql')).toThrowError(MigrationError)
  })

  it('throws rather than returning an empty list for a missing directory', () => {
    expect(() => listMigrations(path.join(MIGRATIONS_DIR, 'does-not-exist'))).toThrowError(
      MigrationError,
    )
  })

  it('checksums deterministically', () => {
    expect(checksum('a')).toBe(checksum('a'))
    expect(checksum('a')).not.toBe(checksum('b'))
    expect(checksum('a')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('checksums every listed migration', () => {
    for (const migration of listMigrations(MIGRATIONS_DIR)) {
      expect(migration.checksum).toBe(checksum(migration.sql))
    }
  })

  it('names the version table the runner records into', () => {
    expect(MIGRATIONS_TABLE).toBe('crum_schema_migrations')
    expect(SPINE).not.toContain(MIGRATIONS_TABLE)
  })
})

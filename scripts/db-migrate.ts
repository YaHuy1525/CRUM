import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { Pool as PoolType } from 'pg'
import { parseEnv } from '../src/config/env'
import type { CrumEnv } from '../src/config/env'
import { buildMastraStorage, isPostgresStorage } from '../src/mastra/storage'

/**
 * CRUM-owned migrations match this. Generated snapshots are named
 * NNNN_mastra_*.sql and are excluded, because replaying DDL the adapter owns
 * would break on the next Mastra upgrade.
 */
const CRUM_MIGRATION_PATTERN = /^(\d{4})_crum_[a-z0-9_]+\.sql$/

export const MIGRATIONS_TABLE = 'crum_schema_migrations'

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface Migration {
  version: string
  filename: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export function isCrumMigration(filename: string): boolean {
  return CRUM_MIGRATION_PATTERN.test(filename)
}

export function parseVersion(filename: string): string {
  const match = CRUM_MIGRATION_PATTERN.exec(filename)
  const version = match?.[1]
  if (version === undefined) {
    throw new MigrationError(`not a CRUM migration filename: ${filename}`)
  }
  return version
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export function listMigrations(dir: string): Migration[] {
  let filenames: string[]
  try {
    filenames = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCrumMigration(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    throw new MigrationError(
      `cannot read migrations directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return filenames.sort().map((filename) => {
    const sql = readFileSync(path.join(dir, filename), 'utf8')
    return { version: parseVersion(filename), filename, sql, checksum: checksum(sql) }
  })
}

const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS crum_schema_migrations (
  version     text        PRIMARY KEY,
  filename    text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)
`

/**
 * Applies every unapplied CRUM migration in version order.
 *
 * Each migration and its version record are written inside one transaction, so a
 * failure leaves neither. Migration files must not contain their own BEGIN or
 * COMMIT: an inner COMMIT would land the DDL before the record exists, and a
 * crash in between would replay it on the next run.
 *
 * A version whose checksum differs from the recorded one is a hard error rather
 * than a re-apply. A deployed database cannot be rewound by editing history, and
 * silently running edited DDL against tables that already exist is how a schema
 * and its migrations stop describing the same thing.
 */
export async function migrate(
  pool: PoolType,
  dir: string = path.resolve(process.cwd(), 'migrations'),
): Promise<MigrationResult> {
  const migrations = listMigrations(dir)
  const client = await pool.connect()

  try {
    await client.query(ENSURE_MIGRATIONS_TABLE)

    const recorded = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM crum_schema_migrations`,
    )
    const seen = new Map(recorded.rows.map((row) => [row.version, row.checksum]))

    const applied: string[] = []
    const skipped: string[] = []

    for (const migration of migrations) {
      const previous = seen.get(migration.version)

      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new MigrationError(
            `${migration.filename} changed after it was applied. Write a new migration instead of editing an applied one.`,
          )
        }
        skipped.push(migration.filename)
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          `INSERT INTO crum_schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new MigrationError(
          `${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      applied.push(migration.filename)
    }

    return { applied, skipped }
  } finally {
    client.release()
  }
}

/**
 * The path CI and deploys take. Constructs storage with disableInit forced to
 * false so `init()` creates Mastra's own tables, then applies CRUM's. Runtime
 * code keeps disableInit true and never mutates the schema (§14.2).
 */
export async function main(raw: NodeJS.ProcessEnv = process.env): Promise<MigrationResult> {
  const env: CrumEnv = parseEnv({ ...raw, MASTRA_DB_DISABLE_INIT: 'false' })

  if (!env.DATABASE_URL) {
    throw new MigrationError(
      'DATABASE_URL is required to migrate; there is nothing to migrate against in-memory storage',
    )
  }

  const storage = buildMastraStorage(env)
  if (!isPostgresStorage(storage)) {
    throw new MigrationError(
      'buildMastraStorage returned an in-memory store even though DATABASE_URL is set',
    )
  }

  try {
    await storage.init()
    return await migrate(storage.pool)
  } finally {
    await storage.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
    .then((result) => {
      process.stdout.write(`applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'none'}\n`)
      process.stdout.write(`skipped: ${result.skipped.length > 0 ? result.skipped.join(', ') : 'none'}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}

// Referenced so `Pool` is not tree-shaken out of the type graph by
// verbatimModuleSyntax; the value import is what migrate() type-checks against.
export type { Pool }

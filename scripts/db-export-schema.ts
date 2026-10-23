import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportSchemas } from '@mastra/pg'

export const MIGRATIONS_DIRNAME = 'migrations'
export const GENERATED_FILENAME = '0001_mastra_core.sql'

/**
 * No timestamp, no version string, nothing that changes between runs. CI applies
 * this file and then runs `git diff --exit-code migrations/`, so a single
 * nondeterministic byte would fail every build and train everyone to ignore it.
 */
const HEADER = `-- GENERATED FILE. DO NOT EDIT BY HAND.
-- Regenerate with: npm run db:export-schema
-- Source: exportSchemas() from the installed @mastra/pg. See package.json for the pin.
--
-- This is a committed snapshot of the DDL Mastra's own storage.init() applies:
-- memory threads and messages, workflow runs and suspensions, scores, agents,
-- MCP clients and servers, workspaces, and the observability tables.
--
-- It is documentation and a drift alarm, not a migration. scripts/db-migrate.ts
-- never replays it: the adapter creates and upgrades these tables itself, and
-- hand-applying generated DDL would break on the next Mastra minor version.
-- CI regenerates the file and fails if the result differs from what is
-- committed, so a Mastra upgrade that changes the schema cannot land unread.
-- See TECHNICAL_PLAN.md §14.2.
`

/**
 * @param schemaName forwarded to exportSchemas(). Phase 0 uses the default
 *   schema and callers pass nothing. A non-default schema becomes relevant with
 *   `storageIsolationKey`, which no Phase 0 code sets.
 */
export function renderMastraCoreSchema(schemaName?: string): string {
  return `${HEADER}\n${exportSchemas(schemaName)}`
}

export function generatedSchemaPath(cwd: string = process.cwd()): string {
  return path.join(cwd, MIGRATIONS_DIRNAME, GENERATED_FILENAME)
}

export function writeMastraCoreSchema(cwd: string = process.cwd()): string {
  const target = generatedSchemaPath(cwd)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, renderMastraCoreSchema(), 'utf8')
  return target
}

function main(): void {
  const target = writeMastraCoreSchema()
  const relative = path.relative(process.cwd(), target)
  const bytes = renderMastraCoreSchema().length
  process.stdout.write(`wrote ${relative} (${bytes} bytes)\n`)
  process.stdout.write('run `git diff --exit-code migrations/` to confirm it is unchanged\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

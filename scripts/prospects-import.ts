// scripts/prospects-import.ts
//
// Loads one prospect CSV into Postgres for a single tenant. The import writes
// directly: the prospect_import_batches row is the audit record for the run (who
// requested it and the counts), not a signed receipt, so there is no pending
// write to approve later.
//
// Merge candidates are keyed on prospect ids, never on name_normalized: two
// prospects can share a name, and the planner hands back the id of an existing
// prospect or the insert index of an earlier row in the same file.
//
// Usage: PROSPECT_TENANT_ID=... PROSPECT_USER_ID=... \
//   npx tsx scripts/prospects-import.ts <file.csv> [--dry-run]
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { closeDbClient, getDbClient } from '../src/db/client'
import { parseCsv, parseProspectRows } from '../src/prospects/csv'
import { planImport, type ExistingProspect, type MergeCandidatePlan } from '../src/prospects/import'

interface Options {
  file: string
  tenantId: string
  userId: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Options {
  const file = argv[2]
  const tenantId = process.env.PROSPECT_TENANT_ID
  const userId = process.env.PROSPECT_USER_ID
  if (!file || !tenantId || !userId) {
    throw new Error('usage: prospects-import <file.csv> with PROSPECT_TENANT_ID and PROSPECT_USER_ID set')
  }
  return { file, tenantId, userId, dryRun: argv.includes('--dry-run') }
}

interface ExistingRow {
  id: string
  name: string
  country: string
  platform: string
  handle_normalized: string
}

async function loadExisting(tenantId: string): Promise<ExistingProspect[]> {
  const result = await getDbClient().query<ExistingRow>(
    `SELECT p.id, p.name, p.country, c.platform, c.handle_normalized
       FROM prospects p
       JOIN prospect_channels c ON c.prospect_id = p.id
      WHERE p.tenant_id = $1`,
    [tenantId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    country: row.country as 'AU' | 'VN',
    platform: row.platform,
    handleNormalized: row.handle_normalized,
  }))
}

function resolveLeftId(candidate: MergeCandidatePlan, insertedIds: string[]): string {
  if (candidate.leftProspectId !== null) return candidate.leftProspectId
  const indexed = candidate.leftInsertIndex === null ? undefined : insertedIds[candidate.leftInsertIndex]
  if (!indexed) {
    throw new Error(`merge candidate for ${candidate.rightName} has no resolvable left prospect`)
  }
  return indexed
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv)
    const text = readFileSync(options.file, 'utf8')
    const fileHash = createHash('sha256').update(text).digest('hex')
    const rows = parseProspectRows(parseCsv(text))
    const existing = await loadExisting(options.tenantId)
    const plan = planImport(rows, existing)

    console.log(JSON.stringify({ fileHash, ...plan.counts }, null, 2))
    if (options.dryRun) {
      console.log('dry run, nothing written')
      return
    }

    const client = await getDbClient().connect()
    try {
      await client.query('BEGIN')

      const batch = await client.query<{ id: string }>(
        `INSERT INTO prospect_import_batches
           (tenant_id, requested_by, file_hash, file_name, rows_in, rows_new, rows_duplicate, rows_candidate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [options.tenantId, options.userId, fileHash, options.file, plan.counts.rowsIn,
          plan.counts.rowsNew, plan.counts.rowsDuplicate, plan.counts.rowsCandidate],
      )

      const insertedIds: string[] = []
      for (const row of plan.inserts) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO prospects (tenant_id, name, name_normalized, country, city, category, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [options.tenantId, row.name, row.nameNormalized, row.country, row.location, row.category, options.userId],
        )
        const prospectId = inserted.rows[0]?.id
        if (!prospectId) throw new Error(`prospect insert returned no id for ${row.name}`)
        insertedIds.push(prospectId)

        await client.query(
          `INSERT INTO prospect_channels
             (tenant_id, prospect_id, platform, handle, handle_normalized, profile_url,
              audience_count, audience_basis, audience_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [options.tenantId, prospectId, row.platform, row.handle, row.handleNormalized, row.profileUrl,
            row.audience.count, row.audience.basis, row.audience.confidence],
        )
        await client.query(
          `INSERT INTO prospect_snapshots
             (tenant_id, prospect_id, what_they_sell, price_min_minor, price_max_minor, currency,
              price_visible, source_url, extractor_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'import-v1')`,
          [options.tenantId, prospectId, row.whatTheySell, row.price.minMinor, row.price.maxMinor,
            row.price.currency, row.price.minMinor !== null, row.profileUrl],
        )
      }

      for (const candidate of plan.candidates) {
        const rightId = insertedIds[candidate.rightInsertIndex]
        if (!rightId) {
          throw new Error(`merge candidate for ${candidate.rightName} has no right prospect`)
        }
        await client.query(
          `INSERT INTO prospect_merge_candidates
             (tenant_id, left_prospect_id, right_prospect_id, reason, similarity)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, left_prospect_id, right_prospect_id) DO NOTHING`,
          [options.tenantId, resolveLeftId(candidate, insertedIds), rightId,
            candidate.reason, candidate.similarity],
        )
      }

      await client.query('COMMIT')
      console.log(`imported ${plan.inserts.length} prospects, batch ${batch.rows[0]?.id ?? 'unknown'}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await closeDbClient()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

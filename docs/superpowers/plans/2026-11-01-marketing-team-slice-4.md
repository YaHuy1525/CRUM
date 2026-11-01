# AI Marketing Team, Slice 4 (Generated Images and the Cognitive Forcing Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the creative-designer's stored prompts into real PNG assets through Replicate under a daily spend ceiling, and make a reviewer commit a prediction in writing before the bundle screen will show them the copy or the pictures.

**Architecture:** Two halves sharing no table. 4a adds a provider adapter (`src/marketing/replicate.ts`), an append-only spend ledger (`marketing_image_spend`), and `marketing.generate_assets`: an auto-class content write that reads prompts out of the stored `creative-designer` artifact row, pays per image under a ceiling, and attaches each result as a `documents` row of the new `marketing_asset` kind plus a `document_files` byte row. 4b adds `reviewer_predictions`, a REST surface that withholds prose and pixels until a prediction exists for the bundle's open stage draft, and the console gate that renders nothing but a textarea until it does. Nothing external learns anything; the only outbound HTTP is the asset pass.

**Tech Stack:** TypeScript, Node 22.18, Mastra `@mastra/core` 1.79 (`createTool`), Hono 4.13, `pg` 8.23 against Postgres, Zod 4.6, Vitest 3.2 with two inline projects (`unit`, `integration`), Next.js 15 / React 19 console with its own Vitest + Testing Library setup, `tsx` for scripts, Replicate HTTP API v1 (`black-forest-labs/flux-1.1-pro`).

**Spec:** `docs/superpowers/specs/2026-11-01-marketing-team-slice-4-design.md`, committed at `17db02c`. Sections 3 through 14 are the requirements this plan argues from. Read section 4.1 before touching `documents`, section 5 before writing a Replicate call, section 6.1 before touching staging, and section 8 before touching the console.

## Global constraints

- **A generated image is a `documents` row, not a new table.** No `content_bytes` column anywhere. Bytes go in the existing `document_files` lane, which is why Task 2's guard hoist is load-bearing rather than cosmetic (spec section 4.1).
- **An asset arrives `needs_review` and only a human flips it.** `marketing.generate_assets` never writes `ready`, and no code path auto-approves a generated face. The flip is the existing `reviewDocument` / `POST /api/documents/:id/review`.
- **Money is capped by the ledger, not by a reader.** The ceiling is checked before the run and again before every asset inside the loop. The pre-run estimate uses `CRUM_IMAGE_COST_MINOR_PER_IMAGE`; the recorded figure is always the real `cost` Replicate reports, and a prediction response with no `cost` field is a refusal rather than an estimate.
- **No automated test calls Replicate, a model, or a real domain.** `fetchImpl` is injected on both the create/poll calls and the byte download, exactly as slices 2 and 3 do with Meta. Provider bytes are hit only in the manual walkthrough.
- **Campaigns are still always created paused, and no external HTTP call ever runs inside a SQL transaction.** Slice 4 changes neither rule; the spend row and the document row are deliberately separate transactions (spec section 9).
- Node `>= 22.18.0`, `@mastra/core` `1.79.0`, `zod` `4.6.7`, as pinned in `package.json` and asserted by `tests/build/pins.test.ts`. **No new npm dependency.** The Replicate client is hand-written `fetch`, because the official SDK is a browser library and this is a server.
- Code style matches the repo: single quotes, no semicolons, two-space indent, `export const` for tools, no `any` (ESLint `@typescript-eslint/no-unsafe-*` is on). Every new file opens with a comment saying why it exists, in the voice of `migrations/0018_crum_marketing.sql` and `src/marketing/payload.ts`.
- Tool names must satisfy `src/governance/schema.ts:16`. `marketing.generate_assets` is legal; `marketing.generateAssets` is a boot failure. `idempotency_key` must come from the closed `IDEMPOTENCY_KEYS` enum in `src/governance/schema.ts:8`; the new tool declares `draftHash`.
- Any commit that changes the declared tool surface changes `policy/tools.yaml`, `SPEC_TOOL_SURFACE` in `tests/governance/conformance.test.ts`, the counts in `tests/governance/policy.test.ts:57,69`, the counts in `tests/mastra/active-tools.test.ts:44,70-82,142`, the registry count in `tests/mastra/agent.test.ts:51-53`, and the golden item count in `tests/evals/dataset-seed.test.ts:6,8,23` and `tests/evals/golden-gate.test.ts:184,185` whenever an item is added (Task 7), and the `docs/TECHNICAL_PLAN.md` section 4.6.2 table **in the same commit** (Task 6), or `npm run test:policy` fails.
- **One golden item moves two assertions.** `getGoldenItems()`'s length is asserted in `tests/evals/dataset-seed.test.ts` and again, as `summary.totalItems`, in `tests/evals/golden-gate.test.ts`. A task that adds an item moves 42 to 43 in both, or Task 14's paid run fails on an arithmetic fact instead of on the behaviour it exists to check.
- **Line numbers in this plan are read off `main` at writing time; the named anchor is the instruction.** Every task after Task 6 appends to files that other tasks also touch, so a number cited in a later task is already stale by the time it is reachable. `grep -n` for the quoted code, insert beside what you find, and say so in the report if the number and the file disagree. A number is a hint; the quoted line is the requirement.
- **Run Vitest with explicit file paths, never a bare `--project unit`.** `tests/evals/golden-gate.test.ts` sits in the unit project and calls the live model, so an unfiltered project run costs about twelve model-minutes per go. `npx vitest run tests/marketing/replicate.test.ts`, not `npx vitest run --project unit`.
- `npm run verify` is red in this repository for reasons unrelated to this slice (backlog M1: six integration failures). This plan's gate is `npm run typecheck`, `npm run lint`, the named test files, and one filtered integration run. Task 14 compares the final full-suite shape against the slice 3 baseline and reports it without hiding it.
- **A `pending_writes` fixture with `operation = 'update'` must supply `target_id`.** `pending_writes_update_needs_target` (`migrations/0002_crum_spine.sql:163`) is live and rejects the insert otherwise, and `target_id` carries no foreign key, so a placeholder uuid is honest for a `marketing_stage` draft. Task 1's file names the constant `TARGET`.
- **Two integration failures are baseline, not this slice's.** `tests/integration/migrations.test.ts > refuses a second receipt for the same staged draft` inserts without `draft_hash` (NOT NULL since `migrations/0003_crum_add_draft_hash.sql:21`), and `tests/integration/marketing-metrics-migration.test.ts` asserts `/^pk_marketing_metrics_snapshots/` while 0020's inline `PRIMARY KEY` makes Postgres name it `marketing_metrics_snapshots_pkey`. Both predate 0021; neither may be "fixed" by a task in this plan.
- The working tree carries another effort's uncommitted edits to `.env.example`, `src/mastra/memory.ts`, `src/mastra/recall.ts`, `tests/mastra/memory.test.ts` and `tests/mastra/recall.test.ts`. **Never stage one of those paths.** `git add` takes an explicit file list every time; `git add -A` and `git add .` are forbidden in this plan. `.env.example` is not modified by any task: spec section 14 records the four variables in the spec instead of staging that file.
- Each task ends with its own named test command green and one commit.

## Three spec refinements, decided here rather than mid-task

The spec is the authority on intent. These three points were checked against the code and do not survive contact with it, so the plan records the correction once, up front, and every later task follows it.

**1. The `marketing_asset` intake guard belongs in `ingestStep`, not `src/api/documents.ts`.** Spec section 4.1 bullet 1 asks `src/api/documents.ts` to refuse intake on a document whose `kind` is `marketing_asset`. That router's only intake trigger is `POST /upload` (`src/api/documents.ts:80`), which never names an existing document; it takes a multipart file, and the intake workflow's `kind` enum (`src/mastra/workflows/document-intake.ts`) can only produce `invoice | contract | other`. The guard as written would be vacuous: reachable code that asserts about a state no caller can construct. Embedding happens in exactly one function, `ingestStep` (`src/mastra/workflows/ingest.ts:41`), so Task 12 puts the check there — read the row's `kind`, return `{ chunkCount: 0, indexName }` without chunking for a `marketing_asset`. That covers the upload route, the asset pass, and any future re-index caller with one predicate. `src/api/documents.ts` gains no new branch, and section 4.1's stated goal ("a future re-index cannot embed bytes") is met rather than approximated.

**2. `marketing.generate_assets` creates no `pending_writes` draft.** Spec section 6 says "auto-committed". The auto lane is `getOrCreateDraft` then `commitAutoWrite`, whose `applyDraft` dispatches on `object_type` — a CHECK-restricted column — and no HTTP may run inside a transaction. Making the tool's draft commit mean "call Replicate" would break both. So the tool writes its rows directly (the same way it already must write `document_files`), creates no draft row, is audited by `marketing_image_spend` plus a `human_tasks` row on every refusal, and returns `humanTaskId` rather than `pendingWriteId` when it refuses. The declared policy class stays `auto`, so governance still gates it, the console's approval queue is untouched, and the risk view is still scored. Spec section 6's reasoning ("nothing outside CRUM learns anything; the money is capped by the ledger") holds exactly as written; only the draft row goes.

**3. `marketing_image_spend` gains a `raw_extract` column that section 4.2's table does not list.** Section 9 promises that a paid prediction whose bytes failed to download is recorded "with `document_id` null and the prediction id in `raw_extract`, so the owner can re-fetch from Replicate within its expiry window". Section 4.2's column table has no such column, and a promise that no row can hold is not a promise. Task 1 adds `raw_extract jsonb` to the table, nullable and write-only in this slice: Task 6's tool puts `{ predictionId, model, costUsd }` in it on every spend row, whether or not bytes arrived. Nothing reads it back automatically, and no re-fetch tool exists; the column is the audit handle section 9 asked for, and the walkthrough reads it with `psql`. The alternative, deleting section 9's sentence, would leave a failed download as money spent with no record of what was bought.

## Integration cluster

Every integration step runs against the throwaway Postgres the slice 2 and 3 walkthroughs left on port 5455, data directory `D:/pgdata-crum-slice1`. If it is gone, recreate it:

```bash
"/c/Program Files/PostgreSQL/17/bin/initdb.exe" -D "D:/pgdata-crum-slice1" -U crum_test --auth=trust
"/c/Program Files/PostgreSQL/17/bin/pg_ctl.exe" -D "D:/pgdata-crum-slice1" -o "-p 5455" -l "D:/pgdata-crum-slice1/log" start
"/c/Program Files/PostgreSQL/17/bin/createdb.exe" -h localhost -p 5455 -U crum_test crum_slice4
```

Then export once per shell:

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice4"
```

Tests that need migrations applied call `migrate` from `scripts/db-migrate.ts` inside `beforeAll`, the pattern `tests/integration/marketing-metrics-migration.test.ts:4,13` already uses. A new `0021_*.sql` needs no registration: `scripts/db-migrate.ts:20` picks it up on the `^(\d{4})_crum_[a-z0-9_]+\.sql$` match.

## File structure

| Kind | Path | Responsibility |
|---|---|---|
| Migration | `migrations/0021_crum_marketing_assets.sql` (new) | Widen two `documents` CHECK constraints, add one partial index, add `marketing_image_spend` and `reviewer_predictions`. No new column on `documents` |
| Data | `src/db/documents.ts` (modify) | Widen `PersistDocumentInput` **and** `DocumentRow`, hoist the `document_files` write out of the parse guard, exclude `marketing_asset` from `listDocuments` unless a `kind` filter asks for it |
| Provider | `src/marketing/replicate.ts` (new) | Create a prediction, poll it, download the bytes, refuse on cost, size, prompt length and aspect ratio |
| Provider | `src/marketing/image-provider.ts` (new) | The registered-adapter seam the tool reads, so an absent token is a call-time refusal rather than a boot failure |
| Spend | `src/marketing/image-spend.ts` (new) | Ceiling arithmetic as a pure function, committed spend read, append-only spend write |
| Prompts | `src/marketing/asset-prompts.ts` (new) | Parse the designer artifact's `assets` array into prompts, with the two refusal reasons |
| Data | `src/db/marketing-assets.ts` (new) | Insert one image through `insertDocument` with hash dedup, read its bytes, read the designer artifact text, list image artifacts with their document status, list bundles holding a document |
| Tool | `src/mastra/tools/marketing-writes.ts` (modify) | `marketing.generate_assets`, and section 6.1's unreviewed-image refusal on `marketing.stage_bundle` |
| Payload | `src/marketing/payload.ts` (modify) | `generateAssetsRiskView`, the redacted view the hygiene sweep reads |
| Governance | `policy/tools.yaml` (modify) | The tool declared: `scope: marketing:assets`, `class: auto` |
| Guard | `src/mastra/processors/write-claim-guard.ts` (modify) | The new tool id in `MUTATING_TOOL_IDS` |
| Agent | `src/mastra/agents/creative-designer.ts` (modify) | One sentence on machine-executed prompts |
| Agent | `src/mastra/instructions.ts` (modify) | The section 7.2 paragraph naming the designer artifact contract |
| Registry | `src/mastra/agent.ts` (modify) | Import and registry entry |
| Boot | `src/mastra/index.ts` (modify) | Register the Replicate adapter only when the token is present |
| Config | `src/config/env.ts` (modify) | Four new vars, and the token added to `PRODUCTION_REQUIRED_SECRETS` |
| Data | `src/db/pending-writes.ts` (modify) | `getOpenStageDraft(tenantId, bundleId)`, the section 4.3 predicate |
| Data | `src/db/reviewer-predictions.ts` (new) | One prediction per staged draft, and the gate read both routes share |
| HTTP | `src/api/marketing.ts` (modify) | The prediction POST, the asset bytes GET, and the bundle GET that withholds copy |
| Guard | `src/mastra/workflows/ingest.ts` (modify) | Never embed a `marketing_asset` |
| Console | `console/lib/types.ts` (modify) | `ReviewerPrediction`, `predictionRequired` and `prediction` on the bundle response |
| Console | `console/components/MarketingBundleView.tsx` (modify) | The gate, and the image inline where an `image` artifact now links a bare id |
| Counts | `tests/governance/conformance.test.ts`, `tests/governance/policy.test.ts`, `tests/mastra/active-tools.test.ts`, `docs/TECHNICAL_PLAN.md` (modify) | Every assertion that counts the tool surface, moved in the commit that moves it |
| Tests | `tests/marketing/replicate.test.ts`, `tests/marketing/image-spend.test.ts`, `tests/marketing/asset-prompts.test.ts`, `tests/marketing/generate-assets-tool.test.ts`, `tests/db/marketing-assets.test.ts`, `tests/db/documents-asset-lane.test.ts`, `tests/api/marketing-prediction.test.ts`, `tests/api/marketing-asset-bytes.test.ts`, `tests/integration/marketing-assets-migration.test.ts`, `tests/integration/marketing-generate-assets.test.ts`, `console/tests/MarketingBundleView.test.tsx` (modify) | One file per boundary |

Tasks 1 through 9 are half 4a. Tasks 10 through 13 are half 4b. 4b has no external dependency and 4a costs money, so an executor may run 10 through 13 first and return to 4a when the key is decided — with one deliberate exception the spec names at section 13 and this plan honours: the asset bytes route belongs to 4b, not 4a, because a route whose first act checks `reviewer_predictions` cannot ship before that table has a writer.

## Sub-slice 4a: paying for pixels

### Task 1: Migration 0021 — the widened document lane, the spend ledger, the prediction record

**Files:**
- Create: `migrations/0021_crum_marketing_assets.sql`
- Test: `tests/integration/marketing-assets-migration.test.ts`

**Interfaces:**
- Consumes: nothing. This is the first task of the slice.
- Produces: `documents.kind` admitting `'marketing_asset'`, `documents.source` admitting `'generated'`, partial index `idx_documents_assets`, table `marketing_image_spend (id, tenant_id, document_id NULL, provider, cost_minor, raw_extract, spent_on, created_at)`, table `reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome, created_at)` with `UNIQUE (pending_write_id)` and `ON DELETE CASCADE` to `pending_writes`. Tasks 2, 4, 5, 10 and 12 all read these shapes.

- [ ] **Step 1: Write the failing migration test**

Create `tests/integration/marketing-assets-migration.test.ts`:

```ts
// tests/integration/marketing-assets-migration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
// pending_writes_update_needs_target (0002:163) requires a target_id whenever the
// operation is 'update', and target_id carries no foreign key, so the staged
// drafts below point at this placeholder rather than a real bundle.
const TARGET = '22222222-2222-4222-8222-222222222222'

let pool: Pool

async function unique(prefix: string): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT gen_random_uuid() AS n`,
  )
  return rows[0]!.n.replace(/^(.{4})/, prefix.slice(0, 4) === rows[0]!.n.slice(0, 4) ? '' : '') ?? rows[0]!.n
}

describe.skipIf(!url)('migration 0021: marketing assets, spend and predictions', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('admits a marketing_asset document from a generated source', async () => {
    const id = await unique('a')
    await pool.query(
      `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                              content_text, mime, status, raw_extract)
       VALUES ($1, $2, $3, 'marketing_asset', 'hero-image', 'generated', $4,
               'a prompt', 'image/png', 'needs_review', '{}'::jsonb)`,
      [id, TENANT, OTHER, `hash-${id}`],
    )
    const { rows } = await pool.query<{ kind: string; source: string }>(
      `SELECT kind, source FROM documents WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ kind: 'marketing_asset', source: 'generated' })
    await pool.query(`DELETE FROM documents WHERE id = $1`, [id])
  })

  it('still rejects a kind nobody asked for', async () => {
    const id = await unique('b')
    await expect(
      pool.query(
        `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                                content_text, mime, status, raw_extract)
         VALUES ($1, $2, $3, 'quote', 'x', 'upload', $4, 'y', 'text/plain', 'ready', '{}'::jsonb)`,
        [id, TENANT, OTHER, `hash-${id}`],
      ),
    ).rejects.toThrow(/documents_kind_check/)
  })

  it('leaves an existing invoice row valid under the re-added constraint', async () => {
    const id = await unique('c')
    await pool.query(
      `INSERT INTO documents (id, tenant_id, owner_id, kind, title, source, content_hash,
                              content_text, mime, status, raw_extract)
       VALUES ($1, $2, $3, 'invoice', 'bill', 'upload', $4, 'text', 'application/pdf', 'ready', '{}'::jsonb)`,
      [id, TENANT, OTHER, `hash-${id}`],
    )
    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM documents WHERE id = $1 AND kind = 'invoice'`,
      [id],
    )
    expect(rows).toHaveLength(1)
    await pool.query(`DELETE FROM documents WHERE id = $1`, [id])
  })

  it('creates the partial index over the asset kind only', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'documents' AND indexname = 'idx_documents_assets'`,
    )
    expect(rows).toHaveLength(1)
    // Backticks, not single quotes: the assertion text itself carries single
    // quotes, and the repo's style forbids escaping them into soup.
    expect(rows[0]!.indexdef).toContain(`WHERE (kind = 'marketing_asset'::text)`)
  })

  it('records a spend with no document, because a failed prediction still cost money', async () => {
    const id = await unique('d')
    await pool.query(
      `INSERT INTO marketing_image_spend (id, tenant_id, document_id, provider, cost_minor, raw_extract)
       VALUES ($1, $2, NULL, 'replicate', 4, $3::jsonb)`,
      [id, TENANT, JSON.stringify({ predictionId: 'p1', model: 'flux', costUsd: '0.04' })],
    )
    const { rows } = await pool.query<{
      document_id: string | null
      spent_on: string
      raw_extract: { predictionId: string } | null
    }>(`SELECT document_id, spent_on::text AS spent_on, raw_extract FROM marketing_image_spend WHERE id = $1`, [id])
    expect(rows[0]!.document_id).toBeNull()
    // Read the date as text and compare it to the database's own today. node-pg
    // hands a date column back as a Date object, and CURRENT_DATE is the server's
    // local day — neither of which is the UTC ISO date a JS clock string gives.
    const { rows: todayRows } = await pool.query<{ d: string }>(`SELECT current_date::text AS d`)
    expect(rows[0]!.spent_on).toBe(todayRows[0]!.d)
    // Spec section 9's re-fetch handle: the row that points at no document still
    // names the prediction that cost the money.
    expect(rows[0]!.raw_extract?.predictionId).toBe('p1')
    await pool.query(`DELETE FROM marketing_image_spend WHERE id = $1`, [id])
  })

  it('has no updated_at on the spend ledger: a spend that happened is never edited', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'marketing_image_spend'`,
    )
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'cost_minor',
      'created_at',
      'document_id',
      'id',
      'provider',
      'raw_extract',
      'spent_on',
      'tenant_id',
    ])
  })

  it('rejects a second prediction for one draft, which is the whole device', async () => {
    const draftA = await unique('e')
    const draftB = await unique('f')
    const runId = `pred-test-${Date.now()}`
    for (const id of [draftA, draftB]) {
      await pool.query(
        `INSERT INTO pending_writes (id, tenant_id, run_id, object_type, operation, target_id, payload,
                                     risk_score, gate, draft_hash, requested_by, expires_at)
         VALUES ($1, $2, $3, 'marketing_stage', 'update', $6, '{}'::jsonb, 10, 'approval', $4,
                 $5, now() + interval '1 hour')`,
        [id, TENANT, runId, `pred-hash-${id}`, OTHER, TARGET],
      )
    }
    const prediction = await unique('g')
    await pool.query(
      `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, $3, 'about 6 booked calls a week')`,
      [prediction, TENANT, draftA],
    )
    await expect(
      pool.query(
        `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, $3, 'no idea')`,
        [await unique('h'), TENANT, draftA],
      ),
    ).rejects.toThrow(/uq_prediction_draft/)

    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM reviewer_predictions WHERE pending_write_id = $1`,
      [draftA],
    )
    expect(rows).toHaveLength(1)
    await pool.query(`DELETE FROM pending_writes WHERE id = ANY($1::uuid[])`, [[draftA, draftB]])
  })

  it('drops a prediction when its draft goes, so a re-staged bundle starts clean', async () => {
    const draft = await unique('i')
    const prediction = await unique('j')
    await pool.query(
      `INSERT INTO pending_writes (id, tenant_id, run_id, object_type, operation, target_id, payload,
                                   risk_score, gate, draft_hash, requested_by, expires_at)
       VALUES ($1, $2, 'cascade-test', 'marketing_stage', 'update', $5, '{}'::jsonb, 10, 'approval', $3,
               $4, now() + interval '1 hour')`,
      [draft, TENANT, `cascade-hash-${draft}`, OTHER, TARGET],
    )
    await pool.query(
      `INSERT INTO reviewer_predictions (id, tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, $3, 'eleven calls')`,
      [prediction, TENANT, draft],
    )
    await pool.query(`DELETE FROM pending_writes WHERE id = $1`, [draft])
    const { rows } = await pool.query<{ n: string }>(
      `SELECT id FROM reviewer_predictions WHERE id = $1`,
      [prediction],
    )
    expect(rows).toHaveLength(0)
  })
})
```

The `unique` helper exists because this file shares a database with every other migration test and `documents.id` is a uuid primary key. Keep it simple and honest:

```ts
async function unique(): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(`SELECT gen_random_uuid() AS n`)
  return rows[0]!.n
}
```

Replace the version above that takes a prefix with this one, and call `await unique()` at each site. (Stated plainly so nobody ships the awkward first draft.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project integration tests/integration/marketing-assets-migration.test.ts`
Expected: FAIL with `documents_kind_check` still rejecting `marketing_asset`, or `relation "marketing_image_spend" does not exist`. If the run reports `skipped`, `CRUM_INTEGRATION_DATABASE_URL` is unset — export it (see the Integration cluster) and re-run. A skipped run is not a pass.

- [ ] **Step 3: Write the migration**

Create `migrations/0021_crum_marketing_assets.sql`:

```sql
-- migrations/0021_crum_marketing_assets.sql
-- Slice 4 stores a generated marketing image as a document, records what each
-- image cost, and keeps one written prediction per staged approval. See
-- docs/superpowers/specs/2026-11-01-marketing-team-slice-4-design.md sections
-- 4.1 to 4.3. The headline is what this migration does NOT do: it adds no byte
-- column, because migrations/0011 already built the byte lane (document_files)
-- and a second place to put bytes on one entity is two sources of truth about
-- whether a document has a file.

-- 1. documents gains a kind and a source for generated assets. DROP/ADD is the
-- house style for widening a CHECK (0015, 0018, 0019 all do it): an in-place
-- rename would leave the old list in place.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('invoice', 'contract', 'other', 'marketing_asset'));

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('upload', 'email', 'generated'));

-- The asset list is read by kind, and only by kind; a partial index keeps the
-- CRM's invoice and contract rows out of it entirely.
CREATE INDEX IF NOT EXISTS idx_documents_assets
  ON documents (tenant_id, kind, status)
  WHERE kind = 'marketing_asset';

-- 2. The daily spend ceiling needs a number to compare against, so it needs a
-- ledger. Append-only and with no updated_at, for the same reason audit_receipts
-- has neither: a spend that happened is never edited.
CREATE TABLE IF NOT EXISTS marketing_image_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- Nullable on purpose. A prediction that produced no usable bytes still cost
  -- money, and an invoice we cannot attribute to a document is the truth rather
  -- than a gap in the arithmetic.
  document_id uuid,
  provider text NOT NULL,
  cost_minor integer NOT NULL,
  -- The prediction handle, kept even when there are no bytes to point at. Spec
  -- section 9's row "bytes download fails after a successful prediction" says the
  -- owner can re-fetch from Replicate within its expiry window, and that is only
  -- true if the row says *which* prediction. Nothing reads it back automatically.
  raw_extract jsonb,
  spent_on date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_image_spend_cost_non_negative CHECK (cost_minor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_marketing_image_spend_tenant_day
  ON marketing_image_spend (tenant_id, spent_on);

-- 3. The forcing record. One row per staged draft, forever: the unique
-- constraint is what makes "type it before you look" a fact about the database
-- rather than an instruction on a screen. pending_write_id rather than
-- bundle_id, so a re-staged bundle is a fresh prediction.
CREATE TABLE IF NOT EXISTS reviewer_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pending_write_id uuid NOT NULL REFERENCES pending_writes(id) ON DELETE CASCADE,
  predicted_outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prediction_draft UNIQUE (pending_write_id)
);
```

- [ ] **Step 4: Apply and re-run**

Run: `npm run db:migrate` against the integration database (`DATABASE_URL=$CRUM_INTEGRATION_DATABASE_URL npm run db:migrate`), then `npx vitest run --project integration tests/integration/marketing-assets-migration.test.ts`
Expected: PASS, all eight cases. Confirm `crum_schema_migrations` now holds version `0021` with a checksum; the runner records it, no task edits that table by hand.

- [ ] **Step 5: Commit**

```bash
git add migrations/0021_crum_marketing_assets.sql tests/integration/marketing-assets-migration.test.ts
git commit -m "feat(marketing): add migration 0021 for asset documents, image spend and reviewer predictions"
```

---

### Task 2: `documents.ts` — widen both unions, hoist the byte write, keep assets out of the CRM list

**Files:**
- Modify: `src/db/documents.ts` (`DocumentRow` at 5-20, `PersistDocumentInput` at 159-181, the guard at 278-289, `listDocuments` at 364-402)
- Modify: `src/mastra/tools/documents.ts` (`DocumentSummarySchema.kind`, one enum arm) — `listDocuments` types its result as `DocumentRow`, so widening that union makes the tool's output schema refuse to compile until the arm is added. No task owns this file; the commit that breaks the build owns the fix.
- Test: `tests/db/documents-asset-lane.test.ts`

**Interfaces:**
- Consumes: migration 0021's widened CHECK constraints.
- Produces: `PersistDocumentInput.kind` accepting `'marketing_asset'`, `PersistDocumentInput.source` accepting `'generated'`, `DocumentRow.kind`/`DocumentRow.source` widened to match, and the guarantee that `insertDocument` writes `document_files` whenever a new row carries `file`, parse record or not. Task 5's `insertAssetDocument` and Task 6's tool both depend on that guarantee; spec section 4.1 names the missing guard as "the failure this whole slice exists to avoid".

- [ ] **Step 1: Write the failing tests**

Create `tests/db/documents-asset-lane.test.ts`. This is a unit test, so `pg` is mocked the way `tests/db/marketing.test.ts:1-30` mocks it — but `insertDocument` opens a transaction on a checked-out client, so the mock has to hand out a client:

```ts
// tests/db/documents-asset-lane.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
// One mock function for both doors, the way tests/db/marketing.test.ts:3 does
// it: queryRows goes through pool.query and insertDocument goes through
// client.query, so a separate mock for each records only half the calls.
// `() => Promise.resolve(mockClient)` rather than `async () => mockClient`:
// `@typescript-eslint/require-await` is an error in this repo and a checked-out
// client mock has nothing to await.
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const DOC = '99999999-9999-4999-8999-999999999999'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/documents')
}

/**
 * insertDocument's RETURNING row decides everything downstream: is_new gates the
 * file write, so a test that wants the byte lane exercised has to answer with a
 * fresh row.
 */
function answerDocumentInsert(over: { id?: string; is_new?: boolean } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if ((sql as string).includes('INSERT INTO documents')) {
      return {
        rows: [
          {
            id: over.id ?? DOC,
            status: 'needs_review',
            confidence: null,
            is_new: over.is_new ?? true,
          },
        ],
      }
    }
    return { rows: [] }
  })
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('a generated image as a document', () => {
  it('writes the byte lane for a document that has bytes and no parse run', async () => {
    answerDocumentInsert()
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'marketing_asset',
      title: 'hero-image',
      source: 'generated',
      sourceRef: null,
      contentHash: 'a'.repeat(64),
      contentText: 'a photorealistic clinic reception',
      mime: 'image/png',
      status: 'needs_review',
      confidence: null,
      customerId: null,
      rawExtract: { model: 'black-forest-labs/flux-1.1-pro' },
      file: { mime: 'image/png', sizeBytes: 4, data: new Uint8Array([1, 2, 3, 4]) },
      parse: null,
      blocks: undefined,
    })
    const fileWrites = calls('INSERT INTO document_files')
    expect(fileWrites).toHaveLength(1)
    expect(fileWrites[0]!.params).toEqual([DOC, TENANT, 'image/png', 4, expect.any(Uint8Array)])
  })

  it('still writes parse artifacts for an upload that has both', async () => {
    answerDocumentInsert()
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'invoice',
      title: 'bill',
      source: 'upload',
      sourceRef: null,
      contentHash: 'b'.repeat(64),
      contentText: 'text',
      mime: 'application/pdf',
      status: 'ready',
      confidence: 0.9,
      customerId: null,
      rawExtract: {},
      file: { mime: 'application/pdf', sizeBytes: 2, data: new Uint8Array([1, 2]) },
      parse: { parser: 'unpdf', parserVersion: '1', status: 'ok', durationMs: 5, meta: {} },
      blocks: [],
    })
    expect(calls('INSERT INTO document_files')).toHaveLength(1)
    expect(calls('INSERT INTO document_parses')).toHaveLength(1)
  })

  it('does not write the byte lane a second time for a duplicate hash', async () => {
    answerDocumentInsert({ is_new: false })
    const { insertDocument } = await load()
    await insertDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      kind: 'marketing_asset',
      title: 'hero-image',
      source: 'generated',
      sourceRef: null,
      contentHash: 'a'.repeat(64),
      contentText: 'a photorealistic clinic reception',
      mime: 'image/png',
      status: 'needs_review',
      confidence: null,
      customerId: null,
      rawExtract: {},
      file: { mime: 'image/png', sizeBytes: 4, data: new Uint8Array([1, 2, 3, 4]) },
      parse: null,
    })
    expect(calls('INSERT INTO document_files')).toHaveLength(0)
  })
})

describe('listDocuments', () => {
  it('excludes generated assets when the caller named no kind', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments({ tenantId: TENANT, userId: OWNER, userRole: 'admin' })
    const [call] = calls('FROM documents d')
    expect(call!.sql).toContain("d.kind <> 'marketing_asset'")
  })

  it('returns assets when a kind filter asks for exactly them', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listDocuments } = await load()
    await listDocuments({ tenantId: TENANT, userId: OWNER, userRole: 'admin' }, {
      kind: 'marketing_asset',
    })
    const [call] = calls('FROM documents d')
    expect(call!.sql).not.toContain("d.kind <> 'marketing_asset'")
    expect(call!.params).toContain('marketing_asset')
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/db/documents-asset-lane.test.ts`
Expected: FAIL, and name which cases fail rather than forcing the others to. Vitest strips types without checking them, so the widened unions are not a red assertion — `npm run typecheck` at Step 5 is what proves them. The behavioural RED is: the first case fails `expected 0 to be 1` from `calls('INSERT INTO document_files')`, which is spec section 4.1's silent byte loss reproduced as a test, and the exclusion case fails because no `d.kind <> 'marketing_asset'` exists yet. Three cases pass in RED and must pass in GREEN: today's code already writes both lanes for an upload that has a parse run, already writes nothing for a duplicate hash, and already filters by an exact `kind` — the `kind` case exercises the pre-existing `=` branch, not this task's change.

- [ ] **Step 3: Widen the two unions and hoist the guard**

In `src/db/documents.ts`, `DocumentRow` lines 9 and 11 (the spec names only `PersistDocumentInput`; the row type repeats both unions, so widening one alone leaves `listDocuments` returning a type that cannot hold the row the database now admits):

```ts
export interface DocumentRow {
  id: string
  tenant_id: string
  owner_id: string
  kind: 'invoice' | 'contract' | 'other' | 'marketing_asset'
  title: string
  source: 'upload' | 'email' | 'generated'
```

`PersistDocumentInput` lines 162 and 164:

```ts
  kind: 'invoice' | 'contract' | 'other' | 'marketing_asset'
  title: string
  source: 'upload' | 'email' | 'generated'
```

The guard at 278-289. Replace the outer `if (row.is_new && input.parse)` and the nested `if (input.file)` with two sibling branches under one freshness check, keeping the existing SQL for `document_files`, `document_parses` and the block loop byte-for-byte:

```ts
    // Scan artifacts (0011) belong to the document that FIRST claimed this
    // content hash. A duplicate upload only bumps updated_at above and must not
    // duplicate or overwrite the existing file/parse/blocks.
    //
    // The file write is a sibling of the parse write, not a child of it. A
    // generated image carries bytes and no parse run, because nothing was
    // extracted from it, so nesting the byte lane under `input.parse` stored the
    // metadata row and dropped the bytes — spec section 4.1's named failure.
    if (row.is_new && (input.file || input.parse)) {
      if (input.file) {
        await client.query(
          `INSERT INTO document_files (document_id, tenant_id, mime, size_bytes, data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (document_id) DO NOTHING`,
          [row.id, input.tenantId, input.file.mime, input.file.sizeBytes, input.file.data],
        )
      }
      if (input.parse) {
        // ...the existing document_parses insert and the existing blocks loop,
        // unchanged, moved down one level of nesting.
      }
    }
```

The `if (input.parse)` wrapper is new; everything inside it is the code that is already there (`src/db/documents.ts:290-330`, up to and including the block insert loop). Do not retype the SQL — wrap it.

In `listDocuments` (364-402), the kind branch gains its `else`:

```ts
  if (filters.kind) {
    idx++
    conditions.push(`d.kind = $${idx}`)
    params.push(filters.kind)
  } else {
    // A generated hero image is not a business document. Without this line every
    // asset pass drops its output between the owner's invoices in the CRM
    // document list, which reads as a bug to whoever is hunting for a bill.
    conditions.push(`d.kind <> 'marketing_asset'`)
  }
```

- [ ] **Step 4: Run the tests, then the existing document suites**

Run: `npx vitest run tests/db/documents-asset-lane.test.ts tests/api/documents.test.ts tests/mastra/workflows/document-intake.test.ts`
Expected: PASS on all three files. `tests/api/documents.test.ts`'s router suite proves the widened unions broke no caller; if it fails, the cause is a caller that switched exhaustively on `kind` and now needs the new arm.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/db/documents.ts src/mastra/tools/documents.ts tests/db/documents-asset-lane.test.ts
git commit -m "fix(db): store generated image bytes and keep marketing assets out of the CRM document list"
```

---

### Task 3: The Replicate adapter — create, poll, download

**Files:**
- Create: `src/marketing/replicate.ts`
- Test: `tests/marketing/replicate.test.ts`

**Interfaces:**
- Consumes: nothing but `fetch`.
- Produces:

```ts
export const REPLICATE_API_BASE = 'https://api.replicate.com/v1'
export const DEFAULT_REPLICATE_MODEL = 'black-forest-labs/flux-1.1-pro'
export const ASPECT_RATIOS: readonly string[]
export function isAspectRatio(value: string): boolean
export const MAX_PROMPT_CHARS = 2000
export type ImageFailureCode =
  | 'prompt_too_long' | 'unsupported_aspect_ratio' | 'image_generation_failed'
  | 'image_generation_timeout' | 'asset_too_large'
export interface ImageRequest { prompt: string; aspectRatio: string; seed: number; negativePrompt?: string | null }
export interface ImageCharge { predictionId: string; costUsd: string; costMinor: number }
export interface GeneratedImage extends ImageCharge { mime: 'image/png'; bytes: Uint8Array; sizeBytes: number; model: string; aspectRatio: string }
export type ImageOutcome =
  | ({ ok: true } & { image: GeneratedImage })
  | ({ ok: false; code: ImageFailureCode; detail: string; charge: ImageCharge | null; deadToken: boolean })
export interface ReplicateConfig {
  apiToken: string
  model?: string
  maxBytes: number
  fetchImpl?: typeof fetch
  pollAttempts?: number
  pollIntervalMs?: number
  rateLimitRetryMs?: number
  sleep?: (ms: number) => Promise<void>
}
export function costUsdToMinor(costUsd: string): number
export async function generateImage(request: ImageRequest, config: ReplicateConfig): Promise<ImageOutcome>
```

Task 6's tool calls `generateImage` and treats `charge` on a failure as money that must still be recorded (spec section 9 rows 4 and 6).

- [ ] **Step 1: Write the failing tests**

Create `tests/marketing/replicate.test.ts`. Injected `fetchImpl`, injected `sleep`, and a `Response` double — the suite is a unit test and must never touch the network:

```ts
// tests/marketing/replicate.test.ts
import { describe, expect, it, vi } from 'vitest'
import {
  ASPECT_RATIOS,
  MAX_PROMPT_CHARS,
  costUsdToMinor,
  generateImage,
  isAspectRatio,
  type ReplicateConfig,
} from '../../src/marketing/replicate'

const TOKEN = 'r8_test_token_not_real'
const BYTES = new Uint8Array([137, 80, 78, 71])
const REQUEST = { prompt: 'a physio clinic reception at dawn', aspectRatio: '16:9', seed: 4217 }

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // The adapter reads text on a refused create, so a double without it throws
    // a TypeError instead of reporting the status it should have refused on.
    // Use `as unknown as Response` here if the direct assertion complains.
    text: async () => JSON.stringify(body),
  } as Response
}

function succeeded(predictionId = 'pred-1') {
  return json(200, {
    id: predictionId,
    status: 'succeeded',
    model: 'black-forest-labs/flux-1.1-pro',
    output: `https://replicate.delivery/${predictionId}.png`,
    urls: { get: `https://replicate.delivery/${predictionId}.png` },
    cost: '0.04',
    error: null,
  })
}

function config(responses: Response[]): ReplicateConfig {
  const fetchImpl = vi.fn(async () => responses.shift() ?? json(500, { detail: 'ran out' }))
  return {
    apiToken: TOKEN,
    maxBytes: 15 * 1024 * 1024,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
  }
}

function bytes() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => BYTES.buffer.slice(0),
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
  } as unknown as Response
}

describe('generateImage', () => {
  it('creates a prediction, polls it, and downloads the bytes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'pred-9', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('pred-9'))
      .mockResolvedValueOnce(bytes())
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 15 * 1024 * 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.image.predictionId).toBe('pred-9')
    expect(outcome.image.costMinor).toBe(4)
    expect(outcome.image.bytes).toEqual(BYTES)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [create] = fetchImpl.mock.calls as unknown[][]
    expect(create[0]).toBe('https://api.replicate.com/v1/predictions')
    expect((create[1] as RequestInit).method ?? 'POST').toMatch(/POST/)
    const headers = (create[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe(`Token ${TOKEN}`)
  })

  it('sends only the fields the model takes, and never a negative prompt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce(bytes())
    await generateImage(
      { ...REQUEST, negativePrompt: 'no text, no watermark' },
      {
        apiToken: TOKEN,
        maxBytes: 15 * 1024 * 1024,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      },
    )
    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body as string)
    expect(body).toEqual({
      model: 'black-forest-labs/flux-1.1-pro',
      input: {
        prompt: REQUEST.prompt,
        aspect_ratio: '16:9',
        output_format: 'png',
        seed: 4217,
      },
    })
    expect(JSON.stringify(body)).not.toContain('watermark')
  })

  it('refuses a prompt Replicate would silently truncate', async () => {
    const fetchImpl = vi.fn()
    const outcome = await generateImage(
      { ...REQUEST, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
      {
        apiToken: TOKEN,
        maxBytes: 1024,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('prompt_too_long')
    expect(outcome.charge).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses an aspect ratio the model does not take, naming the set that works', async () => {
    const outcome = await generateImage(
      { ...REQUEST, aspectRatio: '5:4' },
      config([json(201, { id: 'p', status: 'starting' })]),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('unsupported_aspect_ratio')
    expect(outcome.detail).toContain(ASPECT_RATIOS.join(', '))
    expect(isAspectRatio('9:16')).toBe(true)
    expect(isAspectRatio('5:4')).toBe(false)
  })

  it('carries Replicate error text out of a failed prediction, with the charge it still cost', async () => {
    const failed = json(200, {
      id: 'pred-f',
      status: 'failed',
      output: null,
      error: 'Input content is flagged',
      logs: '',
    })
    const outcome = await generateImage(REQUEST, config([json(201, { id: 'pred-f', status: 'starting' }), failed]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_failed')
    expect(outcome.detail).toContain('Input content is flagged')
    expect(outcome.charge).toBeNull()
  })

  it('gives up after the poll budget rather than hanging the turn', async () => {
    const responses: Response[] = [json(201, { id: 'p', status: 'starting' })]
    for (let i = 0; i < 20; i++) responses.push(json(200, { id: 'p', status: 'processing' }))
    const sleep = vi.fn(async () => {})
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => responses.shift() ?? json(500, {})) as unknown as typeof fetch,
      sleep,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_timeout')
    // 20 polls and no 21st, with a 2 second gap between each — 19 gaps, because
    // the loop does not wait once it has decided to give up. That is the 40
    // second ceiling on a turn, and it is sleep plus twenty request latencies.
    expect(sleep).toHaveBeenCalledTimes(19)
  })

  it('stops the run at a revoked token instead of burning 20 more calls on it', async () => {
    const outcome = await generateImage(REQUEST, config([json(401, { detail: 'Invalid token' })]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.deadToken).toBe(true)
    expect(outcome.code).toBe('image_generation_failed')
  })

  it('retries a rate limit once and then reports that asset as failed', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { detail: 'Too many requests' }))
      .mockResolvedValueOnce(json(429, { detail: 'Too many requests' }))
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(outcome.detail).toContain('rate')
  })

  it('refuses an over-large image after the download, with the spend kept on the failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(10).buffer,
        headers: { get: () => null },
      } as unknown as Response)
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('asset_too_large')
    // Replicate already billed the prediction, so the money travels with the
    // refusal instead of being lost with the bytes (spec section 9).
    expect(outcome.charge).toEqual({ predictionId: 'p', costUsd: '0.04', costMinor: 4 })
  })

  it('refuses a prediction whose cost field is absent rather than estimating the ledger', async () => {
    const noCost = json(200, { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/p.png', cost: null })
    const outcome = await generateImage(REQUEST, config([json(201, { id: 'p', status: 'starting' }), noCost, bytes()]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_failed')
    expect(outcome.detail).toContain('cost')
  })

  it('records a spend with no document when the download dies after a good prediction', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce(json(403, { detail: 'gone' }))
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.charge).toEqual({ predictionId: 'p', costUsd: '0.04', costMinor: 4 })
    expect(outcome.detail).toContain('download')
  })
})

describe('costUsdToMinor', () => {
  it('reads a decimal dollar string as cents', () => {
    expect(costUsdToMinor('0.04')).toBe(4)
    expect(costUsdToMinor('0.005')).toBe(1)
    expect(costUsdToMinor('1')).toBe(100)
    expect(costUsdToMinor('0.004')).toBe(0)
    expect(() => costUsdToMinor('0.0.1')).toThrow(/cost/)
  })
})
```

Note `costUsdToMinor('0.005') === 1`: rounding, not truncation, because a systematic truncation under-reads the ledger every single image and the ceiling then means less than it says. `'0.004'` rounds to `0` and a zero-cost row is honest arithmetic — it cannot overstate spend, and the check `cost_minor >= 0` admits it.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/marketing/replicate.test.ts`
Expected: FAIL with `Cannot find module '../../src/marketing/replicate'`.

- [ ] **Step 3: Write the adapter**

Create `src/marketing/replicate.ts`:

```ts
// src/marketing/replicate.ts
// Slice 4's only provider. Two calls per image, create then poll, then a third
// to fetch the bytes before the delivery URL expires (spec section 5.2). Hand-
// written fetch like every other adapter in this repo: the official SDK is a
// browser library and this runs on a server.
//
// fetchImpl and sleep are injected on both lanes, which is what makes every test
// in this slice a mock. No automated test reaches Replicate.

export const REPLICATE_API_BASE = 'https://api.replicate.com/v1'
export const DEFAULT_REPLICATE_MODEL = 'black-forest-labs/flux-1.1-pro'

// The set FLUX 1.1 Pro actually takes, held as a constant rather than re-derived,
// and named in the designer's instructions so a plan written for a vertical story
// ad and an asset pass that refuses to render it cannot coexist (spec 5.1).
export const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

export const MAX_PROMPT_CHARS = 2000

// 20 attempts at 2 seconds is a 40 second ceiling per image. A hung request is
// not an option inside an agent turn.
const DEFAULT_POLL_ATTEMPTS = 20
const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_RATE_LIMIT_RETRY_MS = 5000

export type ImageFailureCode =
  | 'prompt_too_long'
  | 'unsupported_aspect_ratio'
  | 'image_generation_failed'
  | 'image_generation_timeout'
  | 'asset_too_large'

export interface ImageRequest {
  prompt: string
  aspectRatio: string
  seed: number
  // Accepted and never sent: FLUX 1.1 Pro has no negative prompt input, and an
  // unknown field is how an adapter starts returning 400s nobody predicted. The
  // caller stores it in documents.raw_extract for a future model that takes one.
  negativePrompt?: string | null
}

export interface ImageCharge {
  predictionId: string
  costUsd: string
  costMinor: number
}

export interface GeneratedImage extends ImageCharge {
  model: string
  aspectRatio: string
  mime: 'image/png'
  bytes: Uint8Array
  sizeBytes: number
}

export type ImageOutcome =
  | { ok: true; image: GeneratedImage }
  | {
      ok: false
      code: ImageFailureCode
      detail: string
      // Money already spent on a prediction that produced nothing usable. The
      // ledger records it; only a run that never asked for a prediction is null.
      charge: ImageCharge | null
      // True on a 401: the caller stops the whole loop rather than making forty
      // more calls against a dead token (spec section 9).
      deadToken: boolean
    }

export interface ReplicateConfig {
  apiToken: string
  model?: string
  // MAX_DOCUMENT_BYTES, passed in by the caller so this module does not import a
  // Mastra workflow file to learn how big a stored document may be.
  maxBytes: number
  fetchImpl?: typeof fetch
  pollAttempts?: number
  pollIntervalMs?: number
  rateLimitRetryMs?: number
  sleep?: (ms: number) => Promise<void>
}

export function isAspectRatio(value: string): boolean {
  return (ASPECT_RATIOS as readonly string[]).includes(value)
}

/**
 * Replicate reports `cost` as a decimal USD string. Minor units here are cents,
 * the same unit CRUM_IMAGE_SPEND_CEILING_MINOR is written in, so the ledger and
 * the ceiling are one number line. Rounded, not floored: a systematic floor
 * under-reads every image and the ceiling then quietly means less than it says.
 */
export function costUsdToMinor(costUsd: string): number {
  // `parseFloat` stops at a second dot, so "0.0.1" parses as 0 and would
  // otherwise enter the ledger as a free image. Shape first, then value.
  if (!/^\d+(\.\d+)?$/.test(costUsd)) {
    throw new Error(`cost: "${costUsd}" is not a dollar amount Replicate should have reported`)
  }
  const dollars = Number.parseFloat(costUsd)
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`cost: "${costUsd}" is not a dollar amount Replicate should have reported`)
  }
  return Math.round(dollars * 100)
}

interface PredictionResponse {
  id?: string
  status?: string
  model?: string
  output?: string | string[] | null
  error?: string | null
  logs?: string
  cost?: string | number | null
  urls?: { get?: string }
}

function failure(
  code: ImageFailureCode,
  detail: string,
  charge: ImageCharge | null = null,
  deadToken = false,
): ImageOutcome {
  return { ok: false, code, detail, charge, deadToken }
}

/**
 * The charge for a cost Replicate reported, or null when it reported none or
 * reported something that is not a dollar amount. Section 5.4 forbids estimating
 * a ledger entry, so an unreadable cost is simply no charge rather than a guess.
 */
function chargeFromCost(
  predictionId: string,
  cost: string | number | null | undefined,
): ImageCharge | null {
  if (cost === null || cost === undefined || cost === '') return null
  const costUsd = String(cost)
  try {
    return { predictionId, costUsd, costMinor: costUsdToMinor(costUsd) }
  } catch {
    return null
  }
}

function firstUrl(prediction: PredictionResponse): string | null {
  const output = prediction.output
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const first = output.find((entry) => typeof entry === 'string')
    return typeof first === 'string' ? first : null
  }
  return null
}

export async function generateImage(request: ImageRequest, config: ReplicateConfig): Promise<ImageOutcome> {
  const fetchImpl = config.fetchImpl ?? fetch
  const model = config.model ?? DEFAULT_REPLICATE_MODEL
  const attempts = config.pollAttempts ?? DEFAULT_POLL_ATTEMPTS
  const intervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const retryMs = config.rateLimitRetryMs ?? DEFAULT_RATE_LIMIT_RETRY_MS
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const headers = {
    Authorization: `Token ${config.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  // Built once, sent twice: the rate-limit retry must be the identical request,
  // because a re-typed body makes the retry a different prediction.
  const createInit = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: {
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio,
        output_format: 'png',
        seed: request.seed,
      },
    }),
  }

  if (request.prompt.length > MAX_PROMPT_CHARS) {
    return failure(
      'prompt_too_long',
      `prompt is ${request.prompt.length} characters; Replicate truncates silently above ${MAX_PROMPT_CHARS} and a truncated prompt is a different image`,
    )
  }
  if (!isAspectRatio(request.aspectRatio)) {
    return failure('unsupported_aspect_ratio', `aspect ratio "${request.aspectRatio}" is not one of ${ASPECT_RATIOS.join(', ')}`)
  }

  // 1. Create. A 429 is retried once here and nowhere else, because the create
  // call is the only one that spends money; a retry on a poll is a free question.
  // Every transport throw on every lane resolves to a refusal: an adapter does
  // not hand its caller a rejection to catch.
  let created: Response
  try {
    created = await fetchImpl(`${REPLICATE_API_BASE}/predictions`, createInit)
  } catch (err) {
    return failure('image_generation_failed', `could not reach Replicate: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (created.status === 401) return failure('image_generation_failed', 'replicate rejected the api token (401)', null, true)
  if (created.status === 429) {
    await sleep(retryMs)
    try {
      created = await fetchImpl(`${REPLICATE_API_BASE}/predictions`, createInit)
    } catch (err) {
      return failure('image_generation_failed', `could not reach Replicate on the rate-limit retry: ${err instanceof Error ? err.message : String(err)}`)
    }
    // A 401 after a 429 is still a dead token, and the loop-stop signal must not
    // depend on which status Replicate happened to answer with first.
    if (created.status === 401) return failure('image_generation_failed', 'replicate revoked the token on the retry (401)', null, true)
    if (created.status === 429) {
      return failure('image_generation_failed', 'replicate rate limited this asset after one retry (429)')
    }
  }
  if (!created.ok) {
    const text = await created.text().catch(() => '')
    return failure('image_generation_failed', `replicate refused the prediction (${created.status}) ${text.slice(0, 200)}`)
  }

  const start = (await created.json().catch(() => null)) as PredictionResponse | null
  const predictionId = start?.id
  if (!predictionId) return failure('image_generation_failed', 'replicate answered without a prediction id')

  // 2. Poll until succeeded, failed, or the budget runs out.
  let prediction: PredictionResponse | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    let polled: Response
    try {
      polled = await fetchImpl(`${REPLICATE_API_BASE}/predictions/${encodeURIComponent(predictionId)}`, {
        method: 'GET',
        headers,
      })
    } catch (err) {
      // A poll that cannot reach Replicate is still a refusal, not a rejection.
      // No cost was ever learned, so there is nothing honest to put in `charge`.
      return failure(
        'image_generation_failed',
        `could not reach Replicate while polling ${predictionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (polled.status === 401) {
      return failure('image_generation_failed', 'replicate revoked the token mid-run (401)', null, true)
    }
    prediction = polled.ok ? ((await polled.json().catch(() => null)) as PredictionResponse | null) : null
    if (prediction?.status === 'succeeded' || prediction?.status === 'failed') break
    if (attempt < attempts - 1) await sleep(intervalMs)
  }

  if (prediction?.status === 'failed') {
    // A failed prediction can still carry the cost of the GPU minutes it ran, and
    // spec section 9 says the ledger keeps what was actually paid. Read it when it
    // is there; a failure that reported no cost is not a licence to invent one.
    return failure(
      'image_generation_failed',
      prediction.error ? String(prediction.error) : 'replicate reported a failure with no error text',
      chargeFromCost(predictionId, prediction.cost),
    )
  }
  if (prediction?.status !== 'succeeded') {
    return failure('image_generation_timeout', `prediction ${predictionId} was still ${prediction?.status ?? 'unreadable'} after ${attempts} polls`)
  }

  // 3. Cost first, then bytes. A response with no cost is refused rather than
  // estimated, because an estimated ledger is how a ceiling drifts from reality
  // without anyone noticing (spec section 5.4).
  const costUsd = typeof prediction.cost === 'string' || typeof prediction.cost === 'number' ? String(prediction.cost) : ''
  if (costUsd === '') {
    return failure('image_generation_failed', `prediction ${predictionId} reported no cost, and an unreported cost cannot go in the ledger`)
  }
  let costMinor: number
  try {
    costMinor = costUsdToMinor(costUsd)
  } catch (err) {
    return failure('image_generation_failed', err instanceof Error ? err.message : String(err))
  }
  const charge: ImageCharge = { predictionId, costUsd, costMinor }

  const url = firstUrl(prediction)
  if (url === null) {
    return failure('image_generation_failed', `prediction ${predictionId} succeeded with no output url`, charge)
  }

  let downloaded: Response
  try {
    downloaded = await fetchImpl(url)
  } catch (err) {
    return failure('image_generation_failed', `download of ${predictionId} output failed: ${err instanceof Error ? err.message : String(err)}`, charge)
  }
  if (!downloaded.ok) {
    return failure('image_generation_failed', `download of prediction ${predictionId} output failed (http ${downloaded.status})`, charge)
  }

  // The bytes are read under the same rule as the call: a delivery that throws
  // mid-body is a refusal that still carries the charge.
  let buffer: ArrayBuffer
  try {
    buffer = await downloaded.arrayBuffer()
  } catch (err) {
    return failure(
      'image_generation_failed',
      `download of prediction ${predictionId} output failed: ${err instanceof Error ? err.message : String(err)}`,
      charge,
    )
  }
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength > config.maxBytes) {
    return failure('asset_too_large', `${bytes.byteLength} bytes exceeds the ${config.maxBytes} byte document ceiling`, charge)
  }
  if (bytes.byteLength === 0) {
    return failure('image_generation_failed', `prediction ${predictionId} delivered zero bytes`, charge)
  }

  return {
    ok: true,
    image: {
      predictionId,
      costUsd,
      costMinor,
      model: prediction.model ?? model,
      aspectRatio: request.aspectRatio,
      mime: 'image/png',
      bytes,
      sizeBytes: bytes.byteLength,
    },
  }
}
```

Two honest notes for the implementer. The `429` retry reuses `createInit`, the one request object built before the first call — a retry that re-types the body is a different prediction, and the whole point of the retry is to ask for the same image again after a wait. And `pollAttempts`/`pollIntervalMs` stay configurable so the timeout test can assert the budget without waiting 40 seconds; the loop sleeps between polls, so 20 polls cost 19 gaps.

Every transport throw resolves. The create, the retry, every poll and the `arrayBuffer()` read are each inside a `try`, because `generateImage`'s contract is `Promise<ImageOutcome>` and a rejection escaping an adapter is a bug the adapter owns, not a problem for the tool layer to catch. Four cases in the test file hold that contract, one per lane, and the download case must still carry the `charge` — a body that dies half-read is money spent.

Six cases the review added, beyond the twelve listed above: `resolves when Replicate cannot be reached at all`, `resolves when the rate-limit retry cannot reach Replicate`, `resolves when a poll cannot reach Replicate` (which must keep `charge: null`, because nothing was ever read), `carries the charge when the delivery dies mid-body`, `keeps the money a failed prediction actually cost` (a `status: 'failed'` response reporting `'0.02'` must hand back `{ predictionId, costUsd: '0.02', costMinor: 2 }`), and `still calls a dead token dead when the 401 arrives after a 429`. The first case also asserts the poll URL carries the prediction id, and the 429 case asserts `sleep` received `5000`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/marketing/replicate.test.ts`
Expected: PASS on all eighteen cases (the twelve drafted above plus the six the review named). Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/marketing/replicate.ts tests/marketing/replicate.test.ts
git commit -m "feat(marketing): add the Replicate image adapter with an injected fetch and a poll budget"
```

---

### Task 4: The spend ledger — ceiling arithmetic and one append-only table

**Files:**
- Create: `src/marketing/image-spend.ts`
- Test: `tests/marketing/image-spend.test.ts`
- Test: `tests/integration/marketing-image-spend.test.ts`

The unit file owns the arithmetic; the integration file owns the two SQL lanes,
because a mocked `pg` cannot prove `SUM(cost_minor)` really arrives as a string,
that the untyped `$5` reaches a jsonb column, or that `DEFAULT CURRENT_DATE`
stamps the day the read then compares against.

**Interfaces:**
- Consumes: `marketing_image_spend` from Task 1.
- Produces:

```ts
export const REPLICATE_PROVIDER = 'replicate'
export function headroomMinor(params: { ceilingMinor: number; committedMinor: number }): number
export function admitsRun(params: {
  ceilingMinor: number
  committedMinor: number
  costMinorPerImage: number
  assetCount: number
}): boolean
export async function committedSpendMinor(tenantId: string): Promise<number>
export interface SpendRawExtract {
  predictionId: string
  model: string
  costUsd: string
}
export async function recordImageSpend(params: {
  tenantId: string
  documentId: string | null
  costMinor: number
  provider?: string
  rawExtract?: SpendRawExtract | null
}): Promise<string>
```

Task 6's tool calls `committedSpendMinor` twice (once before the run, once before each asset), `admitsRun` for both decisions, and `recordImageSpend` after every prediction whether or not bytes arrived. `rawExtract` is the section 9 audit handle (this plan's spec refinement 3): the same three fields go in on both the stored and the failed path, because the prediction that cost money is the thing worth naming.

- [ ] **Step 1: Write the failing tests**

Create `tests/marketing/image-spend.test.ts`. The arithmetic is pure, so those cases need no mock at all; the two queries use the same `pg` mock shape as `tests/db/marketing.test.ts:1-9`:

```ts
// tests/marketing/image-spend.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const DOC = '99999999-9999-4999-8999-999999999999'
const SPEND_ID = '44444444-4444-4444-8444-444444444444'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/marketing/image-spend')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('the ceiling arithmetic', () => {
  it('spends exactly to the ceiling and passes', async () => {
    const { admitsRun, headroomMinor } = await load()
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 1996, costMinorPerImage: 4, assetCount: 1 })).toBe(true)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 500 })).toBe(true)
    expect(headroomMinor({ ceilingMinor: 2000, committedMinor: 1990 })).toBe(10)
    // Past the ceiling the headroom is nothing, not a negative number a caller
    // could mistake for room: an overrun must read as "stop", never as a budget.
    expect(headroomMinor({ ceilingMinor: 2000, committedMinor: 2400 })).toBe(0)
  })

  it('refuses one minor unit over the ceiling', async () => {
    const { admitsRun } = await load()
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 1997, costMinorPerImage: 4, assetCount: 1 })).toBe(false)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 501 })).toBe(false)
  })

  it('stops a six asset run at the boundary, so five are paid and the sixth is a refusal', async () => {
    const { admitsRun } = await load()
    let committed = 1980
    const fitted: number[] = []
    for (let asset = 0; asset < 6; asset++) {
      if (!admitsRun({ ceilingMinor: 2000, committedMinor: committed, costMinorPerImage: 4, assetCount: 1 })) break
      fitted.push(asset)
      committed += 4
    }
    expect(fitted).toHaveLength(5)
    expect(committed).toBe(2000)
  })

  it('admits nothing when a zero ceiling says stop, or a count of zero asks for nothing', async () => {
    const { admitsRun } = await load()
    expect(admitsRun({ ceilingMinor: 0, committedMinor: 0, costMinorPerImage: 4, assetCount: 1 })).toBe(false)
    expect(admitsRun({ ceilingMinor: 2000, committedMinor: 0, costMinorPerImage: 4, assetCount: 0 })).toBe(false)
  })
})

describe('the ledger', () => {
  it('sums only this tenant and only today', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1980' }] })
    const { committedSpendMinor } = await load()
    expect(await committedSpendMinor(TENANT)).toBe(1980)
    const [call] = calls('FROM marketing_image_spend')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('spent_on = CURRENT_DATE')
    expect(call!.params).toEqual([TENANT])
  })

  it('reads an empty ledger as zero and an unreadable ledger as an error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })
    const { committedSpendMinor } = await load()
    expect(await committedSpendMinor(TENANT)).toBe(0)
    // An aggregate without GROUP BY always returns exactly one row, and the
    // COALESCE makes that row's total a number, so zero rows is not an empty
    // ledger — it is a read that did not answer. Answering 0 there would be
    // answering "this tenant has spent nothing today", the one reading that
    // admits unlimited spend. Fail closed, and let the caller refuse.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await expect(committedSpendMinor(TENANT)).rejects.toThrow(/marketing_image_spend/)
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 'not-a-number' }] })
    await expect(committedSpendMinor(TENANT)).rejects.toThrow(/marketing_image_spend/)
  })

  it('appends a spend with a document', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    expect(
      await recordImageSpend({
        tenantId: TENANT,
        documentId: DOC,
        costMinor: 4,
        rawExtract: { predictionId: 'p1', model: 'flux-1.1-pro', costUsd: '0.04' },
      }),
    ).toBe(SPEND_ID)
    const [call] = calls('INSERT INTO marketing_image_spend')
    expect(call!.sql).toContain('RETURNING id')
    expect(call!.params).toEqual([
      TENANT,
      DOC,
      'replicate',
      4,
      JSON.stringify({ predictionId: 'p1', model: 'flux-1.1-pro', costUsd: '0.04' }),
    ])
  })

  it('appends a spend with no document, because a failed prediction still cost money', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    await recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: 4 })
    const [call] = calls('INSERT INTO marketing_image_spend')
    // No rawExtract passed is a null jsonb, not the string "null": a row written
    // by a caller that never saw a prediction must not look like a row whose
    // extract was parsed into nothing.
    expect(call!.params).toEqual([TENANT, null, 'replicate', 4, null])
  })

  it('names the prediction on a spend with no document, which is the failed path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SPEND_ID }] })
    const { recordImageSpend } = await load()
    await recordImageSpend({
      tenantId: TENANT,
      documentId: null,
      costMinor: 2,
      rawExtract: { predictionId: 'p-f', model: 'flux-1.1-pro', costUsd: '0.02' },
    })
    const [call] = calls('INSERT INTO marketing_image_spend')
    // Task 3's fact, stated as an assertion: a prediction that produced no
    // bytes can still carry a charge, and its handle is the only thing that
    // names the money later. A null document must never be read as
    // "no prediction to record".
    expect(call!.params).toEqual([
      TENANT,
      null,
      'replicate',
      2,
      JSON.stringify({ predictionId: 'p-f', model: 'flux-1.1-pro', costUsd: '0.02' }),
    ])
  })

  it('refuses to under-report a negative or fractional cost before the database sees it', async () => {
    const { recordImageSpend } = await load()
    await expect(recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: -1 })).rejects.toThrow(/cost_minor/)
    await expect(recordImageSpend({ tenantId: TENANT, documentId: null, costMinor: 1.5 })).rejects.toThrow(/cost_minor/)
    expect(calls('INSERT INTO marketing_image_spend')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/marketing/image-spend.test.ts`
Expected: FAIL with `Cannot find module '../../src/marketing/image-spend'`.

- [ ] **Step 3: Write the ledger**

Create `src/marketing/image-spend.ts`:

```ts
// src/marketing/image-spend.ts
// CRUM_IMAGE_SPEND_CEILING_MINOR is only real if there is a number to compare
// against, so this module owns both halves: the arithmetic, kept pure so the
// boundary is testable without a database, and the append-only ledger behind it
// (spec section 4.2).

import { getDbClient } from '../db/client'

export const REPLICATE_PROVIDER = 'replicate'

export function headroomMinor(params: { ceilingMinor: number; committedMinor: number }): number {
  return Math.max(0, params.ceilingMinor - params.committedMinor)
}

/**
 * One predicate, used twice: before the run with the whole asset count, and
 * before every asset with a count of one. The second use is what makes a run
 * that would cross the ceiling stop at the boundary instead of finishing and
 * overrunning it.
 *
 * `<=`, not `<`: spending exactly to the ceiling is spending to the ceiling, and
 * an owner who writes 2000 means $20.00 rather than $19.96.
 */
export function admitsRun(params: {
  ceilingMinor: number
  committedMinor: number
  costMinorPerImage: number
  assetCount: number
}): boolean {
  if (params.assetCount <= 0) return false
  if (params.costMinorPerImage < 0 || params.committedMinor < 0) return false
  return params.committedMinor + params.costMinorPerImage * params.assetCount <= params.ceilingMinor
}

/**
 * `SUM(integer)` comes back from node-pg as a string, because Postgres widens an
 * integer sum to bigint, so Number() is the whole conversion. The COALESCE in the
 * query means an empty ledger answers '0' rather than null.
 *
 * Anything else the database could answer throws. This number is the only thing
 * standing between an agent loop and a real bill, and 0 is the answer that
 * admits unlimited spend, so an unreadable ledger must fail closed and let the
 * caller refuse rather than spend.
 */
export async function committedSpendMinor(tenantId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND spent_on = CURRENT_DATE`,
    [tenantId],
  )
  const total = result.rows[0]?.total ?? null
  if (total === null || !/^\d+$/.test(String(total))) {
    throw new Error(
      `marketing_image_spend: the ceiling read answered ${JSON.stringify(result.rows)} instead of one non-negative integer total`,
    )
  }
  return Number(total)
}

export interface SpendRawExtract {
  predictionId: string
  model: string
  costUsd: string
}

/**
 * Append-only, and deliberately not in one transaction with the document insert
 * beside it: an invoice for an image we failed to save is a real cost and must
 * show up (spec section 9).
 */
export async function recordImageSpend(params: {
  tenantId: string
  documentId: string | null
  costMinor: number
  provider?: string
  rawExtract?: SpendRawExtract | null
}): Promise<string> {
  if (!Number.isInteger(params.costMinor) || params.costMinor < 0) {
    throw new Error(`cost_minor: ${params.costMinor} is not a non-negative integer of cents`)
  }
  const result = await getDbClient().query<{ id: string }>(
    // $5::jsonb, not a bare $5: every other jsonb write in src/ names the type
    // (src/db/pending-writes.ts:626, src/db/documents.ts:299, src/db/alerts.ts:113).
    // Postgres infers it correctly at a VALUES position today, and an explicit
    // cast is what keeps it correct the day this INSERT grows a SELECT.
    `INSERT INTO marketing_image_spend (tenant_id, document_id, provider, cost_minor, raw_extract)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      params.tenantId,
      params.documentId,
      params.provider ?? REPLICATE_PROVIDER,
      params.costMinor,
      // Stringified rather than handed over as an object: `pg` serialises a plain
      // object to a JSON string anyway, and doing it here means the unit test
      // above can assert the exact text that reaches the column.
      params.rawExtract ? JSON.stringify(params.rawExtract) : null,
    ],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('image_spend: the ledger insert returned no row')
  return id
}
```

No `spent_on` parameter: the DDL defaults it to `CURRENT_DATE`, which is the day the ceiling is per-day over, and a caller that could set it backwards would be a caller that could rewrite history in an append-only ledger.

**The day is the database server's day, not a JS-computed UTC day.** Spec section 4.2
pins the predicate as `spent_on = CURRENT_DATE` and 0021 stamps the column with
`DEFAULT CURRENT_DATE`, so write and read agree by construction. Computing the day in
JavaScript would put the read's notion of "today" out of step with the column default on
any non-UTC server, which is the worse bug. The operational consequence is worth one line
in the walkthrough: the ceiling resets at server-local midnight, so a rolling 24-hour
window can span two ceiling days — true of any calendar-day ceiling, including a UTC one.

- [ ] **Step 4: Prove the two SQL lanes against real Postgres**

Create `tests/integration/marketing-image-spend.test.ts`. Two rulings govern this file,
and both are about the fact that it shares a database with every other integration file:

1. **Every case mints its own tenant uuid.** `tests/integration/marketing-assets-migration.test.ts`
   (Task 1) inserts a spend row for tenant `11111111-1111-4111-8111-111111111111` on the same
   day, Vitest runs those files in parallel, and Task 1's cleanup is not in a `finally`. An
   absolute sum against the fixed tenant is therefore a race — and on this cluster it is
   already wrong, because that leftover row is still there. `marketing_image_spend.tenant_id`
   carries no foreign key (0021), so a minted uuid is legal, and a tenant nobody else touches
   makes every absolute sum an exact fact about this file's own rows.
2. **Compare `spent_on` to the server's own date, as text.** node-pg returns a `date` column
   as a `Date`, and the throwaway cluster runs UTC+11, so a JS ISO string is the wrong thing
   to compare `CURRENT_DATE` against.

```ts
// tests/integration/marketing-image-spend.test.ts
// The unit file proves the ceiling arithmetic with no database at all; this
// file proves the two SQL lanes of src/marketing/image-spend.ts work against
// the table migration 0021 actually built: the per-tenant, per-day committed
// read, the append-only write with its raw_extract handle, and the day the
// database stamps into spent_on itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient } from '../../src/db/client'
import { committedSpendMinor, recordImageSpend } from '../../src/marketing/image-spend'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
// committedSpendMinor and recordImageSpend speak through getDbClient(), which
// reads DATABASE_URL lazily at first call, so pointing it at the throwaway
// cluster here is the standing pattern (tests/integration/marketing-bundle.test.ts).
if (url) process.env.DATABASE_URL = url

let pool: Pool

// This file shares the database with every other integration file and Vitest
// runs them in parallel, so every case mints its own tenant uuid instead of
// reusing the fixed one: marketing-assets-migration.test.ts writes a spend row
// for tenant 11111111-... on the same day and its cleanup is not in a finally.
// tenant_id carries no foreign key to tenants (0021), so a minted uuid is legal,
// and with a tenant nobody else touches, an absolute sum stays an exact fact
// about this file's own rows.
async function unique(): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(`SELECT gen_random_uuid() AS n`)
  return rows[0]!.n
}

async function uniqueTenant(): Promise<string> {
  return await unique()
}

describe.skipIf(!url)('the image spend ledger against real Postgres', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await closeDbClient()
    await pool.end()
  })

  it('records a spend and counts it as the committed total for today', async () => {
    const tenant = await uniqueTenant()
    const doc = await unique()
    try {
      const spendId = await recordImageSpend({
        tenantId: tenant,
        documentId: doc,
        costMinor: 4,
        rawExtract: { predictionId: 'p-int-1', model: 'flux-1.1-pro', costUsd: '0.04' },
      })
      // A single spend row for this tenant makes the arithmetic exact.
      expect(await committedSpendMinor(tenant)).toBe(4)
      const { rows } = await pool.query<{
        provider: string
        cost_minor: number
        document_id: string
        raw_extract: { predictionId: string; model: string; costUsd: string }
        spent_on: string
      }>(
        `SELECT provider, cost_minor, document_id, raw_extract, spent_on::text AS spent_on
           FROM marketing_image_spend WHERE id = $1`,
        [spendId],
      )
      expect(rows[0]!.provider).toBe('replicate')
      expect(rows[0]!.cost_minor).toBe(4)
      expect(rows[0]!.document_id).toBe(doc)
      expect(rows[0]!.raw_extract).toEqual({ predictionId: 'p-int-1', model: 'flux-1.1-pro', costUsd: '0.04' })
      // The server's own today, read as text: node-pg hands a date column back
      // as a Date object and this cluster runs at UTC+11, so a UTC ISO string
      // is the wrong thing to compare CURRENT_DATE to (house pattern, 0021 file).
      const { rows: today } = await pool.query<{ d: string }>(`SELECT current_date::text AS d`)
      expect(rows[0]!.spent_on).toBe(today[0]!.d)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })

  it('counts a zero-minor spend row rather than skipping it', async () => {
    const tenant = await uniqueTenant()
    try {
      // costUsdToMinor('0.004') is 0 (Task 3): a sub-half-cent charge is honest
      // arithmetic, and a row of it must still land in the append-only ledger
      // even though it moves the day's sum by nothing.
      const spendId = await recordImageSpend({ tenantId: tenant, documentId: null, costMinor: 0 })
      expect(await committedSpendMinor(tenant)).toBe(0)
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM marketing_image_spend WHERE id = $1`,
        [spendId],
      )
      expect(rows).toHaveLength(1)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })

  it('keeps the spend of one tenant out of the ceiling read of another', async () => {
    const mine = await uniqueTenant()
    const other = await uniqueTenant()
    try {
      await recordImageSpend({ tenantId: mine, documentId: null, costMinor: 600 })
      await recordImageSpend({ tenantId: mine, documentId: null, costMinor: 1380 })
      await recordImageSpend({ tenantId: other, documentId: null, costMinor: 500 })
      expect(await committedSpendMinor(mine)).toBe(1980)
      expect(await committedSpendMinor(other)).toBe(500)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = ANY($1::uuid[])`, [[mine, other]])
    }
  })

  it('reads a tenant that has never spent as zero', async () => {
    // No row to clean up: the tenant exists only in this read.
    expect(await committedSpendMinor(await uniqueTenant())).toBe(0)
  })

  it('sums only today, so a backdated spend does not eat the new day', async () => {
    const tenant = await uniqueTenant()
    try {
      await recordImageSpend({ tenantId: tenant, documentId: null, costMinor: 40 })
      // The module deliberately exposes no spent_on parameter — an append-only
      // ledger whose caller can rewrite history is not append-only — so the
      // backdated row goes in through raw SQL to prove the read's day scoping.
      await pool.query(
        `INSERT INTO marketing_image_spend (tenant_id, document_id, provider, cost_minor, spent_on)
         VALUES ($1, NULL, 'replicate', 500, CURRENT_DATE - 1)`,
        [tenant],
      )
      expect(await committedSpendMinor(tenant)).toBe(40)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })
})
```

Five cases: the round trip with its `raw_extract` handle re-read as jsonb, the zero-minor
row Task 3 makes legitimate, tenant isolation, an empty ledger reading as `0`, and day
scoping through a backdated row. Each case deletes its own rows in a `finally`, which is
what makes the file rerunnable: every assertion is an absolute sum.

- [ ] **Step 5: Run both files**

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice4"
npx vitest run tests/marketing/image-spend.test.ts tests/integration/marketing-image-spend.test.ts
```

Expected: PASS on ten unit cases and five integration cases. A skipped integration file is
not a pass — the run must show the five cases executing. Then `npm run typecheck` and
`npm run lint`, both clean.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/image-spend.ts tests/marketing/image-spend.test.ts tests/integration/marketing-image-spend.test.ts
git commit -m "feat(marketing): add the daily image spend ledger and its ceiling arithmetic"
```

---

### Task 5: The asset data lane — prompts in, bytes out

**Files:**
- Create: `src/marketing/asset-prompts.ts`
- Create: `src/db/marketing-assets.ts`
- Test: `tests/marketing/asset-prompts.test.ts`
- Test: `tests/db/marketing-assets.test.ts`

**Interfaces:**
- Consumes: `insertDocument` and `DocumentFileWrite` from Task 2's `src/db/documents.ts`; the `marketing_artifacts` table from migration 0018.
- Produces:

```ts
// src/marketing/asset-prompts.ts
export interface AssetPrompt { name: string; prompt: string; aspectRatio: string; negativePrompt: string | null }
export type PromptParse =
  | { ok: true; prompts: AssetPrompt[] }
  | { ok: false; reason: 'no_asset_prompts' | 'asset_prompts_unparsable'; detail: string }
export function parseAssetPrompts(textContent: string | null | undefined): PromptParse

// src/db/marketing-assets.ts
export interface AssetProvenance {
  replicateId: string; model: string; aspectRatio: string
  negativePrompt: string | null; costMinor: number; seed: number; prompt: string
}
export function hashImageBytes(bytes: Uint8Array): string
export async function findAssetByHash(tenantId: string, contentHash: string): Promise<{ id: string; status: string } | null>
export async function insertAssetDocument(params: {
  tenantId: string; ownerId: string; title: string; bytes: Uint8Array; mime: string; provenance: AssetProvenance
}): Promise<{ id: string; status: string; contentHash: string; deduplicated: boolean }>
export async function getAssetBytes(tenantId: string, documentId: string): Promise<{ kind: string; status: string; mime: string; data: Uint8Array } | null>
export async function getDesignerArtifactText(tenantId: string, bundleId: string): Promise<string | null>
export async function listImageAssetStatuses(tenantId: string, bundleId: string): Promise<Array<{ documentId: string; title: string; status: string }>>
export async function listBundleIdsForDocument(tenantId: string, documentId: string): Promise<string[]>
```

Task 6's tool consumes `parseAssetPrompts`, `getDesignerArtifactText`, `insertAssetDocument` and `hashImageBytes`. Task 8's stage refusal consumes `listImageAssetStatuses`. Task 12's bytes route consumes `getAssetBytes` and `listBundleIdsForDocument`.

- [ ] **Step 1: Write the failing prompt-parser tests**

Create `tests/marketing/asset-prompts.test.ts`:

```ts
// tests/marketing/asset-prompts.test.ts
import { describe, expect, it } from 'vitest'
import { parseAssetPrompts } from '../../src/marketing/asset-prompts'

const HERO = {
  name: 'hero-image',
  prompt: 'a physio clinic reception at dawn, warm light, no text',
  aspectRatio: '16:9',
  negativePrompt: 'watermark',
}

describe('parseAssetPrompts', () => {
  it('reads the contract shape the designer instruction promises', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [HERO] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts).toEqual([
      { name: 'hero-image', prompt: HERO.prompt, aspectRatio: '16:9', negativePrompt: 'watermark' },
    ])
  })

  it('says no_asset_prompts when there is no stored text at all', () => {
    expect(parseAssetPrompts(null)).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
    expect(parseAssetPrompts('')).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
    expect(parseAssetPrompts('   ')).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
  })

  it('says asset_prompts_unparsable for prose, which is the case spec 6 step 2 names', () => {
    const parsed = parseAssetPrompts('Make it look friendly and modern, maybe a reception desk.')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('asset_prompts_unparsable')
    expect(parsed.detail).toContain('not JSON')
  })

  it('says asset_prompts_unparsable for JSON with no assets array, or an empty one', () => {
    expect(parseAssetPrompts(JSON.stringify({ mood: 'calm' }))).toMatchObject({
      reason: 'asset_prompts_unparsable',
    })
    expect(parseAssetPrompts(JSON.stringify({ assets: [] }))).toMatchObject({
      reason: 'asset_prompts_unparsable',
    })
  })

  it('refuses an artifact that is valid JSON but not an object, and never throws', () => {
    // The literal string `null` is the case that matters: JSON.parse answers
    // null, and reading `.assets` off null is a TypeError that would leave this
    // module's contract (a refusal, always) and reach the tool as an exception.
    // 123, "text" and [] are the neighbours that already refused, pinned so a
    // future refactor cannot fix one lane and break the other.
    for (const text of ['null', '123', '"a clinic"', '[]', 'true']) {
      expect(parseAssetPrompts(text)).toMatchObject({ ok: false, reason: 'asset_prompts_unparsable' })
    }
  })

  it('refuses the whole set when one entry has no prompt, rather than paying for the others', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [HERO, { name: 'b-roll' }] }))
    expect(parsed).toMatchObject({ ok: false, reason: 'asset_prompts_unparsable' })
    if (parsed.ok) return
    expect(parsed.detail).toContain('b-roll')
  })

  it('defaults a missing aspect ratio to auto and a missing name to its position', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [{ prompt: 'a clinic hallway' }] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts[0]).toEqual({
      name: 'asset-1',
      prompt: 'a clinic hallway',
      aspectRatio: 'auto',
      negativePrompt: null,
    })
  })

  it('keeps the order the designer wrote, because the loop pays in that order', () => {
    const parsed = parseAssetPrompts(
      JSON.stringify({ assets: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }] }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts.map((p) => p.name)).toEqual(['asset-1', 'asset-2', 'asset-3'])
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/marketing/asset-prompts.test.ts`
Expected: FAIL with `Cannot find module '../../src/marketing/asset-prompts'`.

- [ ] **Step 3: Write the parser**

Create `src/marketing/asset-prompts.ts`:

```ts
// src/marketing/asset-prompts.ts
// The asset pass reads prompts out of the stored creative-designer artifact row
// and never off an agent's arguments, so the shape of that row is a contract
// rather than a suggestion (spec sections 5 and 6 step 2). This module is the one
// place that contract is parsed, and its two refusal reasons are the difference
// between "this bundle has no creative" and "this bundle's creative arrived as
// prose" — which the owner reads as two different next actions.

export interface AssetPrompt {
  name: string
  prompt: string
  aspectRatio: string
  negativePrompt: string | null
}

export type PromptParse =
  | { ok: true; prompts: AssetPrompt[] }
  | { ok: false; reason: 'no_asset_prompts' | 'asset_prompts_unparsable'; detail: string }

function unparsable(detail: string): PromptParse {
  return { ok: false, reason: 'asset_prompts_unparsable', detail }
}

export function parseAssetPrompts(textContent: string | null | undefined): PromptParse {
  if (textContent === null || textContent === undefined || textContent.trim() === '') {
    return {
      ok: false,
      reason: 'no_asset_prompts',
      detail: 'the bundle carries no creative-designer artifact holding asset prompts',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(textContent)
  } catch (err) {
    return unparsable(
      `designer artifact is not JSON (${
        err instanceof Error ? err.message : String(err)
      }), so no money is committed against it`,
    )
  }

  // A bare `null` parses as valid JSON and answers null, and `null.assets` is a
  // TypeError. This function's contract is a refusal the tool can turn into a
  // code the owner reads; an exception instead is an agent turn dying.
  if (parsed === null || typeof parsed !== 'object') {
    return unparsable(
      `designer artifact is JSON but not an object (it is ${JSON.stringify(parsed)}), so it cannot carry an "assets" array`,
    )
  }

  const raw = (parsed as { assets?: unknown }).assets
  if (!Array.isArray(raw) || raw.length === 0) {
    return unparsable('designer artifact JSON has no non-empty "assets" array')
  }

  const prompts: AssetPrompt[] = []
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index] as Record<string, unknown> | null
    // A nameless entry is still salvageable by position; a promptless one is not a
    // payable asset, and paying for five of six because one was malformed is how a
    // bundle ends up with a half-finished media plan and no explanation.
    const name =
      typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : `asset-${index + 1}`
    if (typeof entry?.prompt !== 'string' || entry.prompt.trim() === '') {
      return unparsable(`asset "${name}" has no prompt`)
    }
    prompts.push({
      name,
      prompt: entry.prompt,
      // 'auto' is the model's own default and is in the accepted set, so a designer
      // that omitted the field still gets a render rather than a refusal. A
      // present-but-wrong value is refused by the adapter, which is the layer that
      // knows the set.
      aspectRatio:
        typeof entry.aspectRatio === 'string' && entry.aspectRatio.trim() !== ''
          ? entry.aspectRatio.trim()
          : 'auto',
      negativePrompt:
        typeof entry.negativePrompt === 'string' && entry.negativePrompt.trim() !== ''
          ? entry.negativePrompt.trim()
          : null,
    })
  }

  return { ok: true, prompts }
}
```

- [ ] **Step 4: Write the failing data-lane tests**

Create `tests/db/marketing-assets.test.ts`. `pg` is mocked once for the whole file, and both the pool and the checked-out client answer through the same `mockQuery`, because `insertDocument` calls `db.connect()` while the reads call `db.query()`:

```ts
// tests/db/marketing-assets.test.ts
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
// `() => Promise.resolve(mockClient)` and not `async () => mockClient`: this repo
// lints with `@typescript-eslint/require-await` as an error, so an async body with
// nothing to await fails the gate. Same shape as tests/db/documents-asset-lane.test.ts:9.
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DOC = '99999999-9999-4999-8999-999999999999'
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10])

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

/**
 * Route by SQL fragment so one mock answers the hash lookup, the document insert
 * and the file insert without any test having to know which call number it is on.
 * The handler returns a resolved Promise instead of being `async` because
 * `require-await` is an error here and there is nothing to await.
 */
function route(handlers: Array<{ match: string; rows: unknown[] }>) {
  mockQuery.mockImplementation((sql: unknown) => {
    for (const handler of handlers) {
      if ((sql as string).includes(handler.match)) return Promise.resolve({ rows: handler.rows })
    }
    return Promise.resolve({ rows: [] })
  })
}

async function load() {
  return await import('../../src/db/marketing-assets')
}

const PROVENANCE = {
  replicateId: 'pred-1',
  model: 'black-forest-labs/flux-1.1-pro',
  aspectRatio: '16:9',
  negativePrompt: 'watermark',
  costMinor: 4,
  seed: 4217,
  prompt: 'a physio clinic reception at dawn',
}

const HASHED = sha(BYTES)

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [] })
})

describe('insertAssetDocument', () => {
  it('writes the widened kind, the generated source, needs_review, and the bytes', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    expect(result).toEqual({ id: DOC, status: 'needs_review', contentHash: HASHED, deduplicated: false })

    const [insert] = calls('INSERT INTO documents')
    expect(insert!.params).toContain('marketing_asset')
    expect(insert!.params).toContain('generated')
    expect(insert!.params).toContain('needs_review')
    expect(insert!.params).toContain(HASHED)
    // The prompt is content_text, because the column is NOT NULL and the prompt is
    // the provenance a reviewer needs (spec 4.1).
    expect(insert!.params).toContain(PROVENANCE.prompt)

    const [file] = calls('INSERT INTO document_files')
    expect(file!.params).toEqual([DOC, TENANT, 'image/png', BYTES.byteLength, BYTES])
  })

  it('reuses an identical image and never re-pays for it', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [{ id: DOC, status: 'ready' }] },
    ])
    const { insertAssetDocument } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    expect(result.deduplicated).toBe(true)
    expect(result.id).toBe(DOC)
    expect(result.status).toBe('ready')
    // The lookup behind the reuse is the tenant-scoped hash read, and its pair is
    // ordered (tenant, hash). A swapped pair asks Postgres for "the tenant whose
    // id is this digest", matches nothing, and pays for an image the tenant
    // already owns — which no other assertion in this case can see.
    const [lookup] = calls('FROM documents WHERE tenant_id = $1 AND content_hash = $2')
    expect(lookup!.params).toEqual([TENANT, HASHED])
    // A reused hash must not touch the byte lane a second time, and must not
    // overwrite a status a human already set.
    expect(calls('INSERT INTO documents')).toHaveLength(0)
    expect(calls('INSERT INTO document_files')).toHaveLength(0)
  })

  it('keeps the negative prompt in raw_extract, where a future model can use it', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 't',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    const [insert] = calls('INSERT INTO documents')
    // raw_extract is the thirteenth parameter and the thirteenth value is passed
    // through JSON.stringify by insertDocument (src/db/documents.ts:214).
    // The `as Record<string, unknown>` is not decoration: `no-unsafe-assignment`
    // is an error in this repo, and a bare JSON.parse hands back `any`.
    const raw = JSON.parse(insert!.params[12] as string) as Record<string, unknown>
    // All seven provenance fields, not a picked four: raw_extract exists so that a
    // future re-fetch (spec section 9) can redo this exact render, and a model
    // name, an aspect ratio or a cost that quietly stopped travelling is precisely
    // the loss a subset assertion cannot see. `toEqual` rather than
    // `toMatchObject` because this column holds the provenance and nothing else.
    expect(raw).toEqual(PROVENANCE)
  })

  it('names the sha256 of the bytes, not of the prompt, as the content hash', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument, hashImageBytes } = await load()
    const result = await insertAssetDocument({
      tenantId: TENANT,
      ownerId: OWNER,
      title: 'hero-image',
      bytes: BYTES,
      mime: 'image/png',
      provenance: PROVENANCE,
    })
    // Both sides go through the module's own helper, so this compares two things
    // the code hashed rather than two things the test hashed: `sha()` above is the
    // test's copy of the digest, so an implementation that stringified its input
    // still satisfied it. The first line is the discriminator — a lane that hashed
    // the prompt would answer the prompt digest here and fail.
    expect(result.contentHash).toBe(hashImageBytes(BYTES))
    expect(result.contentHash).not.toBe(hashImageBytes(new TextEncoder().encode(PROVENANCE.prompt)))
    // And the value that reached the hash column is the value returned, position 7
    // of the INSERT list (`content_hash` is the seventh column at
    // src/db/documents.ts:197).
    const [insert] = calls('INSERT INTO documents')
    expect(insert!.params[6]).toBe(result.contentHash)
  })

  it('refuses an image with no bytes, because its digest is the empty-text digest', async () => {
    route([
      { match: 'FROM documents WHERE tenant_id = $1 AND content_hash = $2', rows: [] },
      { match: 'INSERT INTO documents', rows: [{ id: DOC, status: 'needs_review', confidence: null, is_new: true }] },
    ])
    const { insertAssetDocument } = await load()
    await expect(
      insertAssetDocument({
        tenantId: TENANT,
        ownerId: OWNER,
        title: 'empty',
        bytes: new Uint8Array(0),
        mime: 'image/png',
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/0 bytes/)
    // The refusal is before the database, so neither door is reached: a row written
    // here would be a document whose bytes are absent, which is the state this
    // guard exists to keep out of the asset lane.
    expect(calls('FROM documents WHERE tenant_id')).toHaveLength(0)
    expect(calls('INSERT INTO documents')).toHaveLength(0)
  })
})

describe('the reads', () => {
  it('reads bytes back scoped to the tenant, and only for an asset kind', async () => {
    route([
      {
        match: 'FROM document_files f',
        rows: [{ kind: 'marketing_asset', status: 'needs_review', mime: 'image/png', data: BYTES }],
      },
    ])
    const { getAssetBytes } = await load()
    expect(await getAssetBytes(TENANT, DOC)).toEqual({
      kind: 'marketing_asset',
      status: 'needs_review',
      mime: 'image/png',
      data: BYTES,
    })
    const [call] = calls('FROM document_files f')
    expect(call!.sql).toContain("d.kind = 'marketing_asset'")
    expect(call!.params).toEqual([DOC, TENANT])
  })

  it('returns null for a document that is not a marketing asset', async () => {
    route([{ match: 'FROM document_files f', rows: [] }])
    const { getAssetBytes } = await load()
    expect(await getAssetBytes(TENANT, DOC)).toBeNull()
  })

  it('reads the newest creative-designer script artifact text', async () => {
    route([{ match: 'FROM marketing_artifacts', rows: [{ text_content: '{"assets":[]}' }] }])
    const { getDesignerArtifactText } = await load()
    expect(await getDesignerArtifactText(TENANT, BUNDLE)).toBe('{"assets":[]}')
    const [call] = calls('FROM marketing_artifacts')
    expect(call!.sql).toContain("role = 'creative-designer'")
    expect(call!.sql).toContain("kind = 'script'")
    expect(call!.params).toEqual([TENANT, BUNDLE])
  })

  it('names each image artifact with its document status, for the stage refusal', async () => {
    route([
      {
        match: 'FROM marketing_artifacts a',
        rows: [{ document_id: DOC, title: 'hero-image', status: 'needs_review' }],
      },
    ])
    const { listImageAssetStatuses } = await load()
    expect(await listImageAssetStatuses(TENANT, BUNDLE)).toEqual([
      { documentId: DOC, title: 'hero-image', status: 'needs_review' },
    ])
    const [call] = calls('FROM marketing_artifacts a')
    expect(call!.sql).toContain("a.kind = 'image'")
    expect(call!.sql).toContain('JOIN documents d')
    // The predicate and the pair, not only the projection. Task 8 reads an EMPTY
    // list as "this bundle has no images, so there is nothing to refuse", so a
    // dropped `a.tenant_id = $1` or a swapped [bundleId, tenantId] shows another
    // tenant's images as absent and stages a bundle full of unreviewed faces. The
    // mock answers that broken query with the same row this test supplies, which
    // is exactly why the SQL text and the parameter order have to be asserted here
    // rather than inferred from the mapped result.
    expect(call!.sql).toContain('a.tenant_id = $1')
    expect(call!.sql).toContain('a.bundle_id = $2')
    expect(call!.params).toEqual([TENANT, BUNDLE])
  })

  it('lists the bundles that carry a document, for the bytes-route gate', async () => {
    route([{ match: 'FROM marketing_artifacts', rows: [{ bundle_id: BUNDLE }] }])
    const { listBundleIdsForDocument } = await load()
    expect(await listBundleIdsForDocument(TENANT, DOC)).toEqual([BUNDLE])
    // Same reason as the stage list above, with the directions reversed: this read
    // gates Task 12's bytes route, so an unscoped version answers SOME bundle for
    // any caller and serves a document to a tenant that does not own it. Asserting
    // only the mapped array would pass against that query.
    const [call] = calls('DISTINCT bundle_id')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('document_id = $2')
    expect(call!.params).toEqual([TENANT, DOC])
  })
})
```

- [ ] **Step 5: Run them to make sure they fail**

Run: `npx vitest run tests/db/marketing-assets.test.ts`
Expected: FAIL with `Cannot find module '../../src/db/marketing-assets'`.

- [ ] **Step 6: Write the data lane**

Create `src/db/marketing-assets.ts`:

```ts
// src/db/marketing-assets.ts
// The asset lane for slice 4: one generated image in, one documents row plus one
// document_files row out, and the three reads the tool and the two routes need.
// There is no marketing_assets table, because an image is a document (spec
// section 4.1) and the byte lane already exists.

import { createHash } from 'node:crypto'
import { getDbClient } from './client'
import { insertDocument } from './documents'

export interface AssetProvenance {
  replicateId: string
  model: string
  aspectRatio: string
  negativePrompt: string | null
  costMinor: number
  seed: number
  prompt: string
}

/**
 * Synchronous on purpose. `createHash` is CPU work on bytes already in memory, and
 * this repo lints with BOTH `require-await` (an `async` function must await
 * something) and `await-thenable` (a caller must not await a non-thenable), so a
 * Promise-returning pure function is illegal on one side and an `await`-ing caller
 * illegal on the other. Same shape as the sync sha256 helper in
 * `src/marketing/meta-conversions.ts:58`.
 */
export function hashImageBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The dedup lookup, on the same uq_document_hash the upload lane uses. For an
 * image the content being fingerprinted is the bytes rather than extracted text,
 * which is the same rule with a different input.
 */
export async function findAssetByHash(
  tenantId: string,
  contentHash: string,
): Promise<{ id: string; status: string } | null> {
  const result = await getDbClient().query<{ id: string; status: string }>(
    `SELECT id, status FROM documents WHERE tenant_id = $1 AND content_hash = $2 LIMIT 1`,
    [tenantId, contentHash],
  )
  const row = result.rows[0]
  return row ? { id: row.id, status: row.status } : null
}

/**
 * One image, through the existing document insert, so a generated asset inherits
 * the hash dedup, the provenance columns and a review status a human can flip.
 *
 * `parse` is null and there are no blocks: nothing was extracted from a PNG. That
 * makes the file write a sibling of the parse write rather than a child of it,
 * which is the guard hoist Task 2 exists for — without it the row below stores its
 * metadata and loses its bytes.
 */
export async function insertAssetDocument(params: {
  tenantId: string
  ownerId: string
  title: string
  bytes: Uint8Array
  mime: string
  provenance: AssetProvenance
}): Promise<{ id: string; status: string; contentHash: string; deduplicated: boolean }> {
  // Refused before the hash rather than after it. `hashImageBytes(new Uint8Array(0))`
  // is `e3b0c442…`, which is also sha256 of the empty string — the fingerprint the
  // text lane gives a document with nothing extracted from it. So an empty image
  // would dedup onto somebody's blank invoice row and return a `document_id` whose
  // kind is not `marketing_asset`: a bytes route that 404s forever, for an asset
  // that was never stored. Task 3's download already refuses zero bytes, so this is
  // the lane defending itself against the caller spec section 9 asks for later.
  if (params.bytes.byteLength === 0) {
    throw new Error(`insertAssetDocument: "${params.title}" carries 0 bytes, which is not an image`)
  }
  const contentHash = hashImageBytes(params.bytes)
  const existing = await findAssetByHash(params.tenantId, contentHash)
  if (existing) {
    // No second insert, so no overwrite of a status a human already set, and no
    // second spend row for the same bytes.
    return { id: existing.id, status: existing.status, contentHash, deduplicated: true }
  }

  const inserted = await insertDocument({
    tenantId: params.tenantId,
    ownerId: params.ownerId,
    kind: 'marketing_asset',
    title: params.title,
    source: 'generated',
    sourceRef: null,
    contentHash,
    contentText: params.provenance.prompt,
    mime: params.mime,
    status: 'needs_review',
    confidence: null,
    customerId: null,
    rawExtract: params.provenance,
    file: { mime: params.mime, sizeBytes: params.bytes.byteLength, data: params.bytes },
    parse: null,
  })

  return { id: inserted.id, status: inserted.status, contentHash, deduplicated: false }
}

/**
 * The bytes lane, with the kind check inside the query rather than after it: the
 * asset route must not become a way to read somebody's invoice PDF (spec section
 * 8.3 says 404 for that reason, and this query is what makes the 404 reachable).
 */
export async function getAssetBytes(
  tenantId: string,
  documentId: string,
): Promise<{ kind: string; status: string; mime: string; data: Uint8Array } | null> {
  const result = await getDbClient().query<{
    kind: string
    status: string
    mime: string
    // node-pg hands a `bytea` back as a Buffer, and `@types/node` declares
    // `interface Buffer extends Uint8Array`, so `Uint8Array` already types both
    // the driver's value and a test's plain view. An explicit
    // `instanceof Uint8Array ? … : new Uint8Array(…)` fallback was here and is
    // gone: TypeScript narrows its false branch to `never`, and the runtime it
    // imagined was worse than the crash it prevented — `new Uint8Array(5)`
    // answers five zero bytes and `new Uint8Array('abc')` answers none, so a
    // malformed driver value would have been served as a silently empty 200.
    data: Uint8Array
  }>(
    `SELECT d.kind, d.status, f.mime, f.data
       FROM document_files f
       JOIN documents d ON d.id = f.document_id
      WHERE f.document_id = $1 AND f.tenant_id = $2 AND d.kind = 'marketing_asset'
      LIMIT 1`,
    [documentId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { kind: row.kind, status: row.status, mime: row.mime, data: row.data }
}

/**
 * The prompts the asset pass will spend on, read back from the stored designer
 * artifact rather than from a model's arguments. Newest first, because a bundle
 * re-saved with a revised creative set has two script rows and the pass must
 * render the one the reviewer just read.
 */
export async function getDesignerArtifactText(tenantId: string, bundleId: string): Promise<string | null> {
  const result = await getDbClient().query<{ text_content: string | null }>(
    `SELECT text_content
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2 AND role = 'creative-designer' AND kind = 'script'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, bundleId],
  )
  return result.rows[0]?.text_content ?? null
}

/**
 * Every image artifact in a bundle with the status of the document behind it.
 * marketing.stage_bundle refuses on a non-ready row found here and names the
 * title (spec section 6.1), so the title travels rather than a bare uuid: an
 * owner who is told "needs_review" has to work out which picture they mean.
 */
export async function listImageAssetStatuses(
  tenantId: string,
  bundleId: string,
): Promise<Array<{ documentId: string; title: string; status: string }>> {
  const result = await getDbClient().query<{ document_id: string; title: string; status: string }>(
    `SELECT a.document_id, d.title, d.status
       FROM marketing_artifacts a
       JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id = $1 AND a.bundle_id = $2 AND a.kind = 'image' AND a.document_id IS NOT NULL
      ORDER BY d.title ASC, a.id ASC`,
    [tenantId, bundleId],
  )
  return result.rows.map((row) => ({ documentId: row.document_id, title: row.title, status: row.status }))
}

/**
 * Which bundles hold this document. The bytes route gates on the answer: an asset
 * belongs to a bundle, and the prediction gate is a property of the bundle's open
 * stage draft, not of the file.
 */
export async function listBundleIdsForDocument(tenantId: string, documentId: string): Promise<string[]> {
  const result = await getDbClient().query<{ bundle_id: string }>(
    `SELECT DISTINCT bundle_id
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, documentId],
  )
  return result.rows.map((row) => row.bundle_id)
}
```

No `AssetPrompt` import here, and no `type` re-export: this file's signatures do not
take an `AssetPrompt` (`AssetProvenance` is the shape that travels with bytes), and
`@typescript-eslint/no-unused-vars` is an error in this repo's config, so an
import-ahead-of-its-use would fail the gate rather than anticipate Task 6. Task 6
imports `AssetPrompt` from the module that defines it. `insertDocument`'s return is
`{ id, status, confidence }` with `status: string`, which is why
`insertAssetDocument` types `status` as `string` rather than the literal.

- [ ] **Step 7: Run every test in the task**

Run: `npx vitest run tests/marketing/asset-prompts.test.ts tests/db/marketing-assets.test.ts`
Expected: PASS on both files, and the run must name eighteen cases — eight in the parser file and
ten in the data-lane file. A number below eighteen means a case was silently not collected, which
is the failure this count exists to catch. Then `npm run typecheck` and `npm run lint` — both clean.

- [ ] **Step 8: Commit**

```bash
git add src/marketing/asset-prompts.ts src/db/marketing-assets.ts tests/marketing/asset-prompts.test.ts tests/db/marketing-assets.test.ts
git commit -m "feat(marketing): add the asset prompt parser and the generated image data lane"
```

---

### Task 6: `marketing.generate_assets`, and the whole tool surface in one commit

**Files:**
- Create: `src/marketing/image-provider.ts`
- Modify: `src/mastra/tools/marketing-writes.ts` (append `generateAssetsTool`)
- Modify: `src/marketing/payload.ts` (add `generateAssetsRiskView`)
- Modify: `policy/tools.yaml` (declare the tool immediately above the `# ── approval (13)` header at line 184, and bump the `# ── auto (6)` header comment at line 141 to `# ── auto (7)`)
- Modify: `src/mastra/processors/write-claim-guard.ts:8-25` (`MUTATING_TOOL_IDS`)
- Modify: `src/mastra/agent.ts:36,88` (the `marketing-writes` import and the registry)
- Modify: `tests/governance/conformance.test.ts:51-55,92`
- Modify: `tests/governance/policy.test.ts:57,69`
- Modify: `tests/governance/marketing-payload.test.ts`
- Modify: `tests/mastra/active-tools.test.ts:44,70,71,74,76,80,82,143` (one `AUTO_TOOLS` entry, two derived list comments, two titles, three assertions)
- Modify: `tests/mastra/agent.test.ts:51-53` (the registry count and its title)
- Modify: `tests/mastra/processors/write-claim-guard.test.ts:52` plus two `toContain` rows
- Modify: `docs/TECHNICAL_PLAN.md` section 4.6.2
- Test: `tests/marketing/generate-assets-tool.test.ts`
- Test: `tests/integration/marketing-generate-assets.test.ts`

**Interfaces:**
- Consumes: `parseAssetPrompts` + `AssetPrompt` (Task 5), `insertAssetDocument` + `getDesignerArtifactText` + `listImageAssetStatuses` (Task 5), `admitsRun` + `committedSpendMinor` + `recordImageSpend` (Task 4), `generateImage` + `ImageOutcome` + `ImageRequest` (Task 3), `insertMarketingArtifacts` + `getMarketingBundle` + `ArtifactInput` from `src/db/marketing.ts`, `createHumanTask` from `src/db/pending-writes.ts`, `loadPolicy` + `scoreRisk` + `policy.gateFor`.
- Produces:

```ts
// src/marketing/image-provider.ts
export interface ImageAdapter {
  provider: string
  model: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  generate(request: ImageRequest): Promise<ImageOutcome>
}
export interface ReplicateAdapterParams {
  apiToken: string
  model?: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  fetchImpl?: typeof fetch
}
// `model` is optional and defaults to Task 3's DEFAULT_REPLICATE_MODEL. Task 9's
// boot registration passes it from CRUM_REPLICATE_MODEL, and the tests do not.
export function makeReplicateAdapter(params: ReplicateAdapterParams): ImageAdapter
export function setImageAdapter(adapter: ImageAdapter | null): void
export function getImageAdapter(): ImageAdapter | null

// src/marketing/payload.ts
export interface GenerateAssetsRiskView {
  bundleId: string
  objective: string
  assetCount: number
  estimatedCostMinor: number
}
export function generateAssetsRiskView(input: GenerateAssetsRiskView): Record<string, unknown>

// src/mastra/tools/marketing-writes.ts
export const generateAssetsTool   // id 'marketing.generate_assets'
// input:  { bundleId: string (uuid) }
// output: { bundleId, assets: Array<{ name, documentId, status, deduplicated, costMinor }>,
//           refused: Array<{ name, code, detail }>, spentMinor, provider, model,
//           humanTaskId: string | null, riskScore, gate, message }
```

Task 7's instruction text and Task 9's boot registration both name `makeReplicateAdapter` / `setImageAdapter`; Task 9's env task supplies the four numbers.

- [ ] **Step 1: Write the failing tool tests**

Create `tests/marketing/generate-assets-tool.test.ts`. The tool is the boundary that joins four modules, so all four are mocked and every assertion is about behaviour, not SQL (the SQL is pinned in Task 5):

```ts
// tests/marketing/generate-assets-tool.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  insertMarketingArtifacts: vi.fn(),
  getDesignerArtifactText: vi.fn(),
  insertAssetDocument: vi.fn(),
  hashImageBytes: vi.fn(),
  listImageAssetStatuses: vi.fn(),
  committedSpendMinor: vi.fn(),
  recordImageSpend: vi.fn(),
  createHumanTask: vi.fn(),
  getImageAdapter: vi.fn(),
  generate: vi.fn(),
}))

vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: h.getMarketingBundle,
  insertMarketingArtifacts: h.insertMarketingArtifacts,
  ARTIFACT_KINDS: ['script', 'image', 'page_html', 'thank_you_html', 'ad_copy'],
  MARKETING_OBJECTIVES: ['outreach_support', 'inbound_leads', 'proof_asset'],
  MARKETING_ROLES: [
    'offer-strategist',
    'marketer-copywriter',
    'creative-designer',
    'media-buyer',
    'funnel-builder',
    'campaign-analyst',
  ],
}))
vi.mock('../../src/db/marketing-assets', () => ({
  getDesignerArtifactText: h.getDesignerArtifactText,
  insertAssetDocument: h.insertAssetDocument,
  hashImageBytes: h.hashImageBytes,
  listImageAssetStatuses: h.listImageAssetStatuses,
}))
vi.mock('../../src/marketing/image-spend', async () => {
  const actual = await vi.importActual<typeof import('../../src/marketing/image-spend')>(
    '../../src/marketing/image-spend',
  )
  return { ...actual, committedSpendMinor: h.committedSpendMinor, recordImageSpend: h.recordImageSpend }
})
vi.mock('../../src/db/pending-writes', () => ({ createHumanTask: h.createHumanTask }))
vi.mock('../../src/marketing/image-provider', () => ({ getImageAdapter: h.getImageAdapter }))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DOC = '99999999-9999-4999-8999-999999999999'
const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: OWNER, userRole: 'user' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

function bundle(status: string) {
  return { id: BUNDLE, tenantId: TENANT, brief: 'b', objective: 'outreach_support', status }
}

function promptJson(...names: string[]): string {
  return JSON.stringify({
    assets: names.map((name) => ({
      name,
      prompt: `a prompt for ${name}`,
      aspectRatio: '16:9',
      negativePrompt: null,
    })),
  })
}

function okImage(name: string, costMinor = 4) {
  return {
    ok: true as const,
    image: {
      predictionId: `pred-${name}`,
      costUsd: '0.04',
      costMinor,
      model: 'black-forest-labs/flux-1.1-pro',
      aspectRatio: '16:9',
      mime: 'image/png' as const,
      bytes: new Uint8Array([1, 2, 3]),
      sizeBytes: 3,
    },
  }
}

function failImage(code: string, detail: string, charge: unknown = null, deadToken = false) {
  return { ok: false as const, code, detail, charge, deadToken }
}

/**
 * The ledger as a closure, so the arithmetic under test is the real admitsRun over
 * a running total rather than a scripted sequence of answers.
 */
function ledger(start = 0) {
  let committed = start
  // Not `async () =>`: this repo's lint rejects an async arrow with no await in it,
  // and a promise literal keeps the ledger's timing identical.
  h.committedSpendMinor.mockImplementation(() => Promise.resolve(committed))
  h.recordImageSpend.mockImplementation((params: { costMinor: number }) => {
    committed += params.costMinor
    return Promise.resolve('spend-row')
  })
  return { get committed() { return committed } }
}

async function run(input: { bundleId: string }) {
  const { generateAssetsTool } = await import('../../src/mastra/tools/marketing-writes')
  return (await generateAssetsTool.execute!(input, context)) as {
    bundleId: string
    assets: Array<{ name: string; documentId: string; status: string; deduplicated: boolean; costMinor: number }>
    refused: Array<{ name: string; code: string; detail: string }>
    spentMinor: number
    provider: string | null
    model: string | null
    humanTaskId: string | null
    riskScore: number
    gate: string
    message: string
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getImageAdapter.mockReturnValue({
    provider: 'replicate',
    model: 'black-forest-labs/flux-1.1-pro',
    ceilingMinor: 2000,
    costMinorPerImage: 4,
    maxBytes: 15 * 1024 * 1024,
    generate: h.generate,
  })
  h.getMarketingBundle.mockResolvedValue(bundle('draft'))
  h.getDesignerArtifactText.mockResolvedValue(promptJson('hero-image'))
  h.hashImageBytes.mockReturnValue('c'.repeat(64))
  h.insertAssetDocument.mockResolvedValue({
    id: DOC,
    status: 'needs_review',
    contentHash: 'c'.repeat(64),
    deduplicated: false,
  })
  h.insertMarketingArtifacts.mockResolvedValue(1)
  h.createHumanTask.mockResolvedValue(TASK_ID)
  h.generate.mockResolvedValue(okImage('hero-image'))
  h.listImageAssetStatuses.mockResolvedValue([])
  ledger(0)
})

describe('marketing.generate_assets refuses before it costs anything', () => {
  it('refuses a live bundle, because shipping assets for a finished campaign is not the job', async () => {
    h.getMarketingBundle.mockResolvedValue(bundle('live'))
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('bundle_not_generable')
    expect(result.assets).toHaveLength(0)
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.createHumanTask).toHaveBeenCalledTimes(1)
    expect(result.humanTaskId).toBe(TASK_ID)
  })

  it('refuses an archived bundle', async () => {
    h.getMarketingBundle.mockResolvedValue(bundle('archived'))
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('bundle_not_generable')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses a missing bundle', async () => {
    h.getMarketingBundle.mockResolvedValue(null)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('not_found')
    // The prose has to match the rows: `bundle` is null here, so the human-task
    // block is skipped and no task exists. This case is the only cover for that
    // branch of the refused-branch message, which used to promise a task
    // unconditionally.
    expect(result.humanTaskId).toBeNull()
    expect(h.createHumanTask).not.toHaveBeenCalled()
    expect(result.message).toContain('not_found')
    expect(result.message).toContain('No human task was created')
    expect(result.message).not.toContain('A human task was created.')
  })

  it('refuses with no_asset_prompts when the designer artifact row is absent', async () => {
    h.getDesignerArtifactText.mockResolvedValue(null)
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('no_asset_prompts')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses with asset_prompts_unparsable when the creative arrived as prose', async () => {
    h.getDesignerArtifactText.mockResolvedValue('Make it friendly, maybe a reception desk.')
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('asset_prompts_unparsable')
  })

  it('refuses at call time when no adapter is registered, which is an absent token', async () => {
    h.getImageAdapter.mockReturnValue(null)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('image_provider_not_configured')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses the whole run before any money moves when the ceiling will not cover it', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(1990)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('image_spend_ceiling_reached')
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.createHumanTask).toHaveBeenCalledTimes(1)
  })

  it('names every asset a ceiling refusal stopped, because "1 refusal" hides three', async () => {
    // The run-level `'*'` shape this case used to have is what Step 8's
    // integration test contradicts: two pending assets must read back as two
    // named refusals and a human task titled "refused 2 asset(s)".
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(1990)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a', 'b', 'c'])
    const [task] = h.createHumanTask.mock.calls[0] as [{ title: string }]
    expect(task.title).toContain('refused 3 asset(s)')
  })

  it('keeps the refusal prose to ten entries but reports every refusal', async () => {
    // `refusedProse`'s `slice(0, 10)` is the only bound on how much text a run can
    // write into one `human_tasks.body` row (ruling 6d): an artifact of five
    // thousand prompts would otherwise put five thousand sentences in it. Nothing
    // else in this file reaches ten refusals — the largest is three — so the
    // `…and N more.` tail was never executed and never asserted. Eleven is the
    // smallest set that runs the tail, and the tool output must still hold all
    // eleven, because the prose is capped for the queue, not for the owner.
    const names = Array.from({ length: 11 }, (_unused, index) => `asset-${index + 1}`)
    h.getDesignerArtifactText.mockResolvedValue(promptJson(...names))
    h.generate.mockResolvedValue(
      failImage('image_generation_failed', 'replicate rejected the api token (401)', null, true),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused).toHaveLength(11)
    const [task] = h.createHumanTask.mock.calls[0] as [{ body: string }]
    expect(task.body).toContain('\u2026and 1 more.')
    expect(task.body).toContain('asset-1: image_generation_failed')
    expect(task.body).not.toContain('asset-11')
  })

  it('keeps a refusal detail to one sentence when the artifact echoes back at it', async () => {
    // `asset-prompts.ts:47-50` interpolates JSON.stringify(parsed) into the detail,
    // and a designer artifact that is a JSON-encoded long string makes that detail
    // as long as the artifact. This tool writes that string into its own output and
    // into human_tasks.body, so the bound belongs here.
    h.getDesignerArtifactText.mockResolvedValue(JSON.stringify('x'.repeat(5000)))
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('asset_prompts_unparsable')
    expect(result.refused[0]!.detail).toHaveLength(400)
    expect(result.refused[0]!.detail.endsWith('\u2026')).toBe(true)
  })
})

describe('marketing.generate_assets spends', () => {
  it('reads prompts from the stored artifact and never from its arguments', async () => {
    // The input schema has one field, bundleId, so anything reaching the provider
    // must have come out of the artifact row. That is the assertion, and it is the
    // reason the tool cannot be talked into an image the reviewer never read.
    const result = await run({ bundleId: BUNDLE })
    // `as number` because `expect.any` returns `any`, and this repo's lint fails an
    // unsafe assignment. The matcher still asserts "some number"; the seed's value
    // is pinned by the case below, not here.
    expect(h.generate).toHaveBeenCalledWith({
      prompt: 'a prompt for hero-image',
      aspectRatio: '16:9',
      seed: expect.any(Number) as number,
      negativePrompt: null,
    })
    expect(result.assets).toHaveLength(1)
  })

  it('derives the same seed for the same bundle and asset name, twice', async () => {
    await run({ bundleId: BUNDLE })
    const first = h.generate.mock.calls[0]![0] as { seed: number }
    h.generate.mockClear()
    await run({ bundleId: BUNDLE })
    const second = h.generate.mock.calls[0]![0] as { seed: number }
    expect(second.seed).toBe(first.seed)
    expect(Number.isSafeInteger(first.seed)).toBe(true)
  })

  it('attaches through the existing artifact path rather than a second one', async () => {
    await run({ bundleId: BUNDLE })
    expect(h.insertMarketingArtifacts).toHaveBeenCalledWith({
      tenantId: TENANT,
      bundleId: BUNDLE,
      artifacts: [{ role: 'creative-designer', kind: 'image', documentId: DOC, textContent: null }],
    })
  })

  it('records the cost Replicate reported, not the admission estimate', async () => {
    h.generate.mockResolvedValue(okImage('hero-image', 7))
    const result = await run({ bundleId: BUNDLE })
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      documentId: DOC,
      costMinor: 7,
      // Named explicitly by the tool, not left to `image-spend.ts`'s
      // REPLICATE_PROVIDER default: the ledger row and the answer below have to
      // agree about who was paid even when the registered adapter is not Replicate.
      provider: 'replicate',
      rawExtract: {
        predictionId: 'pred-hero-image',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    // The pair the owner reads. `provider` used to be typed in the output schema
    // and asserted nowhere, so a tool that booked every row under the default while
    // answering with `adapter?.provider` passed; these two lines are what close it.
    expect(result.provider).toBe('replicate')
    expect(result.model).toBe('black-forest-labs/flux-1.1-pro')
    expect(result.spentMinor).toBe(7)
    expect(result.assets[0]).toEqual({
      name: 'hero-image',
      documentId: DOC,
      status: 'needs_review',
      deduplicated: false,
      costMinor: 7,
    })
  })

  it('stops at the boundary mid-run and keeps the assets it already made', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    // The pre-flight check admits three images at the 4-minor estimate: 1985 + 12
    // fits a 2000 ceiling. The first prediction then costs 12, so b no longer
    // fits and c is never attempted. The ceiling is enforced against what the
    // provider actually charged, not against what was estimated when the run
    // started, and every asset the stop left behind is reported, not dropped.
    ledger(1985)
    h.generate.mockResolvedValueOnce(okImage('a', 12)).mockResolvedValue(okImage('b'))
    const result = await run({ bundleId: BUNDLE })
    expect(result.assets.map((asset) => asset.name)).toEqual(['a'])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['b', 'c'])
    expect(result.refused[0]!.code).toBe('image_spend_ceiling_reached')
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(result.spentMinor).toBe(12)
  })

  it('spends nothing on a bundle that already carries every asset', async () => {
    // The skip is on the asset name the reviewer reads, which is the document
    // title the attach path wrote: a re-run finds the hero image already on the
    // bundle and never reaches the provider. Spec section 6 idempotency.
    h.listImageAssetStatuses.mockResolvedValue([
      { documentId: DOC, title: 'hero-image', status: 'ready' },
    ])
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.recordImageSpend).not.toHaveBeenCalled()
    expect(h.insertMarketingArtifacts).not.toHaveBeenCalled()
    expect(h.createHumanTask).not.toHaveBeenCalled()
    expect(result.spentMinor).toBe(0)
    expect(result.assets).toEqual([
      { name: 'hero-image', documentId: DOC, status: 'ready', deduplicated: true, costMinor: 0 },
    ])
    expect(result.refused).toHaveLength(0)
  })

  it('attaches a carried asset only when it is not already on the bundle', async () => {
    // Two prompts, one already carried: the run pays for the missing one and
    // reports both, so a partial first run is finishable without re-buying.
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.listImageAssetStatuses.mockResolvedValue([
      { documentId: DOC, title: 'a', status: 'needs_review' },
    ])
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.generate.mock.calls[0]![0]).toMatchObject({ prompt: 'a prompt for b' })
    expect(result.assets.map((asset) => asset.name)).toEqual(['a', 'b'])
    expect(result.assets[0]!.deduplicated).toBe(true)
    expect(result.assets[1]!.deduplicated).toBe(false)
  })

  it('stops the run at a dead token instead of paying forty visits to it', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate.mockResolvedValue(failImage('image_generation_failed', 'replicate rejected the api token (401)', null, true))
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(result.refused[0]!.detail).toContain('token')
    expect(result.refused).toHaveLength(2)
  })

  it('records the spend for a prediction that produced no usable bytes', async () => {
    h.generate.mockResolvedValue(
      failImage('asset_too_large', '16 MB', { predictionId: 'pred-hero-image', costUsd: '0.04', costMinor: 4 }),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      documentId: null,
      costMinor: 4,
      provider: 'replicate',
      // The failed path takes the model name from the adapter, because a charge
      // carries a prediction id and a price but not the model that made it.
      rawExtract: {
        predictionId: 'pred-hero-image',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    expect(result.refused[0]!.code).toBe('asset_too_large')
    expect(result.spentMinor).toBe(4)
  })

  it('invoices a prediction the document lane refused, then stops rather than paying again', async () => {
    // The hole this case closes: `insertAssetDocument` rejects on 0 bytes before it
    // touches the database (src/db/marketing-assets.ts:75) and a real document
    // write can reject for its own reasons, while the money is already gone. With
    // the spend booked after an uncalled-for catch, the rejection escapes `execute`
    // and spec section 9's billed-but-unusable prediction never reaches the ledger.
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate.mockResolvedValue(okImage('a'))
    h.insertAssetDocument.mockRejectedValue(
      new Error('insertAssetDocument: "a" carries 0 bytes, which is not an image'),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      documentId: null,
      costMinor: 4,
      provider: 'replicate',
      rawExtract: {
        predictionId: 'pred-a',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    expect(result.refused.map((refusal) => refusal.code)).toEqual([
      'asset_storing_failed',
      'asset_storing_failed',
    ])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a', 'b'])
    expect(result.spentMinor).toBe(4)
    expect(result.assets).toEqual([])
    expect(h.insertMarketingArtifacts).not.toHaveBeenCalled()
  })

  it('keeps going after one asset fails, so a rate limit never loses the other images', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate
      .mockResolvedValueOnce(failImage('image_generation_failed', 'rate limited', null, false))
      .mockResolvedValueOnce(okImage('b'))
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(2)
    expect(result.assets.map((asset) => asset.name)).toEqual(['b'])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a'])
  })

  it('never marks an image ready, and reports the status the lane gave back', async () => {
    const result = await run({ bundleId: BUNDLE })
    expect(result.assets[0]!.status).toBe('needs_review')
    const insertParams = h.insertAssetDocument.mock.calls[0]![0] as { title: string }
    expect(insertParams.title).toBe('hero-image')
  })
})

describe('marketing.generate_assets stays an auto tool governance can see', () => {
  it('scores its redacted view at benign and gates auto', async () => {
    const result = await run({ bundleId: BUNDLE })
    expect(result.gate).toBe('auto')
    expect(result.riskScore).toBeLessThan(40)
  })

  it('names nothing but identifiers, counts and dollars in its risk view', async () => {
    const { generateAssetsRiskView } = await import('../../src/marketing/payload')
    const view = generateAssetsRiskView({
      bundleId: BUNDLE,
      objective: 'outreach_support',
      assetCount: 3,
      estimatedCostMinor: 12,
    })
    expect(Object.keys(view).sort()).toEqual([
      'assetCount',
      'bundleId',
      'estimatedCostMinor',
      'objective',
    ])
  })
})
```

Three things this file deliberately does not mock, and why: `image-spend`'s arithmetic is imported for real through `importActual`, because the boundary cases are the point of the task; `asset-prompts` is imported for real, because the refusal reasons come from its exact strings; and `governance/policy` is not mocked at all, so the tool's `loadPolicy()` reads the repository `policy/tools.yaml` and Step 6's governance edits are what turn this suite green.

Twenty-four cases, and four of them are the controller's rather than the plan author's, each because a bound or a lane the tool owns had no test: the named-asset ceiling refusal (a run-level refusal must name every pending asset, not one `'*'` row), the 400-character detail bound on a provider message, the invoice for a prediction the document lane refused, and — added by this task's review round — the ten-entry cap on the refusal prose. That last one is the case that keeps `refusedProse`'s `slice(0, 10)` honest: eleven names through a dead-token failure assert `refused.length === 11` while the human-task body carries `…and 1 more.` and stops at `asset-10`. Without it the cap is a number in a file that nothing executes, and the thing it exists to prevent — a 5,000-prompt artifact writing 5,000 sentences into `human_tasks.body` — goes untested.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/marketing/generate-assets-tool.test.ts`
Expected: FAIL — `Cannot find module '../../src/marketing/image-provider'`, then `generateAssetsTool is not exported`.

- [ ] **Step 3: Create the provider seam**

Create `src/marketing/image-provider.ts`.

```ts
// src/marketing/image-provider.ts
/**
 * The one place the marketing tools learn which image provider exists.
 *
 * `src/marketing/replicate.ts` knows how to talk to Replicate. It does not know
 * whether this deployment pays for one, and a tool that imported it directly
 * would make "no token configured" a module-load problem rather than a runtime
 * refusal. This module holds the registration slot, and `src/mastra/index.ts`
 * fills it at boot only when `CRUM_REPLICATE_API_TOKEN` is present, which is the
 * same conditional registration slice 2 built for the Cloudflare adapter and
 * slice 3 for the Meta adapters: an action cannot be taken until it can be
 * executed.
 *
 * The adapter also carries the four numbers that bound a run — the daily
 * ceiling, the per-image estimate used for admission, and the byte ceiling — so
 * the tool never reads `process.env` itself. `src/marketing/replicate.ts`'s file
 * comment says the same thing about its own config for the same reason.
 */
import { DEFAULT_REPLICATE_MODEL, generateImage } from './replicate'
import type { ImageOutcome, ImageRequest } from './replicate'
import { REPLICATE_PROVIDER } from './image-spend'

export interface ImageAdapter {
  provider: string
  model: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  generate(request: ImageRequest): Promise<ImageOutcome>
}

export interface ReplicateAdapterParams {
  apiToken: string
  model?: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  fetchImpl?: typeof fetch
}

export function makeReplicateAdapter(params: ReplicateAdapterParams): ImageAdapter {
  const model = params.model ?? DEFAULT_REPLICATE_MODEL
  return {
    // The constant, not a fresh literal: `src/marketing/image-spend.ts:9` already
    // spells this string and writes it into every ledger row, and two copies of a
    // provider name is how a report ends up counting one provider as two.
    provider: REPLICATE_PROVIDER,
    model,
    ceilingMinor: params.ceilingMinor,
    costMinorPerImage: params.costMinorPerImage,
    maxBytes: params.maxBytes,
    generate: (request) =>
      generateImage(request, {
        apiToken: params.apiToken,
        model,
        maxBytes: params.maxBytes,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }),
  }
}

/**
 * One adapter per process, last write wins.
 *
 * `createCrumMastra` runs per request in the Hono lane (slice 2's conditional
 * adapter registration hit exactly this), so a registration that refused a
 * second write would throw on the second request of every day. An overwrite is
 * safe because the only inputs are the same environment variables.
 */
let current: ImageAdapter | null = null

export function setImageAdapter(adapter: ImageAdapter | null): void {
  current = adapter
}

export function getImageAdapter(): ImageAdapter | null {
  return current
}
```

`DEFAULT_REPLICATE_MODEL` is Task 3's export, and `generateImage` falls back to the same constant when `config.model` is absent. Passing it explicitly here is not redundancy: the adapter's own `model` field is what the tool writes into `raw_extract` and into its result, so the string the ledger records has to be the string the request carried, and reading the fallback twice is how that stays true if the default ever moves.

- [ ] **Step 4: Add the redacted risk view**

Modify `src/marketing/payload.ts`, adding this immediately after `saveRiskView` (line 23) and its interface. `saveRiskView` is the pattern to follow: a named view of the payload whose keys are the only thing the scorer ever sees.

```ts
export interface GenerateAssetsRiskView {
  bundleId: string
  objective: string
  assetCount: number
  estimatedCostMinor: number
}

/**
 * The scored view of an image run: one id, one literal, two numbers.
 *
 * This tool is `auto`, and `gateFor` can only raise a declared class
 * (src/governance/policy.ts:118-125), so a single prose field here would move
 * every paid run into `approval` and then be refused by the drift guard below
 * the call in `marketing-writes.ts` — the run would stop, quietly, the first
 * time a designer wrote "portrait of the founder". The cost is a number, and
 * `estimatedCostMinor` is the estimate the ceiling check used, so the number a
 * reviewer would react to is the number that admitted the run.
 */
export function generateAssetsRiskView(input: GenerateAssetsRiskView): Record<string, unknown> {
  return {
    bundleId: input.bundleId,
    objective: input.objective,
    assetCount: input.assetCount,
    estimatedCostMinor: input.estimatedCostMinor,
  }
}
```

- [ ] **Step 5: Write the tool**

Append to `src/mastra/tools/marketing-writes.ts`, after `retryPublishTool`, and add these imports to the file's import block at the top (lines 1-39):

```ts
import {
  getDesignerArtifactText,
  insertAssetDocument,
  listImageAssetStatuses,
} from '../../db/marketing-assets'
import { parseAssetPrompts } from '../../marketing/asset-prompts'
import { getImageAdapter } from '../../marketing/image-provider'
import { admitsRun, committedSpendMinor, recordImageSpend } from '../../marketing/image-spend'
import { generateAssetsRiskView } from '../../marketing/payload'
import { createHash } from 'node:crypto'
```

`marketing-writes.ts` does not import `node:crypto` today and there is no exported `sha256Hex` in this repository — `src/marketing/hash.ts:39` and five other call sites each write `createHash('sha256').update(x).digest('hex')` inline. Follow that idiom: the `node:crypto` import above is the file's first, and the seed function below is the only place in this tool that needs it. Do not add a sixth helper module for one line.

Then append the tool. Every branch below is one of the tests in Step 1; the refusal chain order is spec section 6's numbered list, and the two early returns exist so that a run which cannot start never reaches the ceiling arithmetic or the provider.

```ts
/**
 * The codes this tool can put in `refused[].code`, in the order the refusal chain
 * reaches them: run-level `not_found`, `bundle_not_generable`,
 * `image_provider_not_configured`, `no_asset_prompts`, `asset_prompts_unparsable`,
 * `image_spend_ceiling_reached`, `policy_gate_raised`; per-asset
 * `image_generation_failed`, `image_generation_timeout`, `asset_too_large`,
 * `prompt_too_long`, `unsupported_aspect_ratio` (the five `ImageFailureCode` values
 * `src/marketing/replicate.ts:26-31` can answer with, carried through verbatim) and
 * `asset_storing_failed`.
 *
 * The adapter check (`getImageAdapter()`) comes before the artifact read
 * (`getDesignerArtifactText`) on purpose, so a run with no adapter
 * registered and an unparsable artifact answers `image_provider_not_configured`,
 * not `asset_prompts_unparsable`: the adapter is the cheaper of the two questions
 * and it is the one that decides whether any request could leave at all. Both
 * refusals bail before a cent is spent, so the order costs nothing but the code,
 * which is why it is not reordered.
 *
 * This is a comment and not a `const`, for two reasons an implementer would
 * otherwise hit in Step 7: a module-scope `const` nothing reads is a
 * `no-unused-vars` error in this repo, and the first draft of this list named only
 * two of the five adapter codes, so any list-shaped assertion would have been
 * wrong. Task 13's console groups by code and cannot import across its package
 * boundary, so no consumer of an array here exists to keep it honest.
 */

// A bundle someone already shipped or already threw away is not a bundle to buy
// art for. Everything else in the enum (draft, staged, approved, publishing,
// failed) is a bundle whose asset set is still live work.
const NOT_GENERABLE_STATUSES = new Set(['live', 'archived'])

const GenerateAssetsOutputSchema = z.object({
  bundleId: z.string().uuid(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        documentId: z.string().uuid(),
        status: z.string(),
        deduplicated: z.boolean(),
        costMinor: z.number().int().min(0),
      }),
    )
    .default([]),
  refused: z
    .array(z.object({ name: z.string(), code: z.string(), detail: z.string() }))
    .default([]),
  spentMinor: z.number().int().min(0),
  // Null on a run that never found an adapter, which is the one refusal that
  // happens before the provider is even named.
  provider: z.string().nullable(),
  model: z.string().nullable(),
  humanTaskId: z.string().uuid().nullable(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval', 'refuse']),
  message: z.string(),
})

/**
 * The seed is a function of the bundle and the asset name, not of the clock.
 *
 * Spec section 6's idempotency claim depends on it: a re-run has to produce
 * byte-identical output for the sha256 dedup to reuse the row it already paid
 * for, and a random seed makes every run a fresh purchase. Eight hex digits
 * masked under 2^31 stays exactly representable through `parseInt`, so the
 * number Replicate sees is the number this line computed.
 */
function seedFor(bundleId: string, assetName: string): number {
  const hex = createHash('sha256').update(`${bundleId}\u0000${assetName}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16) % 2147483647
}

/**
 * A refusal detail is owner-facing copy: it goes into the tool output the model
 * reads and into `human_tasks.body`, where it is joined with every other detail in
 * the run. Task 5's parser is the reason this bound exists —
 * `src/marketing/asset-prompts.ts:49` interpolates `JSON.stringify(parsed)`, so a
 * designer artifact that is a 2 MB JSON array produces a 2 MB refusal string, and
 * the parked finding at the end of Task 5's review named this layer as the one that
 * owns message length. The adapter's own `detail` is the other lane: it carries
 * provider prose. Every `detail:` built from text this tool did not write passes
 * through here; the template literals in between interpolate only ids, statuses and
 * numbers.
 */
const DETAIL_LIMIT = 400

function boundedDetail(detail: string): string {
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT - 1)}\u2026`
}

/**
 * The prose half of a human task. The tool output keeps every refusal — an owner
 * deciding what the bundle is missing reads that list — but `human_tasks.body` is
 * one line in a queue, and `pending.length` is bounded only by the document ceiling
 * the designer's artifact was written under. Without this, a bundle whose artifact
 * is a 5,000-prompt array writes 5,000 sentences into one row.
 */
function refusedProse(entries: Array<{ name: string; code: string; detail: string }>): string {
  const shown = entries.slice(0, 10).map((entry) => `${entry.name}: ${entry.code}: ${entry.detail}`)
  const more = entries.length - shown.length
  return more > 0 ? `${shown.join(' ')} \u2026and ${more} more.` : shown.join(' ')
}

export const generateAssetsTool = createTool({
  id: 'marketing.generate_assets',
  title: 'Generate Campaign Images',
  description:
    'Turn the creative designer\u2019s stored asset prompts into images through the configured image provider. Writes documents and spends from the daily image budget. Takes no prompts: it reads only what the bundle already holds.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ bundleId: z.string().uuid() }),
  outputSchema: GenerateAssetsOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) => {
    return context.observe.span('marketing.generate_assets', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }

      const assets: Array<{
        name: string
        documentId: string
        status: string
        deduplicated: boolean
        costMinor: number
      }> = []
      const refused: Array<{ name: string; code: string; detail: string }> = []
      let spentMinor = 0

      const bundle = await getMarketingBundle(rc.tenantId, input.bundleId)
      if (bundle === null) {
        refused.push({ name: '*', code: 'not_found', detail: `No bundle ${input.bundleId} in this tenant.` })
      } else if (NOT_GENERABLE_STATUSES.has(bundle.status)) {
        refused.push({
          name: '*',
          code: 'bundle_not_generable',
          detail: `Bundle ${bundle.id} is ${bundle.status}; images are not bought for a campaign already shipped or archived.`,
        })
      }

      const adapter = refused.length === 0 ? getImageAdapter() : null
      if (refused.length === 0 && adapter === null) {
        refused.push({
          name: '*',
          code: 'image_provider_not_configured',
          detail: 'No image adapter is registered, so CRUM_REPLICATE_API_TOKEN is unset. Nothing was requested and nothing was spent.',
        })
      }

      let prompts: AssetPrompt[] = []
      if (refused.length === 0 && adapter !== null && bundle !== null) {
        const stored = await getDesignerArtifactText(rc.tenantId, bundle.id)
        const parsed = parseAssetPrompts(stored)
        if (!parsed.ok) {
          refused.push({ name: '*', code: parsed.reason, detail: boundedDetail(parsed.detail) })
        } else {
          prompts = parsed.prompts
        }
      }

      // The carry check is the whole idempotency story: an asset the bundle
      // already attaches under this name is reported from the row that exists
      // and never re-ordered. Titles are the asset names the designer wrote and
      // the reviewer reads, so this is the same identity, not a second one.
      const carried = new Map<string, { documentId: string; status: string }>()
      if (refused.length === 0 && prompts.length > 0 && bundle !== null) {
        for (const row of await listImageAssetStatuses(rc.tenantId, bundle.id)) {
          carried.set(row.title, { documentId: row.documentId, status: row.status })
        }
      }

      const pending: AssetPrompt[] = []
      for (const entry of prompts) {
        const existing = carried.get(entry.name)
        if (existing) {
          assets.push({
            name: entry.name,
            documentId: existing.documentId,
            status: existing.status,
            deduplicated: true,
            costMinor: 0,
          })
        } else {
          pending.push(entry)
        }
      }

      const policy = loadPolicy()
      const estimatedCostMinor = pending.length * (adapter?.costMinorPerImage ?? 0)
      const assessment = scoreRisk(
        generateAssetsRiskView({
          bundleId: input.bundleId,
          objective: bundle?.objective ?? 'outreach_support',
          assetCount: pending.length,
          estimatedCostMinor,
        }),
        policy.risk,
        'marketing.generate_assets',
      )
      const gate = policy.gateFor('marketing.generate_assets', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      // Unreachable while the declared class stays `auto`, and the reason it is
      // here is the reason saveBundleTool's identical branch is here
      // (src/mastra/tools/marketing-writes.ts:231-244): if somebody raises the
      // class in policy/tools.yaml, this tool must stop buying pictures rather
      // than carry on auto-committing what governance now calls an approval.
      if (refused.length === 0 && gate !== 'auto' && pending.length > 0) {
        refused.push({
          name: '*',
          code: 'policy_gate_raised',
          detail: `Governance now gates marketing.generate_assets at "${gate}". A run that costs money is not an unreviewed write.`,
        })
      }

      // A run with nothing pending has nothing to buy, so it never reaches the
      // ceiling check: admitsRun is false for an empty count by design (Task 4),
      // and a fully-carried bundle is a success, not a refusal.
      let committedMinor = 0
      if (refused.length === 0 && pending.length > 0 && adapter !== null) {
        committedMinor = await committedSpendMinor(rc.tenantId)
        if (
          !admitsRun({
            ceilingMinor: adapter.ceilingMinor,
            committedMinor,
            costMinorPerImage: adapter.costMinorPerImage,
            assetCount: pending.length,
          })
        ) {
          // One refusal per pending asset, not one `'*'` for the whole run. Two
          // reasons, and they point the same way: the mid-loop boundary refusal
          // below already names every asset left in the queue, because an owner
          // reading the human task has to be able to tell what the bundle is
          // missing; and Step 8's integration case reads `refused.map(r => r.code)`
          // as two `image_spend_ceiling_reached` entries under a human task titled
          // "refused 2 asset(s)". A run-level `'*'` here writes one entry and titles
          // it "1", so the plan's two halves disagreed with each other.
          for (const entry of pending) {
            refused.push({
              name: entry.name,
              code: 'image_spend_ceiling_reached',
              detail:
                `Not attempted: today's image spend is ${committedMinor} minor with a ${adapter.ceilingMinor} ceiling, ` +
                `and ${pending.length} asset(s) at ${adapter.costMinorPerImage} minor each need ${estimatedCostMinor}. ` +
                'Raise CRUM_IMAGE_SPEND_CEILING_MINOR or run tomorrow. Nothing was requested.',
            })
          }
        }
      }

      const attached: ArtifactInput[] = []
      if (refused.length === 0 && bundle !== null && adapter !== null) {
        for (let index = 0; index < pending.length; index += 1) {
          const entry = pending[index]!
          const nowCommitted = await committedSpendMinor(rc.tenantId)
          if (
            !admitsRun({
              ceilingMinor: adapter.ceilingMinor,
              committedMinor: nowCommitted,
              costMinorPerImage: adapter.costMinorPerImage,
              assetCount: 1,
            })
          ) {
            // The boundary moved under the run, because what the provider
            // charged exceeded the estimate that admitted it. Every asset left
            // in the queue is reported as refused: an owner reading the human
            // task has to be able to tell what the bundle is missing.
            for (const stopped of pending.slice(index)) {
              refused.push({
                name: stopped.name,
                code: 'image_spend_ceiling_reached',
                detail: `Not attempted: today's spend reached ${nowCommitted} of a ${adapter.ceilingMinor} minor ceiling.`,
              })
            }
            break
          }

          const seed = seedFor(bundle.id, entry.name)
          const outcome = await adapter.generate({
            prompt: entry.prompt,
            aspectRatio: entry.aspectRatio,
            seed,
            negativePrompt: entry.negativePrompt,
          })

          if (!outcome.ok) {
            if (outcome.charge !== null) {
              await recordImageSpend({
                tenantId: rc.tenantId,
                documentId: null,
                costMinor: outcome.charge.costMinor,
                // Named, not left to image-spend.ts's default. That default is
                // REPLICATE_PROVIDER, so omitting it would book a row saying
                // 'replicate' while this run's output reports `adapter.provider`
                // in its own return — the ledger and the answer disagreeing for
                // any adapter that is not Replicate.
                provider: adapter.provider,
                rawExtract: {
                  predictionId: outcome.charge.predictionId,
                  model: adapter.model,
                  costUsd: outcome.charge.costUsd,
                },
              })
              spentMinor += outcome.charge.costMinor
            }
            refused.push({ name: entry.name, code: outcome.code, detail: boundedDetail(outcome.detail) })
            if (outcome.deadToken) {
              for (const stopped of pending.slice(index + 1)) {
                refused.push({
                  name: stopped.name,
                  code: 'image_generation_failed',
                  detail: 'Not attempted: the provider rejected the API token, so the run stopped rather than paying forty visits to a dead credential.',
                })
              }
              break
            }
            continue
          }

          // The provider has already been charged by the time this line runs, and
          // `insertAssetDocument` rejects before it touches the database when the
          // bytes handed to it are 0 long (`src/db/marketing-assets.ts:75`), while
          // any real document write can reject too. The first draft of this tool
          // booked the spend *after* the insert with nothing around it, so such a
          // rejection escaped `execute`: no ledger row for money already spent, no
          // human task, and a tool error as the only trace. Spec section 9's
          // "money spent, nothing usable" case is the one that must still be
          // invoiced, and `src/marketing/image-spend.ts:65-69` already says an
          // invoice for an image we failed to save is a real cost.
          //
          // The run stops here rather than continuing to the next asset, for the
          // same reason a 401 stops it above: a lane that refuses one image is
          // refusing them all, and each remaining asset would buy a prediction CRUM
          // cannot store. `asset_storing_failed` is deterministic per adapter
          // output, so nothing is lost by stopping — the next run reuses the bytes
          // it already has and re-orders only what is genuinely missing.
          let document: { id: string; status: string; deduplicated: boolean }
          try {
            document = await insertAssetDocument({
              tenantId: rc.tenantId,
              ownerId: rc.userId,
              title: entry.name,
              bytes: outcome.image.bytes,
              mime: outcome.image.mime,
              provenance: {
                replicateId: outcome.image.predictionId,
                model: outcome.image.model,
                aspectRatio: outcome.image.aspectRatio,
                negativePrompt: entry.negativePrompt,
                costMinor: outcome.image.costMinor,
                seed,
                prompt: entry.prompt,
              },
            })
          } catch (err) {
            // Not wrapped, on purpose: a ledger write that cannot be made is the
            // tool failing loudly, which is Task 4's fail-closed ruling. Defaulting
            // it would silently un-invoice the run.
            await recordImageSpend({
              tenantId: rc.tenantId,
              documentId: null,
              costMinor: outcome.image.costMinor,
              provider: adapter.provider,
              rawExtract: {
                predictionId: outcome.image.predictionId,
                model: outcome.image.model,
                costUsd: outcome.image.costUsd,
              },
            })
            spentMinor += outcome.image.costMinor
            refused.push({
              name: entry.name,
              code: 'asset_storing_failed',
              detail: boundedDetail(err instanceof Error ? err.message : String(err)),
            })
            for (const stopped of pending.slice(index + 1)) {
              refused.push({
                name: stopped.name,
                code: 'asset_storing_failed',
                detail: 'Not attempted: the document lane refused the previous image, so the run stopped rather than paying for pictures CRUM cannot store.',
              })
            }
            break
          }

          // Booked after the insert and pointing at the row the insert returned,
          // so a re-run that reused the bytes still books the prediction that
          // cost money to make. The ledger is what the day cost, not what the
          // bundle gained.
          await recordImageSpend({
            tenantId: rc.tenantId,
            documentId: document.id,
            costMinor: outcome.image.costMinor,
            provider: adapter.provider,
            rawExtract: {
              predictionId: outcome.image.predictionId,
              model: outcome.image.model,
              costUsd: outcome.image.costUsd,
            },
          })
          spentMinor += outcome.image.costMinor

          assets.push({
            name: entry.name,
            documentId: document.id,
            status: document.status,
            deduplicated: document.deduplicated,
            costMinor: outcome.image.costMinor,
          })
          attached.push({
            role: 'creative-designer',
            kind: 'image',
            documentId: document.id,
            textContent: null,
          })
        }
      }

      if (attached.length > 0 && bundle !== null) {
        await insertMarketingArtifacts({
          tenantId: rc.tenantId,
          bundleId: bundle.id,
          artifacts: attached,
        })
      }

      let humanTaskId: string | null = null
      if (refused.length > 0 && bundle !== null) {
        const codes = Array.from(new Set(refused.map((entry) => entry.code))).join(', ')
        humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `assets:${bundle.id}`,
            toolName: 'marketing.generate_assets',
            riskScore: assessment.score,
            title: `Image run for bundle ${bundle.id} refused ${refused.length} asset(s)`,
            body:
              `Refused codes: ${codes}. Newly stored: ${attached.length}. Reused from the bundle: ${assets.length - attached.length}. ` +
              `Recorded spend: ${spentMinor} minor. ${refusedProse(refused)}`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
      }

      // One path leaves `bundle` null: the `not_found` refusal above. It always
      // fills `refused`, so a run with no row to name is a run that bought nothing
      // because there was nothing to buy — and a refusal message that interpolates
      // `bundle.id` on its way to saying so throws instead of saying it. The id the
      // caller asked for is the id worth naming when there is no row, and it is the
      // same expression the `bundleId` field below returns, hoisted here so the
      // prose and the field cannot drift apart.
      const bundleLabel = bundle?.id ?? input.bundleId

      // The human-task block above is guarded by `bundle !== null`, so the
      // `not_found` run files no task at all. Prose that promised one would be
      // this tool telling an owner it parked something it never parked, so the
      // sentence follows `humanTaskId` rather than the refusal.
      const taskSentence =
        humanTaskId === null
          ? ' No human task was created because there is no bundle row to file one against.'
          : ' A human task was created.'

      const message =
        refused.length === 0
          ? `Stored ${attached.length} new image(s) for bundle ${bundleLabel}, reused ${assets.length - attached.length}, recorded ${spentMinor} minor of image spend. Each new image is needs_review until you review it.`
          : `Refused ${refused.length} asset(s) for bundle ${bundleLabel} (${Array.from(new Set(refused.map((entry) => entry.code))).join(', ')}). Stored ${attached.length}, recorded ${spentMinor} minor.${taskSentence}`

      return {
        bundleId: bundleLabel,
        assets,
        refused,
        spentMinor,
        provider: adapter?.provider ?? null,
        model: adapter?.model ?? null,
        humanTaskId,
        riskScore: assessment.score,
        gate,
        message,
      }
    })
  },
})
```

Three notes an implementer should not have to rediscover. `AssetPrompt` is a type-only import: add `import type { AssetPrompt } from '../../marketing/asset-prompts'` beside the value import, because `pending` is declared against it. The `role: 'creative-designer'` literal has to type-check against `MarketingRole`, which it does, and `kind: 'image'` against `MarketingArtifactKind`, which it does (migration 0018 admits `image`, and an image's `document_id` is required by that same CHECK — which is why `attached` is only ever built from a row `insertAssetDocument` just returned). And nothing here opens a transaction: `insertAssetDocument`, `recordImageSpend` and `insertMarketingArtifacts` each take their own connection, and the external HTTP call already happened inside `adapter.generate`, so the standing rule that no provider call sits inside a SQL transaction is met by construction rather than by a comment.

The `name: '*'` refusals are run-level, and the asterisk says so: there is no asset whose name could be given, because the whole run was refused. The per-asset refusals carry the designer's own name. The Step 1 tests read `refused[0].code` in both lanes, and the console in Task 13 groups by code.

- [ ] **Step 6: Move the whole tool surface, in this same commit**

Six files declare the tool set, and `npm run test:policy` fails unless they all move together. Each edit is one line or one entry.

`policy/tools.yaml`, inserted immediately above the `# ── approval (13)` header at line 184, after the `marketing.save_bundle` row:

```yaml
  - name: marketing.generate_assets
    description: Turn the designer's stored asset prompts into images within the daily image budget.
    scope: marketing:assets
    class: auto
    idempotent: true
    idempotency_key: draftHash
```

`draftHash` and not a coined key, because `src/governance/schema.ts:9` restricts `idempotency_key` to `correlationId`, `draftHash`, `actionHash`, `siteHash` and `actionId`, and an unknown value is a policy-load failure that takes the boot with it. `draftHash` reads as a stretch for a tool that opens no draft, and it is the right choice anyway: the declaration says "re-running this with the same content is the same action", which is exactly what the deterministic seed and the byte dedup make true.

Still in `policy/tools.yaml`, line 141 carries the section header `  # ── auto (6) ─…` above the six auto entries, with `marketing.save_bundle` as the last of them. This declaration makes seven, so change the digit to `7` in the same commit and touch nothing else on the line: the header is a manual comment, the loader never parses it, and `(6)` and `(7)` are the same width, so the dash rule stays aligned by construction. Nothing in `npm run test:policy` catches a stale count, which is exactly why it goes in this commit rather than "later" — a comment that is wrong and unenforced is worse than no comment, because it is read as authority.

Leave the `# ── approval (13)` header on line 184 reading 13. It is already stale — `tests/governance/policy.test.ts:70` counts fourteen approval tools — and that drift is slice 3's, not this task's. An unrequested fix there widens this commit for no test, and the one number this slice moves is the one it must move alone.

`src/mastra/processors/write-claim-guard.ts`, in `MUTATING_TOOL_IDS` after `'marketing.save_bundle'`:

```ts
  'marketing.generate_assets',
```

Do not touch `WRITE_VERB` on line 31. The tool's own `message` says "Stored" and "recorded", both already in that alternation, which is deliberate: widening the regex to admit "generated" would make every agent sentence containing that past participle a claimed write, and the guard's whole value is that it fires on a small set of verbs it can name.

`tests/mastra/processors/write-claim-guard.test.ts` has the same number problem in the other direction, and it is this commit's to fix. The case titled "lists every write tool by registry id" ends with `expect(MUTATING_TOOL_IDS).toHaveLength(14)` on line 52 while the set this edit grows to sixteen, and its `toContain` list above never names `marketing.set_campaign_status` or `marketing.generate_assets`. So: 14 becomes 16, and add the two rows. The count was already wrong at 15 before this task (slice 3's `set_campaign_status` moved the array and left the number behind), which is a fact for the report, not a reason to leave it wrong — a commit that moves a set owns the assertion that counts it, exactly as `agent.test.ts` and `active-tools.test.ts` do above. Name both ids in the `toContain` list rather than trusting the count alone: a number says how many entries exist, and only the rows say whether the two that a reviewer would look for are among them.

`src/mastra/agent.ts`: add `generateAssetsTool` to the `marketing-writes` import on line 36, and one entry as the last key of `crumToolRegistry`, after `'marketing.retry_publish': retryPublishTool,` on line 88:

```ts
  'marketing.generate_assets': generateAssetsTool,
```

Two spaces, not four: `crumToolRegistry` is a top-level object, and the four marketing entries on lines 85 to 88 are its last keys. `crmAssistant` passes that object as `tools` and filters it per run through `defaultOptions` and `resolveActiveTools`, so a tool that is declared in `policy/tools.yaml` but absent here is a tool the model can never call.

`tests/mastra/agent.test.ts`: the case at lines 51 to 53 counts this same static registry (`Object.keys(tools).length).toBe(40)`, titled "has 40 tools configured (22 read + 6 auto + 12 approval)"). Both numbers move: 40 becomes 41 and the title's `6 auto` becomes `7 auto`. This file is on disk today and passes today, so it is not optional.

`tests/governance/conformance.test.ts`: one row in `SPEC_TOOL_SURFACE` after the `marketing.save_bundle` row, and the test title's "forty-two" becomes "forty-three".

```ts
  ['marketing.generate_assets', 'auto', 'draftHash'],
```

`tests/governance/policy.test.ts`: line 57's declared-tool count 43 becomes 44, and line 69's `auto` count 6 becomes 7.

`tests/mastra/active-tools.test.ts` has seven places that say the old numbers, and all seven move in this edit. Line 44 is `'marketing.save_bundle',`, the last entry of `AUTO_TOOLS`; add `'marketing.generate_assets',` under it. Line 70 is `const USER_EXPECTED = [...READ_ONLY_TOOLS, ...AUTO_TOOLS] // 28` and line 71 is the `ADMIN_EXPECTED` twin ending `// 41` — both are derived from `AUTO_TOOLS`, so those two trailing comments are the only text in them that is a literal number. Then line 74's title `gives a non-admin the read-only + auto tools (28)`, line 76's `expect(active).toHaveLength(28)`, line 80's title `gives an admin the approval-class writes too (41)`, line 82's `toHaveLength(41)`, and line 142's `expect(providerNames).toHaveLength(41)` inside "leaves no dotted id in the list the agent hands the model". 28 becomes 29 and 41 becomes 42 in all seven. The titles and the assertions agree today, so a title left at 28 beside a `toHaveLength(29)` is not a stale comment surviving a correct edit — it is a wrong title in a passing suite, which is how a future reader learns that the number is decorative.

`docs/TECHNICAL_PLAN.md` section 4.6.2: one table row for `marketing.generate_assets`, `auto`, with its scope and idempotency key.

`tests/governance/marketing-payload.test.ts`: extend the existing sweep rather than adding a file. Add a case beside the one at line 84 that pushes `generateAssetsRiskView` through `forbiddenTermsIn` and expects `[]`, and a second that asserts `scoreRisk` of the same view lands on `risk.preflight.scores.benign`. The strings that would break it are the refusal code literals and the message text, and neither reaches the scorer — the view is four keys, which is the Step 1 test at the end of this task's file.

- [ ] **Step 7: Run everything this task owns**

Run: `npx vitest run tests/marketing/generate-assets-tool.test.ts tests/governance/marketing-payload.test.ts tests/governance/conformance.test.ts tests/governance/policy.test.ts tests/mastra/active-tools.test.ts tests/mastra/agent.test.ts tests/mastra/processors/write-claim-guard.test.ts`
Expected: PASS, all of it. Seven files, and the last three are the ones that count: `active-tools.test.ts` counts what a role can reach, `agent.test.ts` counts what is in the registry, and `write-claim-guard.test.ts` counts what the outbox guard treats as a write. This task adds one tool to all three. If any of them fails on a number after Step 6, the number moved and the assertion did not.

Run: `npm run typecheck && npm run lint`
Expected: clean. The usual first failure here is `AssetPrompt` imported as a value; it is a type-only import.

- [ ] **Step 8: Prove the paid lane's database half against real constraints**

The Step 1 suite mocks every `src/db` call, which is what makes 24 cases affordable. What it cannot see is a CHECK constraint: `marketing_artifacts` requires a `document_id` on an `image` row, `documents.kind` admits `marketing_asset` only after migration 0021, and `marketing_image_spend.document_id` is nullable by design. Create `tests/integration/marketing-generate-assets.test.ts`, following `tests/integration/marketing-bundle.test.ts` for the env, context and skip conventions. Two conventions from the plan-wide Integration-cluster rule bind this file and were both missed on the first pass, so they are stated here rather than left to inference: it calls `migrate(pool)` in its own `beforeAll`, because a file that assumes a sibling left the shared cluster migrated passes today and dies on a fresh database with `relation "marketing_image_spend" does not exist`; and it cannot get three bundles by calling `saveBundleTool` three times with the same payload, because `computeBundleHash` covers `input.brief` and identical payloads collapse to one content-addressed bundle — the brief varies per case instead. The file:

```ts
// tests/integration/marketing-generate-assets.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient, getDbClient } from '../../src/db/client'
import { generateAssetsTool, saveBundleTool } from '../../src/mastra/tools/marketing-writes'
import { setImageAdapter, type ImageAdapter } from '../../src/marketing/image-provider'
import { committedSpendMinor } from '../../src/marketing/image-spend'

/**
 * The paid lane without the payment. The adapter is a stub that returns two
 * distinct PNGs, so nothing here reaches a network and no provider is ever
 * billed; what this file buys is the proof that the rows the tool writes satisfy
 * the constraints the mock suite cannot see. Spec section 12 keeps provider bytes
 * for the manual walkthrough, and this file stays inside that rule on purpose:
 * it tests the database half, not the HTTP half.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'

let pool: Pool

const TENANT = 'a1000000-0000-4000-8000-000000000021'
const USER = 'a2000000-0000-4000-8000-000000000021'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])

const promptsAskedFor: string[] = []

function stubAdapter(ceilingMinor = 40): ImageAdapter {
  return {
    provider: 'stub',
    model: 'stub/flux-1.1-pro',
    ceilingMinor,
    costMinorPerImage: 4,
    maxBytes: 1024,
    // Not `async`: this repo's lint fails an async method with no `await` in it,
    // and the adapter contract is a promise, which `Promise.resolve` hands back.
    generate(request) {
      promptsAskedFor.push(request.prompt)
      // Derived from the prompt, not from a call counter. A counter makes the bytes
      // depend on how many cases ran first — case two's re-order would then hand
      // both assets the same PNG and one of them would dedup against the other
      // inside a single run — and an integration file that only passes in one
      // order is a file that cannot be re-run.
      const bytes = request.prompt.includes('reception') ? PNG_A : PNG_B
      return Promise.resolve({
        ok: true,
        image: {
          predictionId: `pred-${promptsAskedFor.length}`,
          costUsd: '0.04',
          costMinor: 4,
          mime: 'image/png',
          bytes,
          sizeBytes: bytes.byteLength,
          model: 'stub/flux-1.1-pro',
          aspectRatio: request.aspectRatio,
        },
      })
    },
  }
}

const ASSET_TEXT = JSON.stringify({
  assets: [
    {
      name: 'hero-image',
      prompt: 'a physio clinic reception at dawn, warm light, no people',
      aspectRatio: '16:9',
      negativePrompt: 'watermark',
    },
    {
      name: 'wall-art',
      prompt: 'a framed movement chart on a clinic wall',
      aspectRatio: '1:1',
      negativePrompt: null,
    },
  ],
})

// One bundle per case, named by `tag`. `saveBundleTool` is content-addressed:
// `computeBundleHash` covers the `brief` column (src/mastra/tools/marketing-writes.ts:189-200)
// and the draft is keyed `bundle:${draftHash}`, so three saves of one identical
// payload are three names for the SAME bundle. Left identical, case two would find
// case one's two titles already attached, pay nothing on what it calls its first
// pass, and case three would refuse nothing because nothing is pending. The tag is
// the only thing that differs, so each case buys and re-reads a bundle of its own.
async function saveDesignerBundle(tag: string) {
  const saved = (await saveBundleTool.execute!(
    {
      brief: `Book more physio assessments in Melbourne for owner-led clinics (${tag})`,
      objective: 'outreach_support',
      audienceNote: 'owner-led clinics with 2 to 8 staff',
      strategy: { position: 'the clinic that answers within an hour' },
      copy: { hooks: ['Your next patient is already searching'] },
      mediaPlan: null,
      funnelPlan: null,
      analysis: null,
      promptVersion: 'marketing-v1',
      artifacts: [
        { role: 'creative-designer', kind: 'script', documentId: null, textContent: ASSET_TEXT },
      ],
    } as never,
    context,
  )) as { bundleId: string }
  return saved.bundleId
}

async function generate(bundleId: string) {
  return (await generateAssetsTool.execute!({ bundleId }, context)) as {
    assets: Array<{ name: string; documentId: string | null; deduplicated: boolean; costMinor: number }>
    refused: Array<{ name: string; code: string }>
    spentMinor: number
    humanTaskId: string | null
    gate: string
  }
}

// `T extends QueryResultRow` because `getDbClient()` hands back a pg `Pool` and
// `Pool.query<T>` constrains `T` to `QueryResultRow`; the bound is what lets the
// row shapes below stay literal instead of degenerating to `Record<string, unknown>`.
async function rows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await getDbClient().query<T>(sql, params)).rows
}

beforeAll(async () => {
  if (url === '') return
  // The convention of the other integration files (marketing-image-spend.ts:38-41,
  // marketing-assets-migration.ts:27-30, and seven more): a file that needs the
  // schema applies it itself instead of borrowing the state another file left
  // behind. `migrate` is idempotent — it tracks applied versions in its own table
  // — so on an already-migrated cluster this is one extra SELECT, and on a fresh
  // one it is the reason the DELETE below finds `marketing_image_spend` at all.
  // Without it this file only passes after some other integration file has run.
  pool = new Pool({ connectionString: url, max: 2 })
  await migrate(pool)
  // Same habit as `tests/integration/marketing-bundle.test.ts:87-101`: this tenant
  // is private to this file, and the file must be re-runnable. Without the reset,
  // run two finds run one's hashes, its ledger, and its artifact rows, and the very
  // first assertion (`committedSpendMinor` is 8) reads 16 and fails for a reason
  // that has nothing to do with the code under test. `documents` cascades
  // `document_files` (0009:55) and the parse tables; `marketing_artifacts.document_id`
  // references documents WITHOUT a cascade (0018:65), so artifacts go before the
  // rows they point at; and `marketing_image_spend.document_id` has no foreign key
  // at all (0021:35), so only its own tenant filter clears it.
  const db = getDbClient()
  await db.query('DELETE FROM marketing_image_spend WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM marketing_artifacts WHERE tenant_id = $1', [TENANT])
  await db.query("DELETE FROM documents WHERE tenant_id = $1 AND kind = 'marketing_asset'", [TENANT])
  await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM human_tasks WHERE tenant_id = $1', [TENANT])
  // `pending_writes` and its receipts are in the reset too, or the second run of
  // this file cannot start: the draft is content-addressed as well, so a leftover
  // committed row makes `commitAutoWrite` (src/db/pending-writes.ts:722-725) hand
  // back the bundle id it committed last time — a row the statement above has just
  // deleted — and `insertMarketingArtifacts` then dies on
  // `marketing_artifacts_bundle_id_fkey`. Same shape as
  // tests/integration/marketing-bundle.test.ts:87-101.
  await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [TENANT])
  setImageAdapter(stubAdapter())
})

afterAll(async () => {
  setImageAdapter(null)
  if (url !== '') {
    await closeDbClient()
    await pool.end()
  }
})

describe.skipIf(url === '')('marketing.generate_assets against Postgres', () => {
  // CASE ORDER IS LOAD-BEARING: this case must stay first. The reset is
  // `beforeAll`, not `beforeEach`, deliberately — case two reads the tenant's
  // whole day on purpose ("by now the tenant has paid for case one too"), so the
  // ledger is shared state across the file by design. The consequence is that the
  // absolute numbers below (`spentMinor` 8, `committedSpendMinor(TENANT)` 8) are
  // only exact because nothing had spent before them. Reorder this file, or add a
  // case above this one, and those two assertions fail for test order rather than
  // for the tool. `tests/integration/marketing-image-spend.test.ts:28-35` is the
  // alternative shape (a minted tenant per case) if this file ever needs it.
  it('writes the document, the bytes, the artifact and the ledger for two prompts', async () => {
    const bundleId = await saveDesignerBundle('two prompts')
    const out = await generate(bundleId)

    expect(out.gate).toBe('auto')
    expect(out.assets).toHaveLength(2)
    expect(out.refused).toEqual([])
    expect(out.spentMinor).toBe(8)
    expect(out.humanTaskId).toBeNull()

    const docs = await rows<{ id: string; kind: string; status: string; title: string }>(
      `SELECT id, kind, status, title FROM documents
        WHERE tenant_id = $1 AND kind = 'marketing_asset' AND id = ANY($2::uuid[])`,
      [TENANT, out.assets.map((a) => a.documentId)],
    )
    expect(docs).toHaveLength(2)
    // needs_review, not ready: the owner looks at the picture before the plane
    // calls it usable, and Task 8's stage refusal depends on that being the
    // stored state rather than an assumption.
    expect(new Set(docs.map((d) => d.status))).toEqual(new Set(['needs_review']))

    const files = await rows<{ document_id: string; size_bytes: string }>(
      'SELECT document_id, size_bytes FROM document_files WHERE document_id = ANY($1::uuid[])',
      [out.assets.map((a) => a.documentId)],
    )
    expect(files).toHaveLength(2)

    const artifacts = await rows<{ kind: string; document_id: string }>(
      `SELECT kind, document_id FROM marketing_artifacts
        WHERE tenant_id = $1 AND bundle_id = $2 AND kind = 'image'`,
      [TENANT, bundleId],
    )
    expect(artifacts).toHaveLength(2)
    // The CHECK that makes this assertion worth writing: an image artifact with
    // no document is a row that promises a picture and points at nothing.
    expect(artifacts.every((a) => a.document_id !== null)).toBe(true)

    expect(await committedSpendMinor(TENANT)).toBe(8)
  })

  it('buys nothing on the second pass, because every title is already there', async () => {
    const bundleId = await saveDesignerBundle('second pass')
    const first = await generate(bundleId)
    expect(first.spentMinor).toBe(8)
    // The day's total, read back, not the run's number. `spentMinor` is what THIS
    // call paid, and by now the tenant has paid for case one too, so comparing the
    // second pass with a per-run figure compares two different things and fails for
    // a reason that belongs to the test rather than the tool.
    const committedAfterFirst = await committedSpendMinor(TENANT)
    promptsAskedFor.length = 0

    const second = await generate(bundleId)
    expect(promptsAskedFor).toEqual([])
    expect(second.spentMinor).toBe(0)
    expect(second.assets.every((a) => a.deduplicated)).toBe(true)
    expect(await committedSpendMinor(TENANT)).toBe(committedAfterFirst)
  })

  it('refuses the whole pass before paying when the day is already spent', async () => {
    const bundleId = await saveDesignerBundle('already spent')
    setImageAdapter(stubAdapter(4))
    try {
      const out = await generate(bundleId)
      expect(out.assets).toEqual([])
      expect(out.refused.map((r) => r.code)).toEqual([
        'image_spend_ceiling_reached',
        'image_spend_ceiling_reached',
      ])
      expect(out.spentMinor).toBe(0)
      expect(out.humanTaskId).not.toBeNull()

      const tasks = await rows<{
        run_id: string
        kind: string
        tool_name: string
        title: string
        body: string | null
      }>('SELECT run_id, kind, tool_name, title, body FROM human_tasks WHERE id = $1', [
        out.humanTaskId,
      ])
      expect(tasks[0]?.run_id).toBe(`assets:${bundleId}`)
      expect(tasks[0]?.kind).toBe('refusal')
      expect(tasks[0]?.tool_name).toBe('marketing.generate_assets')
      // One row for the whole refusal, naming both assets, rather than one row
      // per asset: the owner reads this list, and a run that stopped early is
      // one decision to make. The refusal text lives in `title` and `body`.
      // There is no `reason` column on `human_tasks` (migrations/0002_crum_spine.sql:186-200),
      // and `createHumanTask` writes exactly these nine columns, so naming the
      // two that carry prose is the whole of the assertion.
      expect(tasks[0]?.title).toContain('refused 2 asset(s)')
      expect(tasks[0]?.body ?? '').toContain('image_spend_ceiling_reached')
    } finally {
      setImageAdapter(stubAdapter())
    }
  })
})
```

`human_tasks` carries the refusal in `title` and `body`, both written by `createHumanTask` (`src/db/pending-writes.ts:860-882`), which inserts `tenant_id, run_id, thread_id, kind, title, body, tool_name, risk_score, requested_by` and returns the new id. `title` is NOT NULL and `body` is nullable, so the `?? ''` above is what keeps the second assertion honest rather than type-annoying.

Run: `npx vitest run --project integration tests/integration/marketing-generate-assets.test.ts`
Expected: PASS with the throwaway cluster up, or three skipped cases reported as skipped when `CRUM_INTEGRATION_DATABASE_URL` is unset. A skip is not a pass; say which happened. This task proved more than the minimum, and the extra two runs are what the `migrate` line is worth: the file ran twice against the shared cluster, then once against a freshly created empty database inside that same cluster (created and dropped by the run, nothing left behind), and the counterfactual was observed — with the `migrate(pool)` call removed, the first `DELETE` fails with `relation "marketing_image_spend" does not exist`. Self-sufficiency is only a claim once the failure has been seen.

- [ ] **Step 9: Commit**

```bash
git add src/marketing/image-provider.ts src/marketing/payload.ts src/mastra/tools/marketing-writes.ts \
  src/mastra/processors/write-claim-guard.ts src/mastra/agent.ts policy/tools.yaml \
  tests/marketing/generate-assets-tool.test.ts \
  tests/integration/marketing-generate-assets.test.ts \
  tests/governance/conformance.test.ts \
  tests/governance/policy.test.ts tests/governance/marketing-payload.test.ts \
  tests/mastra/active-tools.test.ts tests/mastra/agent.test.ts \
  tests/mastra/processors/write-claim-guard.test.ts docs/TECHNICAL_PLAN.md
git commit -m "feat(marketing): generate_assets spends the daily image budget on stored designer prompts"
```

`docs/TECHNICAL_PLAN.md` is tracked (confirmed with `git ls-files docs/TECHNICAL_PLAN.md`) while `docs/superpowers/` is gitignored, so this commit can stage one and must never stage the other by accident. Never reach for `-A` to make a path error go away.

---

### Task 7: Telling the designer and the primary agent what the money is for

**Files:**
- Modify: `src/mastra/agents/creative-designer.ts:4-14` (the one `INSTRUCTIONS` string)
- Modify: `src/mastra/instructions.ts` (a new `<section id="marketing">` before `<section id="tools">` at line 80)
- Modify: `tests/mastra/marketing-agents.test.ts` (one case, in the `the marketing team shape` describe)
- Modify: `tests/mastra/instructions.test.ts` (one case)
- Modify: `src/evals/golden-items.ts` (one item, one receipt helper)
- Modify: `tests/evals/dataset-seed.test.ts:6,8,22` (42 becomes 43, `write` 10 becomes 11)
- Modify: `tests/evals/golden-gate.test.ts:18,166,184,185` (the same 42 in a comment, a comment, a title and an expectation)

**Interfaces:**
- Consumes: nothing from Tasks 1-6. This task is text and a fixture, which is why it can land before or after the tool it describes.
- Produces: the two instruction strings Task 14's walkthrough reads aloud, and one golden item named `marketing.generate_assets` that conformance in `tests/governance/conformance.test.ts` already covers from Task 6.

Spec section 7 has the sentences; write them verbatim. Both are load-bearing in the running product, and neither is load-bearing in a unit test, which is exactly the kind of requirement that has quietly rotted in this repository before.

- [ ] **Step 1: Add the failing instruction assertions**

In `tests/mastra/marketing-agents.test.ts`, add one case to the `describe('the marketing team shape')` block at line 69, **not** inside `describe.each(PAIRS)`. The role guard this step first drafted (`if (role !== 'creative-designer') return`) makes five of the six generated runs assert nothing at all — a green suite whose count overstates what it checks — and the file already imports both designer objects at line 7, so one direct case costs nothing and runs once:

```ts
  it('tells the designer that a downstream machine, not a human, will run its prompts', async () => {
    // The two substrings are the sentence spec section 7 adds. An instruction
    // that drops it leaves the designer writing prompts sized for a person.
    const instructions = (await creativeDesignerAgent.getInstructions()) as string
    expect(instructions).toContain('executed by an asset pass outside your control')
    expect(instructions).toContain('a wasted payment')
    // Still tool-less after slice 4, and read through the public API rather than
    // a property: `tools` is not a member of the Agent type, so the draft's
    // `Object.keys(agent.tools ?? {})` fails typecheck and, had it compiled,
    // would have measured an empty object it invented (probed against the real
    // agent: `'tools' in creativeDesignerAgent` is false, `listTools()` returns
    // no keys). This is the Agent-instance half; the subagent declaration's
    // `tools: {}` is already pinned for all six roles by the case at line 44.
    expect(Object.keys(await creativeDesignerAgent.listTools())).toHaveLength(0)
  })
```

Two assertions the first draft of this step carried are gone on purpose, and both were wrong rather than merely redundant: `expect(subagent.tools).toBeUndefined()` contradicts line 46 of the same file, which asserts that same field `toEqual({})` and is true (`creative-designer.ts:32` declares `tools: {}`), and the `agent.tools` read above does not exist on the class.

In `tests/mastra/instructions.test.ts`, inside `describe('CRUM instruction block')`:

```ts
  it('names the marketing artifact contract the asset pass depends on', () => {
    // Without this paragraph the primary agent has no idea that the designer's
    // JSON has to reach save_bundle as a creative-designer / script artifact,
    // and generate_assets refuses with no_asset_prompts on a feature the owner
    // can see in the menu (spec section 7.2).
    expect(CRUM_INSTRUCTIONS).toContain('<section id="marketing">')
    expect(CRUM_INSTRUCTIONS).toContain('marketing.generate_assets')
    expect(CRUM_INSTRUCTIONS).toContain('creative-designer')
  })
```

Add `import { CRUM_INSTRUCTIONS } from '../../src/mastra/instructions'` if that file does not already import it — it does, at line 2, so on today's branch this line is a check rather than an edit. Nothing in the existing seven cases reads a marketing word: `grep -i "marketing|bundle|designer|campaign"` over `src/mastra/instructions.ts` returns nothing today, which is why all three assertions above are genuinely red rather than three quarters of a formality.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/mastra/marketing-agents.test.ts tests/mastra/instructions.test.ts`
Expected: FAIL, one case per file and no more. `marketing-agents.test.ts` fails the designer case on both `toContain` lines (its `listTools()` assertion passes in RED, correctly — the designer was already tool-less and this task does not change that); `instructions.test.ts` fails the marketing case on all three `toContain` lines. The other cases in both files keep passing, which is the point of the two numbers. And at Step 6, when the markup exists, a case beyond these two that has gone red is the section disturbing something else — in this file that almost always means the articles/whys equality at `instructions.test.ts:16-23`.

- [ ] **Step 3: Write the designer sentence**

Modify `src/mastra/agents/creative-designer.ts`. Replace the tail of `INSTRUCTIONS` — from `'build you have no image generation tool, so a prompt is the deliverable and '` through `'plus style object: palette, type, rules array.'` — with the existing text plus spec section 7's sentence, keeping one string for both consumers:

```ts
const INSTRUCTIONS =
  'You are the designer. For each asset the brief needs, write an image prompt ' +
  'specific enough that a stranger would recognise the business in it: the ' +
  'trade, the setting, the actual thing on the wall, the lighting, and what ' +
  'must not appear. Never describe stock photography, never imitate a named ' +
  'brand or a real photographer, never place a logo you were not given. In this ' +
  'build you have no image generation tool, so a prompt is the deliverable and ' +
  'it must be complete enough to run unedited later. Those prompts are executed ' +
  'by an asset pass outside your control, one call per asset, so a prompt that ' +
  'needs two edits to work is a wasted payment. Keep aspectRatio inside the ' +
  'values the model supports and keep any prompt under 2000 characters. Answer ' +
  'with one JSON object: assets array of {name, purpose, prompt, negativePrompt, ' +
  'aspectRatio}, plus style object: palette, type, rules array.'
```

The `2000` here is `MAX_PROMPT_CHARS` from `src/marketing/replicate.ts`, stated as a number the model can obey rather than a validator that will refuse afterwards. The validator still exists — a prose instruction is not a check — but the instruction is what stops the payment being made first and the refusal arriving second.

- [ ] **Step 4: Write the primary-agent paragraph**

Modify `src/mastra/instructions.ts`, inserting between the `</section>` that closes `rules` (line 78) and `<section id="tools">` (line 80):

```
  <section id="marketing">
    <h2>Campaign bundles and creative</h2>
    <article>
      <h3>Creative is stored before it is paid for</h3>
      <p>When a campaign needs creative, delegate to
      <code>creative-designer</code> and pass its JSON object to
      <code>marketing.save_bundle</code> as one artifact with role
      <code>creative-designer</code>, kind <code>script</code>, and its full text
      in <code>textContent</code>. That stored prompt set is the only thing
      <code>marketing.generate_assets</code> will spend money on, so a bundle
      without it cannot have images.</p>
      <p class="why">The asset pass reads the stored artifact row and never takes
      prompts as arguments, because a bundle whose pictures were bought with
      prompts nobody reviewed is a bundle nobody can approve. Passing the
      designer's own text through save is what keeps the reviewed thing and the
      paid-for thing the same thing.</p>
    </article>
    <p>Generated images arrive as <code>needs_review</code>. Say so when you
    report a run: they are not approved creative until the owner reviews them,
    and staging refuses a bundle that still carries an unreviewed image.</p>
  </section>
```

The `<article>` wrapper is not decoration, and this is the one place in the task where the shape of the markup decides whether the suite is green. `tests/mastra/instructions.test.ts:16-23` counts `<article>\s*<h3>` and `<p class="why">` and asserts the two counts are **equal** — the file's rule is that every rule carries its why, expressed as an equality rather than a proportion. A marketing section that adds a bare `<p class="why">` with no `<article><h3>` above it therefore turns a passing test red: five articles against six whys. Wrapping the contract paragraph and its rationale in one article keeps them at six and six, and the same article is what makes the paragraph read like a rule rather than a note. `articles.length >= 5` still holds at six, and the examples case is untouched because this section carries no `<article class="example">`.

**The last sentence of this section promises a check that does not exist yet, and that is deliberate.** "staging refuses a bundle that still carries an unreviewed image" is Task 8's arm, one commit down the branch from this one; between the two heads the paragraph overstates the product. Task 7's review ruled against weakening it: the sentence is spec section 7.2's own text, the branch is never deployed between two of its own commits, and a paragraph that hedges ("staging will refuse, once that lands") is prose the model has to interpret. The gap is closed inside the same slice, and Task 8 Step 5 adds the assertion that stops it reopening — do not "fix" this task by deleting the sentence, and do not let Task 8 ship without that seal.

- [ ] **Step 5: Add the golden item**

Modify `src/evals/golden-items.ts`. Add a helper beside `bundleReceipt` (line 188):

```ts
/**
 * The ten keys `marketing.generate_assets` returns, copied from
 * `GenerateAssetsOutputSchema` (`src/mastra/tools/marketing-writes.ts:1065`)
 * rather than from the tool's prose. Two things the fixture has to get right.
 * The stored half always arrives as `needs_review`, because that is the status
 * the write sets (`src/db/marketing-assets.ts:95`) and an item that showed a
 * ready image would teach the model to promise approved creative; and this run
 * buys one picture, so its `costMinor` and the run's `spentMinor` are written
 * once and reused rather than typed twice — a receipt that disagrees with
 * itself teaches a model to report a sum it never added. A refusal fixture is
 * deliberately not here: this item's sentence asks for the buy, and the
 * `refused` array being empty is the honest answer to it.
 */
function assetReceipt(
  bundleId: string,
  spentMinor: number,
  message: string,
) {
  return {
    bundleId,
    assets: [{ name: 'hero-image', documentId: ASSET_DOCUMENT, status: 'needs_review', deduplicated: false, costMinor: spentMinor }],
    refused: [],
    spentMinor,
    provider: 'replicate',
    model: 'black-forest-labs/flux-1.1-pro',
    humanTaskId: null,
    riskScore: 10,
    gate: 'auto',
    message,
  }
}
```

(Shipped form. The first draft of this helper carried a comment claiming the refusal half of the receipt was what the gate needed, then shipped `refused: []` — a comment describing a fixture the file does not contain, corrected in Task 7's review round. `costMinor: 4` next to a `spentMinor` argument was the same species of drift in miniature, so the one asset now costs what the run spent.)

`assetReceipt` is the tool's own ten output keys, checked against `GenerateAssetsOutputSchema` at `src/mastra/tools/marketing-writes.ts:1065-1090` rather than against the Interfaces list above: `bundleId`, `assets` (five fields each, `status` a plain string so `'needs_review'` is legal), `refused`, `spentMinor`, the two nullable `provider`/`model`, the nullable `humanTaskId`, `riskScore` in 0..100, `gate` from the three-value enum, and `message`. A fixture that drifts from the schema is a golden item that trains the model on an answer the tool cannot give.

`ASSET_DOCUMENT` is a new uuid constant beside the existing `BUNDLE_PHYSIO` and `WRITE_BUNDLE_DRAFT`; mint it as `const ASSET_DOCUMENT = 'bbbbbbbb-1111-4111-8111-111111111111'` in the same block, matching the local style rather than inventing a generator. Then add the item after the second marketing item (the save-then-stage one at line 502):

```ts
    {
      input: 'Buy the images for the physio campaign bundle ' + BUNDLE_PHYSIO + ' and tell me what still needs review',
      groundTruth: { answerable: true, expectedToolCalls: ['marketing.generate_assets'] },
      toolMocks: [
        ...readMocks(WORLD_FULL),
        ...slots(
          'marketing.generate_assets',
          assetReceipt(
            BUNDLE_PHYSIO,
            4,
            'Stored 1 new image for the bundle, recorded 4 minor of image spend. It is needs_review until you review it.',
          ),
        ),
      ],
      category: 'write',
    },
```

The bundle id is in the user's sentence because the tool takes one argument and a fixture that hides it teaches the model to guess a uuid — the same reasoning the file already records at line 183 for `bundleReceipt`.

Then modify `tests/evals/dataset-seed.test.ts`: line 6's title and line 8's expectation move 42 to 43, and line 23's `write` count moves 10 to 11. Both numbers appear in the title, so both move together or the failure message lies.

Move the same count in `tests/evals/golden-gate.test.ts` in this same commit: line 18's file comment, line 166's `serialise the 42 items`, line 184's `it('executes all 42 golden items …')` title, and line 185's `expect(summary.totalItems).toBe(42)` all become 43. This file is the paid one — Task 14 Step 5 runs it once, and it is the only step in the plan that spends model money to answer a question about a number — and a stale 42 there fails on `totalItems` before the designer item's own assertions ever run, which means twelve model-minutes and one re-run to learn an arithmetic fact this task already knows. Leave `maxConcurrency: 1` and `itemTimeout: 90_000` alone; the 429 note beside them is about load, not about the count.

- [ ] **Step 6: Run the shape check, and do not run the paid gate**

Run: `npx vitest run tests/mastra/marketing-agents.test.ts tests/mastra/instructions.test.ts tests/evals/dataset-seed.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint`
Expected: clean.

Do not run `tests/evals/golden-gate.test.ts` here. It calls the live model, and one filtered pass costs about twelve model-minutes; Task 14 runs it once for the whole slice, and that is the only paid golden run this plan makes.

- [ ] **Step 7: Commit**

```bash
git add src/mastra/agents/creative-designer.ts src/mastra/instructions.ts \
  tests/mastra/marketing-agents.test.ts tests/mastra/instructions.test.ts \
  src/evals/golden-items.ts tests/evals/dataset-seed.test.ts \
  tests/evals/golden-gate.test.ts
git commit -m "docs(mastra): tell the designer and the primary agent what the image run costs"
```

---

### Task 8: `marketing.stage_bundle` refuses an unreviewed image, by name

**Files:**
- Modify: `src/db/marketing-assets.ts` (`listImageAssetStatuses` gains one projected column; no new function — Ruling 8a)
- Modify: `src/mastra/tools/marketing-writes.ts` (the `stageBundleTool` refusal chain only; the read this task needs is already imported at line 46)
- Test: `tests/db/marketing-assets.test.ts` (Task 5's `listImageAssetStatuses` case grows, plus one new case in `describe('the reads')`)
- Test: `tests/mastra/marketing-write-tools.test.ts` (three new cases in `describe('marketing.stage_bundle')`)
- Test: `tests/marketing/generate-assets-tool.test.ts` (two mock rows gain the new field)
- Test: `tests/mastra/instructions.test.ts` (one seal case, added green — Step 5)

**Interfaces:**
- Consumes: `listMarketingArtifacts`'s rows, which the stage tool already reads at `src/mastra/tools/marketing-writes.ts:426`, and `listImageAssetStatuses`, already imported in that same file at line 46 for Task 6's carry check.
- Produces: a refusal string of the shape `unreviewed images: hero-image, founder-portrait` that reaches `result.reason`, the human-task title and body, and the console's existing stage-refusal line. `listImageAssetStatuses`'s rows gain `kind: string`.

Spec section 6.1 puts the gate at staging, and the placement is the design: `generate_assets` must be allowed to attach what it just paid for, so it cannot be the one refusing a `needs_review` row, and approving a bundle is the last moment before a human takes responsibility for it.

**Ruling 8a: the status filter lives in the caller, not in a second query.** This task was drafted with a new `listUnreviewedImageTitles` whose SQL was filtered to `d.status <> 'ready'`. Three facts on `main` argue against that. First, `listImageAssetStatuses`'s own doc comment (`src/db/marketing-assets.ts:160`) already says the stage tool "refuses on a non-ready row found here and names the title", so a second function would leave that sentence describing a lane that does not exist. Second, that read already answers the same join with the same `a.kind = 'image'` predicate and is already imported by `marketing-writes.ts:46`; a second one is the same SQL with its projection trimmed to the answer. Third and decisive: spec section 6.1 names this task's load-bearing test as "stage a bundle with one `ready` and one `needs_review` image and assert the refusal names the second by title", and `stubQueries` ignores the `WHERE` clause it is handed. An SQL-side filter can therefore only be tested by quoting its own text back — which is what the drafted case did, and its own comment admitted it ("an empty handler row list is the honest answer for a reviewed image, because this mock ignores the WHERE clause the real query carries"). A filter the code performs is a filter the test can demonstrate: the mock hands back both rows because the real read really does return both rows, and the assertion is about the refusal picking one out of them.

**Ruling 8b: the document kind travels as a column, not as a predicate.** The drafted brief argued that a `kind = 'marketing_asset'` guard matters, because "an artifact that once pointed at an invoice would otherwise have its `needs_review` refused as an unreviewed image". That is right, and under this ruling it is testable instead of asserted in a comment: the read projects `d.kind` and the stage filter keeps the rows whose kind is an asset. The `WHERE` gains nothing, which is also what protects Task 6: `generate_assets` builds its carry map from this same read (`src/mastra/tools/marketing-writes.ts:1200-1205`) and must go on seeing a `ready` image it has already bought, or the idempotency rule becomes a re-payment. `tests/marketing/generate-assets-tool.test.ts:346` and `:365` carry the two mock rows that prove that skip, and both gain the new field so the mocks keep the shape of the real return value.

**Ruling 8c: no second tenant predicate on the document side.** The drafted query constrained `d.tenant_id` as well as `a.tenant_id`, on the grounds that "a join can cross a boundary that either side alone would not". Here it cannot: the join is `d.id = a.document_id` and `documents.id` is a `uuid PRIMARY KEY` (`migrations/0009_crum_documents.sql:2`), so a row reached through it is either the artifact's own document or there is no row. The predicate would be decoration, and decoration on a shared read costs Task 5's pinned SQL an assertion it does not need. Nothing about the artifact-side constraint changes.

**The read is behind a cheap in-memory check, and that is not a micro-optimisation.** `artifacts.some((a) => a.kind === 'image')` gates the query, so a bundle with no image never issues it. Two consequences: every existing stage test keeps passing without an added handler row — none of the fourteen cases in `describe('marketing.stage_bundle')` carries an `image` artifact — and the refusal cannot fire on a bundle that has no pictures to refuse. Do not "simplify" this by moving the read above the check: doing so would make fourteen unrelated tests throw `unexpected query` and would look like a regression in the stage tool rather than a missing fixture row.

**And the fragment keys are load-bearing, for a reason the draft got backwards.** `stubQueries` answers from the first fragment the SQL contains, in insertion order, and `listImageAssetStatuses`'s SQL begins `SELECT a.document_id, d.title, d.status, d.kind FROM marketing_artifacts a JOIN documents d` — so it *does* contain the artifacts key the existing handlers use. The three new cases below put `'JOIN documents d'` first, which appears in the status read and in neither `listMarketingArtifacts`'s single-table select (`src/db/marketing.ts:152`) nor the bundle read. Put the key after `'FROM marketing_artifacts'` and the status read is answered with artifact rows: `status: 'active'`, no `kind`, no title, and case 1 fails for a reason that has nothing to do with the arm under test.

**The residual, stated rather than hidden.** `staged` is a generable status in Task 6, so an owner can run `generate_assets` after staging and attach a fresh `needs_review` image to a bundle sitting in the queue. That image reaches nothing outside CRUM — the publish lane writes page files, and slice 3's campaign spec carries no creative — so the hole is a reviewer approving a bundle that gained a picture after they last looked, not a picture going live. Task 14's report names it. Closing it means re-checking at approval, which is a draft-payload question, and spec section 7 forbids prose in a payload: the check would have to re-read the database inside the approval transaction, which section 3 forbids. That is a slice 5 design question, not a line to add here.

- [ ] **Step 1: Write the failing tests**

In `tests/db/marketing-assets.test.ts`, grow the case Task 5 wrote at line 244 so the fixture row and the expectation both carry the kind, and the SQL assertion names the projected column. Its current body routes one row `{ document_id: DOC, title: 'hero-image', status: 'needs_review' }` and expects `{ documentId: DOC, title: 'hero-image', status: 'needs_review' }`; both gain `kind: 'marketing_asset'` (`rows[0]!.kind` after the map, `d.kind` in the SQL), and every other line in that case stays:

```ts
      {
        match: 'FROM marketing_artifacts a',
        rows: [{ document_id: DOC, title: 'hero-image', status: 'needs_review', kind: 'marketing_asset' }],
      },
```

```ts
    expect(await listImageAssetStatuses(TENANT, BUNDLE)).toEqual([
      { documentId: DOC, title: 'hero-image', status: 'needs_review', kind: 'marketing_asset' },
    ])
    const [call] = calls('FROM marketing_artifacts a')
    expect(call!.sql).toContain('d.kind')
```

Then add a second case to the same `describe('the reads')`, which is Ruling 8a's guarantee written down — the read stays general so two callers can each answer their own question from it:

```ts
  it('carries the document kind and still returns a reviewed image, because the caller decides', async () => {
    route([
      {
        match: 'FROM marketing_artifacts a',
        rows: [
          { document_id: DOC, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
          { document_id: DOC, title: 'founder-portrait', status: 'needs_review', kind: 'marketing_asset' },
        ],
      },
    ])
    const { listImageAssetStatuses } = await load()
    const rows = await listImageAssetStatuses(TENANT, BUNDLE)
    // Both rows survive the read. Task 6's carry check is the reason: it pays for
    // an asset only when this list does not already name it, so a `ready` row
    // filtered out here would re-buy an image the tenant owns. The stage refusal
    // is the other caller, and it does its own filtering (Ruling 8a).
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.title).sort()).toEqual(['founder-portrait', 'hero-image'])
    expect(rows.every((row) => row.kind === 'marketing_asset')).toBe(true)
  })
```

Note the two helpers this file actually defines: `route` takes an array of `{ match, rows }`, and there is no `lastCall` — the file's own shape is `const [call] = calls(fragment)`. Use those, and `TENANT`, `BUNDLE` and `DOC`, which are already declared at lines 17 and 20.

Add to `tests/mastra/marketing-write-tools.test.ts` inside `describe('marketing.stage_bundle')`, after the ambiguous-slot case that ends at line 768:

```ts
  it('refuses the unreviewed image by title while a reviewed one in the same bundle passes', async () => {
    stubQueries({
      // First, because listImageAssetStatuses's SQL also contains the artifacts
      // fragment below and stubQueries answers from the first match. `JOIN
      // documents d` is in that read and in nothing else this tool issues.
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
        {
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'founder-portrait',
          status: 'needs_review',
          kind: 'marketing_asset',
        },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({ id: 'a1', kind: 'script', text_content: 'Brand rules' }),
        artifactRow({
          id: 'a2',
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
        artifactRow({
          id: 'a3',
          role: 'creative-designer',
          kind: 'image',
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          text_content: null,
        }),
      ],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    // The title, not the uuid, and only the unreviewed one. The second line is
    // spec section 6.1's load-bearing case, and it is the reason the status filter
    // sits in this file rather than in a WHERE clause the mock above cannot exercise.
    expect(String(result.reason)).toContain('unreviewed images: founder-portrait')
    expect(String(result.reason)).not.toContain('hero-image')
    expect(String(call('INSERT INTO human_tasks')?.params[4])).toContain('founder-portrait')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
    expect(call('UPDATE marketing_bundles')).toBeUndefined()
  })

  it('stages a bundle whose only image is reviewed', async () => {
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
      ],
      'INSERT INTO pending_writes': [
        pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result.proceed).not.toBe(false)
    // The read happens and the bundle still stages: an empty refusal is the
    // difference between "reviewed" and "there were no pictures to ask about", and
    // only this assertion tells them apart.
    expect(call('JOIN documents d')).toBeDefined()
  })

  it('does not refuse a bundle over a document that is not a marketing asset', async () => {
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'october-invoice', status: 'needs_review', kind: 'invoice' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
      ],
      'INSERT INTO pending_writes': [
        pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    // An image artifact pointing at somebody's invoice is a data problem, not a
    // review queue full of invoices. Ruling 8b is the filter this case exists for.
    expect(result.proceed).not.toBe(false)
    expect(String(result.reason ?? '')).not.toContain('october-invoice')
  })
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/db/marketing-assets.test.ts tests/mastra/marketing-write-tools.test.ts`
Expected: FAIL, in four places and no more. The db file's grown case fails on the missing `kind` in both the mapped row and the SQL text. In the stage file, case 1 fails because the bundle stages instead of refusing, and case 2 fails because `call('JOIN documents d')` is undefined — no refusal chain member issues that read yet. Case 3 passes before the change and is a regression guard, not a red step; say so in the report rather than dressing it up.

The other fourteen stage cases keep passing, and that is the point of gating the read on `artifacts.some(...)`.

- [ ] **Step 3: Widen the read**

Modify `listImageAssetStatuses` in `src/db/marketing-assets.ts`: add `kind: string` to the return type and to the `db.query<...>` parameter, add `d.kind` to the projection, add `kind: row.kind` to the mapped object, and rewrite the doc comment's first paragraph so it stops claiming a refusal that this slice is only now building. Keep the `WHERE` exactly as Task 5 shipped it — no status predicate (Ruling 8a), no document-side tenant predicate (Ruling 8c).

```ts
/**
 * Every image artifact in a bundle with the kind and status of the document behind
 * it. One read, two questions: `marketing.generate_assets` uses it as "what does
 * this bundle already carry", keyed on the title, and `marketing.stage_bundle`
 * uses it as "what must a reviewer look at before this bundle can be decided",
 * which is the rows whose kind is `marketing_asset` and whose status is not
 * `ready`. The status filter is deliberately not in the SQL, because the first
 * caller has to keep seeing a reviewed image it has already paid for, and because
 * a refusal a unit test cannot reach is a refusal nobody can prove (Ruling 8a).
 *
 * Both the artifact's own `status` column and the `kind = 'image'` filter live
 * where Task 5 put them: the artifact says whether the attachment row is active,
 * which is not the same fact as whether the picture is approved. The title travels
 * rather than a bare uuid because an owner told "needs_review" has to work out
 * which picture is meant.
 */
```

- [ ] **Step 4: Add the arm**

Modify `src/mastra/tools/marketing-writes.ts`. `listImageAssetStatuses` is already in the `../../db/marketing-assets` import at line 46, so there is no import change. Insert immediately after the line `const slotIssue = slotProblemCheck(artifacts)` — find it with `grep -n "slotProblemCheck(artifacts)" src/mastra/tools/marketing-writes.ts`; it is at line 434 of the file on this branch today, and treat that as a hint, not a requirement:

```ts
      // Behind the in-memory check, so a bundle with no picture never issues the
      // second read and no existing stage fixture has to learn about it. The read
      // is Task 5's, not a fresh one filtered to not-ready rows, because the
      // filtering has to be somewhere a test can reach (Ruling 8a) — and because
      // a document that is not a marketing asset is not a picture under review
      // (Ruling 8b).
      const unreviewedTitles = artifacts.some((artifact) => artifact.kind === 'image')
        ? (await listImageAssetStatuses(rc.tenantId, bundle.id))
            .filter((row) => row.kind === 'marketing_asset' && row.status !== 'ready')
            .map((row) => row.title)
        : []
```

and add one arm at the end of the `refusal` chain, after the `blocked.length > 0` arm:

```ts
                : unreviewedTitles.length > 0
                  ? `unreviewed images: ${unreviewedTitles.join(', ')}`
                  : null
```

Last, the chain's comment above `const refusal` currently reads "The arms stay in this order because each is a cheaper question than the next" and then names four. The fifth is still last, and it is last for a reason the sentence does not yet say, so extend it rather than leaving a comment that lists four of five:

```ts
      // The arms stay in this order because each is a cheaper question than the
      // next: an unread plan cannot be counted, an unnameable page cannot be
      // placed, an ambiguous slot cannot be hashed, and a name with no adapter is
      // a build question, not a bundle question. The fifth is the only one that
      // costs a second read, so it goes after the four that do not.
```

Nothing about the other four arms changes.

- [ ] **Step 5: Seal the promise Task 7's instruction already makes**

`src/mastra/instructions.ts:99` says "staging refuses a bundle that still carries an unreviewed image". Task 7 shipped that sentence one commit before the arm that makes it true, and the interval is the thing spec section 6.1 is angry about: an instruction describing a protection the code does not perform. Step 4 closes the behaviour. This step closes the sentence, so the next person to touch either half is stopped by a test rather than by memory.

Add to `tests/mastra/instructions.test.ts`, after the marketing case Task 7 left at line 45:

```ts
  it('promises the staging refusal that now exists', () => {
    // Green on arrival, and deliberately so: the sentence has been in the
    // instruction since Task 7, so this is a seal rather than a RED. What it
    // buys is the forward direction — a later edit that drops the sentence while
    // the arm stays, or rewrites the paragraph to promise something the arm does
    // not do, has to pass this case on purpose. The behaviour half lives in
    // `tests/mastra/marketing-write-tools.test.ts`, where Step 1's first case
    // reads the refusal reason a human actually sees; a pin on prose cannot
    // detect a deleted arm, and pretending otherwise here would be the same
    // species of claim this task exists to stop.
    expect(CRUM_INSTRUCTIONS).toContain(
      'staging refuses a bundle that still carries an unreviewed image',
    )
  })
```

Run: `npx vitest run tests/mastra/instructions.test.ts`
Expected: PASS, 14 tests (13 before this case).

- [ ] **Step 6: Run it green**

Run: `npx vitest run tests/db/marketing-assets.test.ts tests/mastra/marketing-write-tools.test.ts tests/marketing/generate-assets-tool.test.ts tests/mastra/instructions.test.ts`
Expected: PASS. The two `generate-assets-tool.test.ts` fixtures at lines 346 and 365 need `kind: 'marketing_asset'` added to their mock rows so the mocks stay shaped like the real return value; the carry behaviour they assert does not read the field.

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/marketing-assets.ts src/mastra/tools/marketing-writes.ts \
  tests/db/marketing-assets.test.ts tests/mastra/marketing-write-tools.test.ts \
  tests/marketing/generate-assets-tool.test.ts tests/mastra/instructions.test.ts
git commit -m "feat(marketing): staging refuses a bundle whose images nobody has reviewed"
```

---

### Task 9: Four settings, one secret, and the adapter that only registers when it is paid for

**Files:**
- Modify: `src/config/env.ts:183` (four vars after `CRUM_META_AD_ACCOUNTS`) and `:226` (`PRODUCTION_REQUIRED_SECRETS`, whose `'CRUM_CLOUDFLARE_API_TOKEN'` entry is the last)
- Modify: `.env.example` (the four placeholder lines, in the marketing area the baseline commit `309d9d6` just built)
- Modify: `src/mastra/index.ts` — the `document-intake` import at `:17` gains `MAX_DOCUMENT_BYTES`, a new import goes after the Meta one at `:41`, the third lane logger joins `lastLane`/`lastMetaLane` at `:102-103` and `logLaneOnce`/`logMetaLaneOnce` at `:105-123`, and the registration block goes after the Meta block's closing brace at `:170`
- Test: `tests/config/env.test.ts` (three new cases, plus one line added to an existing case — Ruling 9b)
- Test: `tests/mastra/marketing-boot.test.ts` (one new `describe`)

**Interfaces:**
- Consumes: `makeReplicateAdapter` and `setImageAdapter` (`src/marketing/image-provider.ts:41` and `:72`, Task 6 — not `src/marketing/replicate.ts`, which holds `DEFAULT_REPLICATE_MODEL` at line 11 and the fetch code), `MAX_DOCUMENT_BYTES` from `src/mastra/workflows/document-intake.ts:22`, where it is `15 * 1024 * 1024`.
- Produces: `CrumEnv.CRUM_REPLICATE_API_TOKEN`, `.CRUM_REPLICATE_MODEL`, `.CRUM_IMAGE_SPEND_CEILING_MINOR`, `.CRUM_IMAGE_COST_MINOR_PER_IMAGE`, and the fact that `getImageAdapter()` is non-null exactly when the token is set.

This is the task that turns Task 6's `image_provider_not_configured` refusal from a unit-test fixture into the production behaviour of an install that has not opted in, which is the standing rule: an action may not be approvable, or here runnable, before it is executable.

- [ ] **Step 1: Write the failing config and boot tests**

Add to `tests/config/env.test.ts`:

```ts
describe('slice 4 image settings', () => {
  it('defaults the ceiling, the estimate and the model when nothing is set', () => {
    const env = parseEnv({ NODE_ENV: 'development' })
    expect(env.CRUM_REPLICATE_API_TOKEN).toBeUndefined()
    expect(env.CRUM_IMAGE_SPEND_CEILING_MINOR).toBe(2000)
    expect(env.CRUM_IMAGE_COST_MINOR_PER_IMAGE).toBe(4)
    // Two assertions on one value, each catching something the other cannot. The
    // literal pins the model spec section 11 names, because this string is what
    // reaches Replicate's model field and a shorter alias would not be refused by
    // anything. The constant pins the agreement with the adapter's own fallback
    // (`src/marketing/replicate.ts:11`, used at `image-provider.ts:42`): two
    // spellings of one vendor default is how `provider: REPLICATE_PROVIDER` was
    // written down in Task 6, for the same reason.
    expect(env.CRUM_REPLICATE_MODEL).toBe(DEFAULT_REPLICATE_MODEL)
    expect(DEFAULT_REPLICATE_MODEL).toBe('black-forest-labs/flux-1.1-pro')
  })

  it('treats a blank token as unset rather than as a token of length zero', () => {
    // Blank means unset for the numbers too, and not only because it is the house
    // style (`:171` does this for the lead cap): the `.env.example` placeholder
    // lines Step 3 writes are `KEY=`, so a blank ceiling that reached `.min(1)`
    // would refuse to boot an install that configured nothing.
    expect(parseEnv({ CRUM_REPLICATE_API_TOKEN: '   ' }).CRUM_REPLICATE_API_TOKEN).toBeUndefined()
    expect(parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '' }).CRUM_IMAGE_SPEND_CEILING_MINOR).toBe(2000)
  })

  it('refuses a ceiling that is not a positive whole number of minor units', () => {
    // '1.5' is the case that matters: a fractional ceiling would otherwise reach
    // `admitsRun` as a float and compare against integer minors, which is the
    // arithmetic the spend ledger is supposed to be free of.
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '0' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '1.5' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: 'abc' })).toThrowError(EnvParseError)
  })
})
```

`EnvParseError` is already imported by this file at line 6, and `toThrowError(EnvParseError)` is the house rejection shape (`:79`, `:83`, `:176`, `:189`) rather than a bare `toThrow()`. Add `import { DEFAULT_REPLICATE_MODEL } from '@/marketing/replicate'` beside the file's existing `@/config/env` import (the multi-line one at lines 5 to 11); that file uses the `@/` alias throughout, so no relative path belongs here.

Add to `tests/mastra/marketing-boot.test.ts`, as its own `describe` after the Meta one:

```ts
describe('slice 4 image adapter registration', () => {
  const IMAGE_ENV: Record<string, string> = {
    CRUM_REPLICATE_API_TOKEN: 'r8_test_token_at_least_thirty_two_bytes_long',
  }

  it('leaves no adapter registered when the token is absent', async () => {
    const { getImageAdapter } = await import('../../src/marketing/image-provider')
    createCrumMastra(envWith(), { storage: testStore() })
    expect(getImageAdapter()).toBeNull()
  })

  it('registers an adapter carrying the ceiling and estimate the env supplied', async () => {
    const { getImageAdapter } = await import('../../src/marketing/image-provider')
    createCrumMastra(
      envWith({ ...IMAGE_ENV, CRUM_IMAGE_SPEND_CEILING_MINOR: '5000', CRUM_IMAGE_COST_MINOR_PER_IMAGE: '9' }),
      { storage: testStore() },
    )
    const adapter = getImageAdapter()
    expect(adapter).not.toBeNull()
    expect(adapter?.provider).toBe('replicate')
    expect(adapter?.model).toBe('black-forest-labs/flux-1.1-pro')
    expect(adapter?.ceilingMinor).toBe(5000)
    expect(adapter?.costMinorPerImage).toBe(9)
    // The byte ceiling comes from the document lane, not from a new number: an
    // asset that could not be stored must not be generatable.
    expect(adapter?.maxBytes).toBe(15 * 1024 * 1024)
  })

  it('logs the image lane once per change, not once per construction', async () => {
    createCrumMastra(envWith(), { storage: testStore() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createCrumMastra(envWith(IMAGE_ENV), { storage: testStore() })
      createCrumMastra(envWith(IMAGE_ENV), { storage: testStore() })
      const lines = log.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('image adapter'))
      expect(lines).toEqual(['[CRUM] image adapter registered: replicate'])
    } finally {
      log.mockRestore()
    }
  })
})
```

These three run in order and depend on each other, exactly as the Meta block above them does: the slot is module state, and `createCrumMastra` runs per request in the real process. If a later slice adds a fourth lane to this file, the order dependency is the thing to write down first.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/config/env.test.ts tests/mastra/marketing-boot.test.ts`
Expected: FAIL, six cases, and none of them with the message the drafted text predicted. In `tests/config/env.test.ts` all three new cases are red: the defaults read `undefined` against `2000`, the blank-ceiling assertion reads `undefined` against `2000`, and the three rejection assertions find nothing to throw because no constraint exists yet. (`expect(DEFAULT_REPLICATE_MODEL).toBe('black-forest-labs/flux-1.1-pro')` is green on arrival and stays green; it is a drift pin, not a feature test.) In `tests/mastra/marketing-boot.test.ts` the second and third cases are red as **assertion mismatches, not a `Cannot read properties of undefined`**: every drafted property read in them is optional-chained (`adapter?.ceilingMinor`), so an unregistered slot answers `undefined` against `5000` rather than throwing, and the log case answers `[]` against one line. The first case is green before the change and after it, because nothing registers an adapter today and the else-branch keeps that true — say so in the report rather than counting it as a red step.

The existing 29 env cases and the Meta block stay green, which is what makes Ruling 9b's one fixture line easy to miss: it only goes red at Step 3, in the same commit as the list entry that causes it.

- [ ] **Step 3: Declare the settings**

Modify `src/config/env.ts`, immediately after `CRUM_META_AD_ACCOUNTS` (line 183) and inside the same object:

```ts
  // Slice 4 spec section 11: Replicate image generation. The token is a secret,
  // so blank means unset and an `KEY=` placeholder line in an env file cannot
  // make a boot fail on a length constraint. Absent token means no adapter
  // registers and marketing.generate_assets refuses at call time.
  CRUM_REPLICATE_API_TOKEN: z.preprocess(
    blankAsUnset,
    z.string().trim().min(32, 'must be at least 32 bytes').optional(),
  ),
  CRUM_REPLICATE_MODEL: z.preprocess(
    blankAsUnset,
    z.string().trim().min(1).default('black-forest-labs/flux-1.1-pro'),
  ),
  // Minor units, i.e. cents: the same unit line `marketing_image_spend` stores,
  // so the ceiling and the ledger are one number line and a reader never has to
  // convert between them. 2000 is $20 a day.
  CRUM_IMAGE_SPEND_CEILING_MINOR: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(10_000_000).default(2000),
  ),
  // The admission estimate, deliberately not the real price: it decides whether
  // a run is allowed to start, and the ledger records what Replicate actually
  // charged. A ceiling that only ever sees estimates would drift.
  CRUM_IMAGE_COST_MINOR_PER_IMAGE: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(100_000).default(4),
  ),
```

Then add the token to `PRODUCTION_REQUIRED_SECRETS` after `'CRUM_CLOUDFLARE_API_TOKEN'` (line 226):

```ts
  // Slice 4: the same reasoning as the Pages token above, one step further
  // (spec section 14). The parent spec's tiger T2 note is that the injection
  // guard fails open when an expected key is absent, and a designer reading
  // prospect copy is precisely where a stray instruction could end up on a bill.
  'CRUM_REPLICATE_API_TOKEN',
```

Ruling 9b, and the one existing case this change breaks: `tests/config/env.test.ts:125` ("reports nothing when every secret is present") builds an env literal naming all seven current entries and asserts `missingProductionSecrets(env)).toEqual([])`. `missingProductionSecrets` (`src/config/env.ts:254`) filters the exported list, so an eighth name with no matching line in that fixture turns a green case red, and the list has no other consumer in `src/` — nothing at boot reads it, which is why the drafted comment's "whoever wires this list into boot" is still written in the future tense. Add one line to the fixture beside the Pages token at `:133`:

```ts
      CRUM_REPLICATE_API_TOKEN: 'r8-' + 'z'.repeat(40),
```

Then document the four names in `.env.example`, as placeholder lines with nothing after the `=`, inside the marketing area (`CRUM_META_PIXEL_ID` and its neighbours). Ruling 9a: this task's drafted text said "do not touch `.env.example`, it carries another effort's uncommitted edit", and both halves of that have since stopped being true. The file was clean when the baseline commit `309d9d6` was made today, so the only lines in that diff were its own; and `tests/config/env.test.ts:204` ("documents every variable the schema parses") compares `Object.keys(EnvSchema.shape)` against the file, so four new schema keys and four absent lines would have made that case red on purpose. It had been red since slices 2 and 3 widened the schema without documenting nine names, which is the same drift in the same file, and `309d9d6` closed it. Two consequences worth knowing before writing the lines: `CRUM_REPLICATE_API_TOKEN` matches the secret-noun pattern at `tests/config/env.test.ts:245`, so its value is examined and an empty one passes, and every name added here is in the schema, which keeps `:210` green.

Spec section 14's reasoning that "the four defaults are usable, so a reader who wants them greps `src/config/env.ts` once" is about defaults, not about the token, and it cannot outvote a conformance test that reads the file. The token line stays blank because a committed credential is a committed credential.

- [ ] **Step 4: Register the adapter at boot**

Modify `src/mastra/index.ts`. Line 17's `document-intake` import becomes:

```ts
import { documentIntakeWorkflow, MAX_DOCUMENT_BYTES } from './workflows/document-intake'
```

and after line 43's Meta import add:

```ts
import { makeReplicateAdapter, setImageAdapter } from '../marketing/image-provider'
```

Beside `logMetaLaneOnce` (lines 115-124) add the third lane logger, following the existing two exactly — a module-level `let lastImageLane: 'replicate' | 'none' | undefined` above it, next to `lastLane` and `lastMetaLane`:

```ts
function logImageLaneOnce(lane: 'replicate' | 'none'): void {
  if (lastImageLane === lane) return
  lastImageLane = lane
  console.log(
    lane === 'replicate'
      ? '[CRUM] image adapter registered: replicate'
      : '[CRUM] image provider not configured; marketing.generate_assets will refuse',
  )
}
```

and inside `createCrumMastra`, after the Meta block's closing brace (line 170):

```ts
  // Slice 4: the image adapter registers only when the token is present. This
  // assignment runs on every construction, exactly like the Meta registrations
  // above, because createCrumMastra runs per request and a Map.set is cheap; only
  // the log is guarded. setImageAdapter(null) below is what makes an install
  // without a token refuse at call time rather than at boot.
  const imageToken = env.CRUM_REPLICATE_API_TOKEN
  if (imageToken) {
    setImageAdapter(
      makeReplicateAdapter({
        apiToken: imageToken,
        model: env.CRUM_REPLICATE_MODEL,
        ceilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR,
        costMinorPerImage: env.CRUM_IMAGE_COST_MINOR_PER_IMAGE,
        // The document lane's own limit, so a picture this build could not store
        // is a picture this build will not pay for.
        maxBytes: MAX_DOCUMENT_BYTES,
      }),
    )
    logImageLaneOnce('replicate')
  } else {
    setImageAdapter(null)
    logImageLaneOnce('none')
  }
```

`env.CRUM_REPLICATE_MODEL` is typed `string` by its default, so the adapter's optional `model` parameter is always supplied here; it stays optional in Task 6 because that is what lets a unit test build an adapter without restating the vendor's default.

- [ ] **Step 5: Run it green**

Run: `npx vitest run tests/config/env.test.ts tests/mastra/marketing-boot.test.ts tests/marketing/generate-assets-tool.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/mastra/index.ts .env.example \
  tests/config/env.test.ts tests/mastra/marketing-boot.test.ts
git commit -m "feat(marketing): register the Replicate adapter only when the token is configured"
```

`.env.example` is tracked and not ignored, so it stages normally. The path that does not is `src/evals/...`: `.gitignore` matches the directory while the files inside are tracked, so `git add src/evals/golden-items.ts` exits 1 and a chained `git add ... && git commit` never reaches the commit. Task 7 met exactly this and reported it; if a later step in this task needs an `src/evals` path, it needs `git add -f`.

---

## Sub-slice 4b: committing to a number before looking

Nothing here needs a provider token, so 4b ships first when the key is still undecided. Tasks 10 through 13 add the prediction record, the two routes that read and write it, the bytes route the spec assigns to this half, and the console that shows a textarea instead of a proposal. Task 12 is the seam between the halves: it stores nothing and spends nothing, it only decides who is allowed to look.

### Task 10: The draft the gate attaches to, and the record that cannot be revised

**Files:**
- Create: `src/db/reviewer-predictions.ts`
- Modify: `src/db/pending-writes.ts` (add `getOpenStageDraft` after `getPendingWrite`, line 755)
- Test: `tests/db/reviewer-predictions.test.ts` (new)
- Test: `tests/db/open-stage-draft.test.ts` (new)
- Test: `tests/integration/reviewer-predictions.test.ts` (new)

**Interfaces:**
- Consumes: the `reviewer_predictions` table from Task 1, `pending_writes` columns as they already exist, and `getDbClient()` from `src/db/client.ts`.
- Produces:

```ts
// src/db/pending-writes.ts
export async function getOpenStageDraft(tenantId: string, bundleId: string): Promise<PendingWrite | null>

// src/db/reviewer-predictions.ts
export interface ReviewerPrediction {
  id: string
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
  createdAt: string
}
export async function getPredictionForDraft(
  tenantId: string,
  pendingWriteId: string,
): Promise<ReviewerPrediction | null>
// Returns the row that exists after the call, whether or not this call wrote it.
export async function insertPrediction(params: {
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
}): Promise<{ created: boolean; prediction: ReviewerPrediction }>
// The one read the routes need: is this bundle gated, and has it been predicted on.
// A discriminated union, because `required` is nothing more than "there is an open
// stage draft", and the routes need that draft's id to write against. Naming the
// union means a route that forgot to check `required` fails to compile instead of
// storing `null` into a NOT NULL column.
export type PredictionGate =
  | { required: true; pendingWriteId: string; prediction: ReviewerPrediction | null }
  | { required: false; pendingWriteId: null; prediction: null }
export async function bundlePredictionGate(
  tenantId: string,
  bundleId: string,
): Promise<PredictionGate>
```

Task 11's two routes and Task 12's bytes route all call `bundlePredictionGate`; none of them writes its own `pending_writes` SQL, and none of them re-derives the draft id: the POST writes the prediction against `gate.pendingWriteId`, and the GET and the bytes route read only `gate.required` and `gate.prediction`.

Spec section 4.3 is the requirement, and its last paragraph is the one an implementer will be tempted to skip: the gate applies only to the `marketing_stage` draft, and a bundle with no open stage draft is **not gated at all**. The predicate lives in one helper here precisely so the two routes and the console cannot each grow a slightly different version of "open".

- [ ] **Step 1: Write the failing unit tests**

Create `tests/db/open-stage-draft.test.ts`, in the mocked-`pg` idiom of `tests/db/marketing.test.ts`:

```ts
// tests/db/open-stage-draft.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'

function draftRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DRAFT,
    tenant_id: TENANT,
    run_id: 'pending',
    thread_id: null,
    object_type: 'marketing_stage',
    operation: 'update',
    target_id: BUNDLE,
    payload: {},
    risk_score: 10,
    gate: 'approval',
    draft_hash: 'hash',
    receipt_id: null,
    rejected_at: null,
    rejection_reason: null,
    committed_at: null,
    committed_record_id: null,
    requested_by: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-02T00:00:00.000Z',
    ...over,
  }
}

async function load() {
  return await import('../../src/db/pending-writes')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('getOpenStageDraft', () => {
  it('asks for the five conditions spec section 4.3 names, scoped to this tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [draftRow()] })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft?.id).toBe(DRAFT)
    const sql = String((mockQuery.mock.calls as unknown[][])[0]![0])
    const params = (mockQuery.mock.calls as unknown[][])[0]![1] as unknown[]
    expect(sql).toContain("object_type = 'marketing_stage'")
    expect(sql).toContain('target_id = $1')
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('receipt_id IS NULL')
    expect(sql).toContain('rejected_at IS NULL')
    expect(sql).toContain('expires_at > now()')
    expect(sql).toContain('ORDER BY created_at DESC')
    expect(params).toEqual([BUNDLE, TENANT])
  })

  it('maps the row through the module\'s own PendingWrite shape', async () => {
    mockQuery.mockResolvedValue({ rows: [draftRow()] })
    const { getOpenStageDraft } = await load()
    const draft = await getOpenStageDraft(TENANT, BUNDLE)
    expect(draft).toMatchObject({
      tenantId: TENANT,
      objectType: 'marketing_stage',
      targetId: BUNDLE,
      gate: 'approval',
      receiptId: null,
    })
  })

  it('returns null rather than an empty object when nothing is open', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getOpenStageDraft } = await load()
    expect(await getOpenStageDraft(TENANT, BUNDLE)).toBeNull()
  })

  it('does not widen to promote, retry or campaign-status drafts', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getOpenStageDraft } = await load()
    await getOpenStageDraft(TENANT, BUNDLE)
    const sql = String((mockQuery.mock.calls as unknown[][])[0]![0])
    for (const other of ['marketing_promote', 'marketing_retry', 'marketing_set_campaign_status']) {
      expect(sql).not.toContain(other)
    }
    // One draft, newest first: `LIMIT 1` is what stops a re-staged bundle making
    // the caller guess which row the predicate meant.
    expect(sql).toContain('LIMIT 1')
  })
})
```

Create `tests/db/reviewer-predictions.test.ts`:

```ts
// tests/db/reviewer-predictions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'
const PREDICTION = '55555555-5555-4555-8555-555555555555'

function predictionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PREDICTION,
    tenant_id: TENANT,
    pending_write_id: DRAFT,
    predicted_outcome: 'about 6 booked calls a week',
    created_at: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/reviewer-predictions')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('insertPrediction', () => {
  it('writes the outcome text against the draft, not the bundle', async () => {
    mockQuery.mockResolvedValue({ rows: [predictionRow()] })
    const { insertPrediction } = await load()
    const result = await insertPrediction({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'about 6 booked calls a week',
    })
    expect(result.created).toBe(true)
    const [insert] = calls('INSERT INTO reviewer_predictions')
    expect(insert?.sql).toContain('ON CONFLICT (pending_write_id) DO NOTHING')
    expect(insert?.params).toEqual([TENANT, DRAFT, 'about 6 booked calls a week'])
    expect(result.prediction.pendingWriteId).toBe(DRAFT)
  })

  it('hands back the row that already exists when the insert loses the race', async () => {
    // Two reviewers, one draft: the second POST must report the first prediction
    // rather than a second one or an error a console cannot show.
    mockQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('INSERT INTO reviewer_predictions')
        ? { rows: [] }
        : { rows: [predictionRow({ predicted_outcome: 'forty replies' })] },
    )
    const { insertPrediction } = await load()
    const result = await insertPrediction({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'mine',
    })
    expect(result.created).toBe(false)
    expect(result.prediction.predictedOutcome).toBe('forty replies')
    expect(calls('SELECT')[0]?.sql).toContain('pending_write_id = $2')
  })

  it('refuses an empty outcome before it opens a connection', async () => {
    const { insertPrediction } = await load()
    await expect(
      insertPrediction({ tenantId: TENANT, pendingWriteId: DRAFT, predictedOutcome: '   ' }),
    ).rejects.toThrow(/predicted_outcome/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('bundlePredictionGate', () => {
  it('is not required, and reports no prediction, when the bundle has no open stage draft', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { bundlePredictionGate } = await load()
    expect(await bundlePredictionGate(TENANT, BUNDLE)).toEqual({
      required: false,
      pendingWriteId: null,
      prediction: null,
    })
    // No second query: a bundle nobody has staged is not a decision waiting for
    // a prediction, and the screen must render as slices 1 to 3 made it.
    expect(calls('FROM reviewer_predictions')).toHaveLength(0)
  })

  it('is required with the draft id and a null prediction when the draft is open and nobody has typed yet', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM pending_writes')
        ? { rows: [draftRowForGate()] }
        : { rows: [] },
    )
    const { bundlePredictionGate } = await load()
    const gate = await bundlePredictionGate(TENANT, BUNDLE)
    expect(gate).toEqual({ required: true, pendingWriteId: DRAFT, prediction: null })
  })

  it('is required with the prediction when one exists', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM pending_writes')
        ? { rows: [draftRowForGate()] }
        : { rows: [predictionRow()] },
    )
    const { bundlePredictionGate } = await load()
    const gate = await bundlePredictionGate(TENANT, BUNDLE)
    expect(gate.required).toBe(true)
    expect(gate.pendingWriteId).toBe(DRAFT)
    expect(gate.prediction?.predictedOutcome).toBe('about 6 booked calls a week')
  })
})

function draftRowForGate(): Record<string, unknown> {
  return {
    id: DRAFT,
    tenant_id: TENANT,
    run_id: 'pending',
    thread_id: null,
    object_type: 'marketing_stage',
    operation: 'update',
    target_id: BUNDLE,
    payload: {},
    risk_score: 10,
    gate: 'approval',
    draft_hash: 'hash',
    receipt_id: null,
    rejected_at: null,
    rejection_reason: null,
    committed_at: null,
    committed_record_id: null,
    requested_by: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-02T00:00:00.000Z',
  }
}
```

The third gate case mocks `pending_writes` because `bundlePredictionGate` reads through `getOpenStageDraft`, and both modules reach the same mocked pool. `draftRowForGate` is declared after the `describe` blocks on purpose: hoisted function declarations keep the cases readable top-down, which is the style `tests/db/marketing-metrics.test.ts` already uses.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/db/open-stage-draft.test.ts tests/db/reviewer-predictions.test.ts`
Expected: FAIL — `getOpenStageDraft is not a function`, `Cannot find module '../../src/db/reviewer-predictions'`.

- [ ] **Step 3: Add the draft lookup**

Modify `src/db/pending-writes.ts`, inserting after `getPendingWrite` (line 755):

```ts
/**
 * The one open stage draft for one bundle, newest first, or null.
 *
 * Spec section 4.3 is the predicate, and it is written here rather than inline
 * in a route because three callers need the identical answer: the bundle GET
 * decides whether to withhold the copy, the prediction POST decides whether it
 * has anything to attach to, and the asset bytes route decides whether to
 * withhold a picture. `listPendingWrites` (line 884) filters on a receipt and a
 * rejection but never on `target_id`, and a route that wanted only this bundle's
 * stage draft would have to fetch the tenant's whole queue to find it.
 *
 * `expires_at > now()` is the difference between a decision and a forgery: the
 * slice 2 M3 work made an expired draft rejectable but not approvable, so a
 * prediction against one would anchor a reviewer to a document no approval can
 * honour any more.
 */
export async function getOpenStageDraft(
  tenantId: string,
  bundleId: string,
): Promise<PendingWrite | null> {
  const db = getDbClient()
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM pending_writes
      WHERE target_id = $1
        AND tenant_id = $2
        AND object_type = 'marketing_stage'
        AND receipt_id IS NULL
        AND rejected_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [bundleId, tenantId],
  )
  const row = result.rows[0]
  return row ? rowToPendingWrite(row) : null
}
```

- [ ] **Step 4: Create the prediction module**

Create `src/db/reviewer-predictions.ts`.

```ts
// src/db/reviewer-predictions.ts
/**
 * The record behind the cognitive forcing gate.
 *
 * A reviewer who reads the copy first cannot predict honestly afterwards, so
 * slice 4 asks for the prediction before it shows anything, and this table is
 * what makes that more than a screen trick. The `uq_prediction_draft` unique
 * constraint from migration 0021 is the device: one row per draft, so a
 * prediction cannot be revised once the reviewer has seen the bundle, and the
 * row points at the `pending_writes` draft rather than the bundle so a
 * re-staged bundle starts clean.
 *
 * No prose rule applies here. The standing rule that approval payloads carry
 * identifiers and numbers only is about what `pending_writes.payload` holds; a
 * prediction is reviewer prose stored in its own table, and `predicted_outcome`
 * is free text by design (spec section 8.4: the gate is not a validator).
 */
import { getDbClient } from './client'
import { getOpenStageDraft } from './pending-writes'

export interface ReviewerPrediction {
  id: string
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
  createdAt: string
}

interface PredictionSqlRow {
  id: string
  tenant_id: string
  pending_write_id: string
  predicted_outcome: string
  created_at: string
}

function rowToPrediction(row: PredictionSqlRow): ReviewerPrediction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    pendingWriteId: row.pending_write_id,
    predictedOutcome: row.predicted_outcome,
    createdAt: row.created_at,
  }
}

export async function getPredictionForDraft(
  tenantId: string,
  pendingWriteId: string,
): Promise<ReviewerPrediction | null> {
  const db = getDbClient()
  const result = await db.query<PredictionSqlRow>(
    `SELECT id, tenant_id, pending_write_id, predicted_outcome, created_at
       FROM reviewer_predictions
      WHERE tenant_id = $1 AND pending_write_id = $2`,
    [tenantId, pendingWriteId],
  )
  const row = result.rows[0]
  return row ? rowToPrediction(row) : null
}

/**
 * Write the prediction, or read the one that beat this call to it.
 *
 * The return is `{ created, prediction }` rather than the id because the route
 * has to tell a second reviewer what is already there, and the only way to know
 * that without a second round trip is to ask the insert. `RETURNING` on `ON
 * CONFLICT DO NOTHING` answers with nothing when the row existed, which is the
 * signal; the re-read then answers *whose* prediction it was. A reviewer should
 * never be told "your prediction was not saved" without also being shown the one
 * that was.
 */
export async function insertPrediction(params: {
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
}): Promise<{ created: boolean; prediction: ReviewerPrediction }> {
  const outcome = params.predictedOutcome.trim()
  if (outcome === '') {
    throw new Error('predicted_outcome: a blank prediction predicts nothing and is not stored')
  }
  const db = getDbClient()
  const inserted = await db.query<PredictionSqlRow>(
    `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
     VALUES ($1, $2, $3)
     ON CONFLICT (pending_write_id) DO NOTHING
     RETURNING id, tenant_id, pending_write_id, predicted_outcome, created_at`,
    [params.tenantId, params.pendingWriteId, outcome],
  )
  const row = inserted.rows[0]
  if (row) return { created: true, prediction: rowToPrediction(row) }

  const existing = await getPredictionForDraft(params.tenantId, params.pendingWriteId)
  if (existing === null) {
    throw new Error(
      `predicted_outcome: draft ${params.pendingWriteId} refused the insert and has no row to read back`,
    )
  }
  return { created: false, prediction: existing }
}

/**
 * Is this bundle gated, and has anyone committed to a number on it yet?
 *
 * Two reads, and the second only when the first says there is a decision
 * waiting: a `draft` bundle with no open stage draft is not gated at all, which
 * is what keeps the screen readable by the person who has to stage it (spec
 * section 4.3). Returning one answer rather than two route-side calls is the
 * point: the withhold decision, the write target and the render decision must
 * read the same row or they will disagree. `pendingWriteId` is in the answer
 * because Task 11's POST needs it and must not go looking for it a second time.
 */
export async function bundlePredictionGate(
  tenantId: string,
  bundleId: string,
): Promise<PredictionGate> {
  const draft = await getOpenStageDraft(tenantId, bundleId)
  if (draft === null) return { required: false, pendingWriteId: null, prediction: null }
  const prediction = await getPredictionForDraft(tenantId, draft.id)
  return { required: true, pendingWriteId: draft.id, prediction }
}
```

- [ ] **Step 5: Prove the constraint on a real database**

Create `tests/integration/reviewer-predictions.test.ts`. The unit cases above mock the pool, so they cannot prove the thing the gate actually relies on: that the database refuses a second prediction for one draft. This file is the only place that claim gets tested, and it is skipped without `CRUM_INTEGRATION_DATABASE_URL`.

```ts
// tests/integration/reviewer-predictions.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

let pool: Pool

describe.skipIf(!url)('reviewer_predictions on Postgres', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
    await pool.query('BEGIN')
  })

  afterAll(async () => {
    await pool.query('ROLLBACK')
    await pool.end()
  })

  async function openDraft(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO pending_writes
         (tenant_id, run_id, object_type, operation, target_id, payload,
          risk_score, gate, draft_hash, requested_by, expires_at)
       VALUES ($1, 'pending', 'marketing_stage', 'update', $2, '{}'::jsonb,
               10, 'approval', $3, $1, now() + interval '1 hour')
       RETURNING id`,
      [TENANT, BUNDLE, `pred-itest:${BUNDLE}:${Date.now()}`],
    )
    return rows[0]!.id
  }

  it('refuses a second prediction for the same draft', async () => {
    const draftId = await openDraft()
    await pool.query(
      `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, 'six booked calls a week')`,
      [TENANT, draftId],
    )
    await expect(
      pool.query(
        `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, 'actually forty')`,
        [TENANT, draftId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('lets two drafts of two bundles each hold one prediction', async () => {
    const first = await openDraft()
    const second = await openDraft()
    for (const draftId of [first, second]) {
      await pool.query(
        `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
         VALUES ($1, $2, 'ten replies')`,
        [TENANT, draftId],
      )
    }
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reviewer_predictions WHERE tenant_id = $1`,
      [TENANT],
    )
    // Two rows, because the constraint is per draft and not per bundle. A
    // re-staged bundle has to be predictable again, which is why the column
    // points at pending_writes at all.
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2)
  })

  it('drops the prediction when the draft goes', async () => {
    const draftId = await openDraft()
    await pool.query(
      `INSERT INTO reviewer_predictions (tenant_id, pending_write_id, predicted_outcome)
       VALUES ($1, $2, 'eleven calls')`,
      [TENANT, draftId],
    )
    await pool.query(`DELETE FROM pending_writes WHERE id = $1`, [draftId])
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM reviewer_predictions WHERE pending_write_id = $1`,
      [draftId],
    )
    expect(rows).toHaveLength(0)
  })

  it('finds the open stage draft and ignores an expired one', async () => {
    const { getOpenStageDraft } = await import('../../src/db/pending-writes')
    const live = await openDraft()
    const found = await getOpenStageDraft(TENANT, BUNDLE)
    expect(found?.id).toBe(live)
    await pool.query(`UPDATE pending_writes SET expires_at = now() - interval '1 minute'`)
    expect(await getOpenStageDraft(TENANT, BUNDLE)).toBeNull()
  })
})
```

The `openDraft()` insert is complete against the real table, checked column by column: `migrations/0002_crum_spine.sql:140-165` makes `tenant_id`, `run_id`, `object_type`, `operation`, `payload`, `risk_score`, `gate`, `requested_by` and `expires_at` NOT NULL, `migrations/0003_crum_add_draft_hash.sql:21` adds `draft_hash NOT NULL`, `thread_id`, `target_id`, `receipt_id`, `rejected_at` and `rejection_reason` are nullable, and `created_at` defaults. Two constraints the fixture has to respect rather than merely survive: `pending_writes_update_needs_target` requires `target_id` for any operation other than `create`, which is why `openDraft` passes `BUNDLE` with `'update'`, and `uq_pending_draft_hash` is unique per tenant, which is why the hash embeds `Date.now()`. `marketing_stage` is in the `object_type` CHECK from `migrations/0019_crum_marketing_publishing.sql:36`, so no migration in this slice is needed for the fixture to insert. Keep the transaction open across the file and roll it back at the end, the way `tests/integration/pending-writes.test.ts` already does.

- [ ] **Step 6: Run it green**

Run: `npx vitest run tests/db/open-stage-draft.test.ts tests/db/reviewer-predictions.test.ts`
Expected: PASS.

Run, with the throwaway Postgres from this plan's Integration cluster up and `CRUM_INTEGRATION_DATABASE_URL` exported:
`npx vitest run --project integration tests/integration/reviewer-predictions.test.ts`
Expected: PASS. Skipped with 4 tests is not green: if it skipped, the URL is not set.

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/reviewer-predictions.ts src/db/pending-writes.ts \
  tests/db/open-stage-draft.test.ts tests/db/reviewer-predictions.test.ts \
  tests/integration/reviewer-predictions.test.ts
git commit -m "feat(governance): one prediction per open stage draft, before the copy"
```

---

### Task 11: The prediction door, and the GET that withholds the copy

**Files:**
- Modify: `src/api/marketing.ts:76-89` (the bundle GET handler) and a new POST beside it
- Modify: `tests/api/marketing.test.ts:48-58` (the response gained two keys in this task, so the one case that compares the whole body moves with it)
- Test: `tests/api/marketing-prediction.test.ts` (new)

Line numbers in this task are read off `src/api/marketing.ts` as it stands at 397 lines. Locate the handler by its signature (`app.get('/bundles/:id', async (c) =>`), not by the number: Task 11 is the first marketing edit of the two that touch this file, and Task 12 appends the bytes route below it. `IdSchema` is the file-level `z.string().uuid()` on line 36, and the `auth` closure the new POST calls is on lines 63 to 73.

**Interfaces:**
- Consumes: `bundlePredictionGate` and `insertPrediction` (Task 10), the `auth` closure already inside `createMarketingRouter` (`src/api/marketing.ts:63-73`), `IdSchema` (line 36).
- Produces: `GET /api/marketing/bundles/:id` answering `{ bundle, artifacts?, actions, predictionRequired, prediction }`, and `POST /api/marketing/bundles/:id/prediction` answering `200 { prediction, existed }`. Task 13's console reads both shapes; Task 12's bytes route reuses the same `bundlePredictionGate` answer.

Spec section 8.3 is the contract. Two decisions inside it are worth stating before the code, because they are the two a reviewer of this task will ask about.

**The copy leaves the response, not the screen.** For a gated bundle with no prediction, the six prose-bearing keys are deleted from the `bundle` object and `artifacts` is omitted from the response entirely. A reviewer with devtools open must not be able to read the proposal they have not yet committed to: `prediction` is the only new field a withheld response carries, and it carries `null`, which says nothing about the bundle.

**`existed: true` answers 200, not 409.** The console's submit handler treats a non-2xx as a failure the reviewer caused, and a reviewer whose second tab lost the race caused nothing: their prediction is stored, theirs or not. Returning the row that won with `existed` telling the console it was not this call's write is the honest answer, and it is the same shape as `insertPrediction`'s `{ created, prediction }`.

- [ ] **Step 1: Write the failing route tests**

Modify `tests/api/marketing.test.ts`'s first case so the whole-body comparison carries the two new fields, and add the module mock the new import needs:

```ts
const predictions = vi.hoisted(() => ({
  bundlePredictionGate: vi.fn(),
  insertPrediction: vi.fn(),
}))

vi.mock('../../src/db/reviewer-predictions', () => ({
  bundlePredictionGate: predictions.bundlePredictionGate,
  insertPrediction: predictions.insertPrediction,
  getPredictionForDraft: vi.fn(),
}))
```

and in `beforeEach`, `predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })`. The existing case then compares:

```ts
    expect(await res.json()).toEqual({
      bundle: { id: BUNDLE, tenantId: TENANT, status: 'staged' },
      artifacts: [{ id: 'a1', role: 'marketer-copywriter' }],
      actions: [{ id: 'm1', action: 'publish_page' }],
      predictionRequired: false,
      prediction: null,
    })
```

Create `tests/api/marketing-prediction.test.ts`:

```ts
// tests/api/marketing-prediction.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const db = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  listMarketingArtifacts: vi.fn(),
  listMarketingActions: vi.fn(),
}))

const predictions = vi.hoisted(() => ({
  bundlePredictionGate: vi.fn(),
  insertPrediction: vi.fn(),
}))

vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: db.getMarketingBundle,
  listMarketingArtifacts: db.listMarketingArtifacts,
  listMarketingActions: db.listMarketingActions,
}))
vi.mock('../../src/db/reviewer-predictions', () => ({
  bundlePredictionGate: predictions.bundlePredictionGate,
  insertPrediction: predictions.insertPrediction,
  getPredictionForDraft: vi.fn(),
}))
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'
const PREDICTION = '55555555-5555-4555-8555-555555555555'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

const gated = {
  id: BUNDLE,
  tenantId: TENANT,
  brief: 'Book more assessment calls with Melbourne physio clinics',
  objective: 'inbound_leads',
  audienceNote: 'owner-led clinics',
  status: 'staged',
  strategy: { position: 'the clinic that answers within the hour' },
  copy: { hooks: ['Your next patient is already searching'] },
  mediaPlan: { budget: 400 },
  funnelPlan: { page: { slug: 'free-scan' } },
  analysis: null,
  promptVersion: 'marketing-v1',
  draftHash: 'hash',
  leadToken: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

const prediction = {
  id: PREDICTION,
  tenantId: TENANT,
  pendingWriteId: DRAFT,
  predictedOutcome: 'about 6 booked calls a week',
  createdAt: '2026-11-01T00:00:00.000Z',
}

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function getBundle(headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/bundles/${BUNDLE}`, { headers })
}

function post(body: unknown, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/bundles/${BUNDLE}/prediction`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getMarketingBundle.mockResolvedValue(gated)
  db.listMarketingArtifacts.mockResolvedValue([{ id: 'a1', kind: 'image', documentId: 'd1' }])
  db.listMarketingActions.mockResolvedValue([])
  predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })
})

describe('GET /api/marketing/bundles/:id withholds the proposal', () => {
  it('answers normally with the two new fields when the bundle is not gated', async () => {
    const body = await (await getBundle()).json()
    expect(body.predictionRequired).toBe(false)
    expect(body.prediction).toBeNull()
    expect(body.artifacts).toHaveLength(1)
    expect(body.bundle.copy).not.toBeUndefined()
  })

  it('drops every prose-bearing key and the artifact list while a gate is open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await getBundle()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.predictionRequired).toBe(true)
    // Absent, not null: a null where an object belongs still tells a reader the
    // field exists and is empty, which is a fact about the proposal.
    for (const key of ['strategy', 'copy', 'mediaPlan', 'funnelPlan', 'analysis', 'audienceNote']) {
      expect(Object.keys(body.bundle)).not.toContain(key)
    }
    expect(Object.keys(body)).not.toContain('artifacts')
    // What survives is what tells the reviewer which bundle they are looking at.
    expect(body.bundle.brief).toBe(gated.brief)
    expect(body.bundle.id).toBe(BUNDLE)
    expect(body.bundle.status).toBe('staged')
    expect(body.bundle.createdAt).toBe(gated.createdAt)
    expect(body.actions).toEqual([])
    // And the withheld read never happens, so the artifacts are not fetched and
    // then filtered — they are not fetched.
    expect(db.listMarketingArtifacts).not.toHaveBeenCalled()
  })

  it('shows the whole bundle once a prediction exists, and says the gate is still open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction })
    const body = await (await getBundle()).json()
    expect(body.predictionRequired).toBe(true)
    expect(body.prediction).toEqual(prediction)
    expect(body.artifacts).toHaveLength(1)
    expect(body.bundle.copy).toEqual(gated.copy)
  })

  it('refuses an unauthenticated read the same way its sibling routes do', async () => {
    const res = await getBundle({ 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })
})

describe('POST /api/marketing/bundles/:id/prediction', () => {
  it('stores the outcome against the open stage draft and answers 200', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    predictions.insertPrediction.mockResolvedValue({ created: true, prediction })
    const res = await post({ predictedOutcome: 'about 6 booked calls a week' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prediction, existed: false })
    expect(predictions.insertPrediction).toHaveBeenCalledWith({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'about 6 booked calls a week',
    })
  })

  it('answers 409 prediction_bundle_not_staged when no open stage draft exists', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })
    const res = await post({ predictedOutcome: 'six calls' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'prediction_bundle_not_staged' })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('answers 400 prediction_required_text on whitespace, and writes nothing', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await post({ predictedOutcome: '   ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'prediction_required_text' })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('answers 400 prediction_required_text when the field is missing altogether', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    expect((await post({})).status).toBe(400)
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('hands the existing prediction back with existed true instead of failing a second reviewer', async () => {
    // Two tabs, one draft. The loser did not do anything wrong, and the row that
    // is stored is the row they need to see.
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction })
    const res = await post({ predictedOutcome: 'mine' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prediction, existed: true })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('caps the outcome length so a paste of the whole bundle is not a prediction', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await post({ predictedOutcome: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'prediction_required_text' })
  })

  it('404s a bundle the tenant cannot see before it asks about gates', async () => {
    db.getMarketingBundle.mockResolvedValue(null)
    const res = await post({ predictedOutcome: 'six calls' })
    expect(res.status).toBe(404)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })

  it('401s without an identity, the same door as the GET', async () => {
    const res = await post({ predictedOutcome: 'six calls' }, { 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/api/marketing.test.ts tests/api/marketing-prediction.test.ts`
Expected: FAIL — the GET body lacks the two fields, `artifacts` is present when it should be gone, and `404 Cannot Found` for the POST.

- [ ] **Step 3: Change the bundle GET**

Modify `src/api/marketing.ts`. Add to the import block (line 9-10 area):

```ts
import { bundlePredictionGate, insertPrediction } from '../db/reviewer-predictions'
```

and above `createMarketingRouter`, beside `IdSchema`:

```ts
/**
 * The fields that carry a proposal, as opposed to a pointer to one.
 *
 * A gated bundle with no prediction gets these deleted rather than nulled, and
 * `artifacts` gets omitted from the response rather than returned empty: spec
 * section 8.2's whole argument is that a reviewer must not be able to read what
 * they have not yet committed to, and a `null` under a familiar key is a fact
 * about the shape of the proposal. `brief` stays because the owner wrote it, and
 * it is the only thing that tells them which bundle they are looking at.
 */
const PROSE_BUNDLE_KEYS = [
  'strategy',
  'copy',
  'mediaPlan',
  'funnelPlan',
  'analysis',
  'audienceNote',
] as const

// 2000 characters is a prediction. A pasted bundle is not one, and the cap is a
// schema rule rather than an `if` so the same number answers a missing field and
// an oversized one: both are `prediction_required_text`, both are 400.
const PredictionSchema = z.object({ predictedOutcome: z.string().trim().min(1).max(2000) })
```

then replace the body of `app.get('/bundles/:id', ...)` (lines 71-86) with:

```ts
    const bundle = await getMarketingBundle(gate.identity.tenantId, parsed.data)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const predictionGate = await bundlePredictionGate(gate.identity.tenantId, bundle.id)
    const actions = await listMarketingActions(gate.identity.tenantId, bundle.id)

    if (predictionGate.required && predictionGate.prediction === null) {
      const stripped: Record<string, unknown> = { ...bundle }
      for (const key of PROSE_BUNDLE_KEYS) delete stripped[key]
      // No artifacts read at all: a withheld list is still a list that was read,
      // and the console renders the gate from predictionRequired alone.
      return c.json({
        bundle: stripped,
        actions,
        predictionRequired: true,
        prediction: null,
      })
    }

    const artifacts = await listMarketingArtifacts(gate.identity.tenantId, bundle.id)
    return c.json({
      bundle,
      artifacts,
      actions,
      predictionRequired: predictionGate.required,
      prediction: predictionGate.prediction,
    })
```

- [ ] **Step 4: Add the prediction door**

Modify `src/api/marketing.ts`, inserting a new route immediately after the bundle GET's closing `})` (line 86) and before the `// Two staging doors` comment:

```ts
  // The cognitive forcing gate's write door (spec section 8.2). It stages
  // nothing and decides nothing: approving still goes through POST
  // /api/approvals/drafts/:id/decision, so this route only records what the
  // reviewer expected, which is the half of the device that makes the number
  // unfakeable after the fact.
  app.post('/bundles/:id/prediction', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    // The tenant check first, on purpose: bundlePredictionGate answers "is there
    // an open stage draft for this id", and letting a caller probe another
    // tenant's bundle through it would make a 409 leak the existence of a draft.
    const bundle = await getMarketingBundle(gate.identity.tenantId, parsed.data)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const body = await c.req.json().catch(() => null)
    const parsedBody = PredictionSchema.safeParse(body)
    if (!parsedBody.success) return c.json({ error: 'prediction_required_text' }, 400)
    // The schema trims before it measures, so the stored text has no trailing
    // newline and a whitespace-only field is the same 400 as a missing one.
    const outcome = parsedBody.data.predictedOutcome

    const predictionGate = await bundlePredictionGate(gate.identity.tenantId, bundle.id)
    if (!predictionGate.required) return c.json({ error: 'prediction_bundle_not_staged' }, 409)

    // A second submission is not a second prediction: the row that exists is the
    // answer, and `existed` is how the console says so without telling a reviewer
    // they failed.
    if (predictionGate.prediction !== null) {
      return c.json({ prediction: predictionGate.prediction, existed: true }, 200)
    }

    const stored = await insertPrediction({
      tenantId: gate.identity.tenantId,
      pendingWriteId: predictionGate.pendingWriteId,
      predictedOutcome: outcome,
    })
    return c.json({ prediction: stored.prediction, existed: !stored.created }, 200)
  })
```

`predictionGate.pendingWriteId` is not a second lookup and must not become one. Task 10's `bundlePredictionGate` answers the discriminated `PredictionGate` union, so the `if (!predictionGate.required)` return above narrows the rest of the body to `{ required: true; pendingWriteId: string; prediction: ReviewerPrediction | null }`, and the write target is already in hand. Two consequences the plan is accepting out loud: `required` *is* `pendingWriteId !== null` rather than a separate judgement, so the withhold decision and the write target cannot disagree, and a re-staged bundle moves to the new draft id, which starts the reviewer's prediction clean. That is why Step 1's mocks carry the field and the `insertPrediction` assertion names `DRAFT`.

- [ ] **Step 5: Run it green**

Run: `npx vitest run tests/api/marketing.test.ts tests/api/marketing-prediction.test.ts tests/db/reviewer-predictions.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint`
Expected: clean. The likely first failure is `stripped` widening past what `c.json` wants; the `Record<string, unknown>` copy is what fixes it, not a cast.

- [ ] **Step 6: Commit**

```bash
git add src/api/marketing.ts src/db/reviewer-predictions.ts \
  tests/api/marketing.test.ts tests/api/marketing-prediction.test.ts \
  tests/db/reviewer-predictions.test.ts
git commit -m "feat(api): the prediction door, and a bundle GET that withholds the proposal"
```

---

### Task 12: Serving the bytes, and closing the intake lane behind them

**Files:**
- Modify: `src/api/marketing.ts` (new `GET /assets/:documentId/bytes`)
- Modify: `src/db/documents.ts` (new `getDocumentKind(tenantId, documentId)`, the one-column read the guard needs)
- Modify: `src/mastra/workflows/ingest.ts` (`ingestStep` gains the `marketing_asset` branch from this plan's spec refinement 1)
- Test: `tests/api/marketing-asset-bytes.test.ts` (new)
- Test: `tests/mastra/workflows/ingest-asset-guard.test.ts` (new)
- Test: `tests/db/queries.test.ts` (append a `getDocumentKind` describe to the file's existing mock-pg harness)

**Interfaces:**
- Consumes: `getAssetBytes` and `listBundleIdsForDocument` (Task 5), `bundlePredictionGate` (Task 10, already imported by `src/api/marketing.ts` from Task 11 Step 4), `document_files.data` as `Uint8Array` the way Task 5's `getAssetBytes` returns it, `indexNameFor` and `crumEmbeddingModel` from the modules `ingest.ts` already imports.
- Produces: `GET /api/marketing/assets/:documentId/bytes` answering `200` with the raw bytes, the row's `mime`, and `Cache-Control: private, max-age=3600`; `getDocumentKind(tenantId: string, documentId: string): Promise<string | null>`; `shouldSkipIngest(kind: string | null): boolean`, exported because the guard's rule is worth naming separately from the async plumbing around it.

Task 12 is spec section 13's **4b** half: nothing in 4a needs it, and it is the first task that can be shipped without a Replicate token.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/marketing-asset-bytes.test.ts`:

```ts
// tests/api/marketing-asset-bytes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const assets = vi.hoisted(() => ({
  getAssetBytes: vi.fn(),
  listBundleIdsForDocument: vi.fn(),
}))

const predictions = vi.hoisted(() => ({
  bundlePredictionGate: vi.fn(),
  insertPrediction: vi.fn(),
}))

vi.mock('../../src/db/marketing-assets', () => ({
  getAssetBytes: assets.getAssetBytes,
  listBundleIdsForDocument: assets.listBundleIdsForDocument,
}))
vi.mock('../../src/db/reviewer-predictions', () => ({
  bundlePredictionGate: predictions.bundlePredictionGate,
  insertPrediction: predictions.insertPrediction,
  getPredictionForDraft: vi.fn(),
}))
vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: vi.fn(),
  listMarketingArtifacts: vi.fn(),
  listMarketingActions: vi.fn(),
  listAllCampaigns: vi.fn(),
}))
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const DOC = '99999999-9999-4999-8999-999999999999'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function fetchBytes(documentId = DOC, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/assets/${documentId}/bytes`, { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  assets.getAssetBytes.mockResolvedValue({
    kind: 'marketing_asset',
    status: 'needs_review',
    mime: 'image/png',
    data: PNG,
  })
  assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE])
  predictions.bundlePredictionGate.mockResolvedValue({
    required: false,
    prediction: null,
    pendingWriteId: null,
  })
})

describe('GET /api/marketing/assets/:documentId/bytes', () => {
  it('answers with the bytes, the mime and a private cache', async () => {
    const res = await fetchBytes()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('404s a document that is not an asset, rather than 403, so the route cannot probe invoices', async () => {
    assets.getAssetBytes.mockResolvedValue({
      kind: 'invoice',
      status: 'ready',
      mime: 'application/pdf',
      data: PNG,
    })
    const res = await fetchBytes()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s a document this tenant does not have', async () => {
    assets.getAssetBytes.mockResolvedValue(null)
    expect((await fetchBytes()).status).toBe(404)
  })

  it('refuses the picture while the owning bundle is gated and unpredicted', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({
      required: true,
      prediction: null,
      pendingWriteId: '44444444-4444-4444-8444-444444444444',
    })
    const res = await fetchBytes()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'prediction_required' })
  })

  it('serves the picture once a prediction exists, even while the gate is open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({
      required: true,
      prediction: {
        id: '55555555-5555-4555-8555-555555555555',
        tenantId: TENANT,
        pendingWriteId: '44444444-4444-4444-8444-444444444444',
        predictedOutcome: 'six calls',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      pendingWriteId: '44444444-4444-4444-8444-444444444444',
    })
    expect((await fetchBytes()).status).toBe(200)
  })

  it('checks every bundle the asset is attached to, and refuses if any one is gated', async () => {
    const other = '66666666-6666-4666-8666-666666666666'
    assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE, other])
    predictions.bundlePredictionGate.mockImplementation(
      async (_tenant: string, bundleId: string) =>
        bundleId === other
          ? { required: true, prediction: null, pendingWriteId: '44444444-4444-4444-8444-444444444444' }
          : { required: false, prediction: null, pendingWriteId: null },
    )
    const res = await fetchBytes()
    expect(res.status).toBe(409)
    // Both reads happened: an image reused across two campaigns is gated by the
    // stricter of them, not by whichever the query found first.
    expect(predictions.bundlePredictionGate).toHaveBeenCalledTimes(2)
  })

  it('serves an asset attached to nothing, because there is no decision to protect', async () => {
    assets.listBundleIdsForDocument.mockResolvedValue([])
    expect((await fetchBytes()).status).toBe(200)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })

  it('401s without an identity', async () => {
    expect((await fetchBytes(DOC, { 'x-user-role': 'auditor' })).status).toBe(401)
  })

  it('400s a document id that is not a uuid', async () => {
    expect((await fetchBytes('not-a-uuid')).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/api/marketing-asset-bytes.test.ts`
Expected: FAIL — every case, with `404` from Hono's own not-found rather than the route's, and no `content-type` header to read.

- [ ] **Step 3: Add the bytes route**

Modify `src/api/marketing.ts`. Add one import beside the marketing data imports at the top of the file (`bundlePredictionGate` is already there from Task 11 Step 4; do not import it twice):

```ts
import { getAssetBytes, listBundleIdsForDocument } from '../db/marketing-assets'
```

then insert a new route immediately after the prediction POST's closing `})` and before the `// Two staging doors, no deciding door` comment:

```ts
  // The picture itself (spec section 8.3). This is the only route in CRUM that
  // hands out stored bytes, and it is gated by the same prediction as the prose
  // for a reason worth stating: an image is the strongest suggestion in a bundle.
  // A reviewer who has not written down what they expect is exactly the reviewer
  // who nods at a nice render, so withholding the copy while serving the JPEG
  // would undo the device.
  app.get('/assets/:documentId/bytes', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = IdSchema.safeParse(c.req.param('documentId'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const asset = await getAssetBytes(gate.identity.tenantId, parsed.data)
    // 404 for both "no such row" and "that row is somebody's invoice".
    // getAssetBytes already restricts to `d.kind = 'marketing_asset'` in SQL, so
    // the second half of this condition is a belt rather than the lock; it stays
    // because the answer a probe gets must be byte-identical to the answer for a
    // document that does not exist, and a 403 would advertise a non-asset id.
    if (!asset || asset.kind !== 'marketing_asset') return c.json({ error: 'not_found' }, 404)

    // An asset can sit in two bundles when a campaign reuses a render. Every
    // owning bundle gets checked and the strictest one wins: one gated bundle is
    // enough, because showing the image to a reviewer who has not predicted for
    // *that* bundle is the leak, regardless of what the other bundle decided.
    const bundleIds = await listBundleIdsForDocument(gate.identity.tenantId, parsed.data)
    for (const bundleId of bundleIds) {
      const predictionGate = await bundlePredictionGate(gate.identity.tenantId, bundleId)
      if (predictionGate.required && predictionGate.prediction === null) {
        return c.json({ error: 'prediction_required' }, 409)
      }
    }

    return c.body(asset.data, 200, {
      'content-type': asset.mime || 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    })
  })
```

Two notes on that body. `c.body` with a `Uint8Array` is a valid `BodyInit` in Hono 4, and the explicit `content-type` header is what the test reads back, so do not "simplify" it by letting Hono infer a type — inference on a byte array yields no header at all. And `status` is deliberately *not* filtered: a `needs_review` asset is still shown once the reviewer has predicted, because the review in question is the owner's decision on the whole bundle, and the console labels the row from `listMarketingArtifacts` status anyway (Task 13). Spec section 8.3 lists the 404 and 409 cases and no status case; this is that omission resolved.

- [ ] **Step 4: Write the failing guard tests**

Create `tests/mastra/workflows/ingest-asset-guard.test.ts`. It mocks every module `ingestStep` reaches for, so the test is about ordering rather than about vectors:

```ts
// tests/mastra/workflows/ingest-asset-guard.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getDocumentKind: vi.fn(),
  embedMany: vi.fn(),
  withRagIngestion: vi.fn(),
  fromText: vi.fn(),
  createIndex: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('../../../src/db/documents', () => ({ getDocumentKind: h.getDocumentKind }))
vi.mock('ai', () => ({ embedMany: h.embedMany }))
vi.mock('@mastra/core/observability', () => ({ withRagIngestion: h.withRagIngestion }))
vi.mock('@mastra/rag', () => ({ MDocument: { fromText: h.fromText } }))
vi.mock('../../../src/mastra/embeddings', () => ({
  crumEmbeddingModel: vi.fn(() => 'fake-embedding-model'),
  EMBEDDING_MODEL_ID: 'openai/text-embedding-3-small',
}))
vi.mock('../../../src/mastra/vector-store', () => ({
  // The real indexNameFor returns a constant, and the guard returns it unchanged
  // on the skipped path; mirroring the constant here is what lets the assertion
  // below be an equality rather than a typeof check.
  indexNameFor: () => 'crum_knowledge',
  CRUM_VECTOR_CONFIG: { dimension: 1536, metric: 'cosine' },
  tenantVectorStoreResolver: vi.fn(async () => ({ createIndex: h.createIndex, upsert: h.upsert })),
}))

import { ingestStep, shouldSkipIngest } from '../../../src/mastra/workflows/ingest'

const TENANT = '11111111-1111-4111-8111-111111111111'
const DOC = '99999999-9999-4999-8999-999999999999'

// Only inputData is exercised; the execute-parameter union belongs to the
// framework contract, so the params are projected onto the real execute
// parameter type, which is the convention digest.mail.test.ts:40 already uses.
const params = {
  inputData: {
    documentId: DOC,
    tenantId: TENANT,
    text: 'a physio clinic reception at dawn',
    contentType: 'text',
    documentTitle: 'reception-hero.png',
  },
  requestContext: {},
  mastra: {},
  tracingContext: {},
} as unknown as Parameters<typeof ingestStep.execute>[0]

function run() {
  return ingestStep.execute!(params) as Promise<{ chunkCount: number; indexName: string }>
}

beforeEach(() => {
  vi.clearAllMocks()
  // The observability helper is a pass-through: a test that reaches the
  // embedding path really does embed, so what is being pinned is whether the
  // guard lets the step get that far at all.
  h.withRagIngestion.mockImplementation(async (_meta: unknown, fn: (ctx: unknown) => Promise<unknown>) => fn({}))
  h.fromText.mockReturnValue({
    chunk: async () => [{ text: 'a physio clinic reception at dawn', metadata: { startIndex: 0 } }],
  })
  h.createIndex.mockResolvedValue(undefined)
  h.upsert.mockResolvedValue(undefined)
  h.embedMany.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
})

describe('shouldSkipIngest', () => {
  it('skips only a marketing asset', () => {
    expect(shouldSkipIngest('marketing_asset')).toBe(true)
    expect(shouldSkipIngest('invoice')).toBe(false)
    expect(shouldSkipIngest('contract')).toBe(false)
    expect(shouldSkipIngest('other')).toBe(false)
    expect(shouldSkipIngest(null)).toBe(false)
  })
})

describe('ingestStep', () => {
  it('never chunks, embeds, wraps or upserts a marketing asset', async () => {
    h.getDocumentKind.mockResolvedValue('marketing_asset')
    expect(await run()).toEqual({ chunkCount: 0, indexName: 'crum_knowledge' })
    expect(h.getDocumentKind).toHaveBeenCalledWith(TENANT, DOC)
    expect(h.withRagIngestion).not.toHaveBeenCalled()
    expect(h.fromText).not.toHaveBeenCalled()
    expect(h.embedMany).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('still indexes an invoice, because the guard is one kind and not a kill switch', async () => {
    h.getDocumentKind.mockResolvedValue('invoice')
    expect((await run()).chunkCount).toBe(1)
    expect(h.embedMany).toHaveBeenCalledTimes(1)
    expect(h.upsert).toHaveBeenCalledTimes(1)
  })

  it('indexes a document the read could not find rather than swallowing it', async () => {
    // null means "no such row for this tenant", which is a caller bug or a race
    // with a delete, not a generated asset. Falling through is the conservative
    // choice: an unexpectedly indexed document is visible in the index, a
    // silently un-indexed one is only visible when somebody fails to find it.
    h.getDocumentKind.mockResolvedValue(null)
    await run()
    expect(h.upsert).toHaveBeenCalledTimes(1)
  })

  it('reads the kind before it opens the ingestion span', async () => {
    const order: string[] = []
    h.getDocumentKind.mockImplementation(async () => { order.push('kind'); return 'marketing_asset' })
    h.withRagIngestion.mockImplementation(async () => { order.push('span'); return { chunkCount: 0, indexName: 'crum_knowledge' } })
    await run()
    expect(order).toEqual(['kind'])
  })
})
```

- [ ] **Step 5: Run them to make sure they fail**

Run: `npx vitest run tests/mastra/workflows/ingest-asset-guard.test.ts`
Expected: FAIL at import time on all four cases — `shouldSkipIngest` is not exported from `src/mastra/workflows/ingest` yet, so the module namespace object has no such member and the describe bodies never get to assert. That is the right first red: the predicate's name is part of the contract.

- [ ] **Step 6: Write the guard**

Append to `tests/db/queries.test.ts`, at the end of the file, matching the per-`describe` `beforeEach` and dynamic-import style the rest of that file uses:

```ts
describe('getDocumentKind', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('scopes the read to the tenant as well as the id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ kind: 'marketing_asset' }] })
    const { getDocumentKind } = await import('../../src/db/documents')
    expect(await getDocumentKind('t1', 'd1')).toBe('marketing_asset')
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('id = $1')
    expect(sql).toContain('tenant_id = $2')
    expect(mockQuery.mock.calls[0]![1]).toEqual(['d1', 't1'])
  })

  it('returns null for a row the tenant cannot see', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getDocumentKind } = await import('../../src/db/documents')
    expect(await getDocumentKind('t1', 'd1')).toBeNull()
  })
})
```

Modify `src/db/documents.ts`, inserting after `getDocument` (which ends at line 419):

```ts
/**
 * The kind of one row, by tenant and id.
 *
 * This is the narrow read the ingest guard needs. `getDocument` is not usable
 * there: it takes a `TenantRequestContext`, and an ingest step has a tenant id
 * and a document id, not a user id and a role. Tenant scoping is the entire
 * security property of this lookup, which is why both columns are in the WHERE
 * clause rather than the id alone.
 */
export async function getDocumentKind(tenantId: string, documentId: string): Promise<string | null> {
  const rows = await queryRows<{ kind: string }>(
    `SELECT kind FROM documents WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [documentId, tenantId],
  )
  return rows[0]?.kind ?? null
}
```

`queryRows` is the file's private helper at line 154, already used by `getDocument` and `listDocuments`; use it rather than reaching for `getDbClient` directly.

Then modify `src/mastra/workflows/ingest.ts`. Add the import beside the existing ones:

```ts
import { getDocumentKind } from '../../db/documents'
```

and above `ingestStep`:

```ts
/**
 * The one rule that keeps generated image bytes out of the vector store.
 *
 * A marketing asset is a `documents` row so it can be hashed, attached and
 * reviewed, and a `document_files` row holding a PNG beside it is harmless. The
 * danger is the index: chunk and embed that row and the picture becomes
 * recallable knowledge, and the analyst quotes a render as if it were a fact the
 * business knows. Spec section 4.1 names this as the failure the slice exists to
 * avoid, and the reason the check sits here rather than in a router is that
 * `ingestStep` is the only place in CRUM where embedding happens — both
 * `crum-document-intake` and `knowledge-ingest` run through it, so one predicate
 * covers today's callers and any re-index path added later.
 */
export function shouldSkipIngest(kind: string | null): boolean {
  return kind === 'marketing_asset'
}
```

and inside `ingestStep`'s `execute`, so the guard sits ahead of the observability wrapper and ahead of `crumEmbeddingModel()`:

```ts
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const indexName = indexNameFor(inputData.tenantId)

    const kind = await getDocumentKind(inputData.tenantId, inputData.documentId)
    if (shouldSkipIngest(kind)) return Promise.resolve({ chunkCount: 0, indexName })

    const embeddingModel = crumEmbeddingModel()
```

The rest of `execute` is unchanged, including its own `const indexName = indexNameFor(...)` line — delete that duplicate rather than shadowing it, and leave `embeddingModel` where the guard now falls through to it. Order matters and the last test in Step 4 pins it: the check runs before `withRagIngestion` opens a span, because an embedded asset and an empty span are two different bugs and only the first one is worth a trace.

- [ ] **Step 7: Run it green, and check nothing else noticed**

Run: `npx vitest run tests/api/marketing-asset-bytes.test.ts tests/mastra/workflows/ingest-asset-guard.test.ts tests/db/queries.test.ts`
Expected: PASS on all three.

Run: `npx vitest run tests/mastra/ingest-workflow.test.ts tests/mastra/workflows/document-intake.test.ts tests/api/documents.test.ts`
Expected: PASS. The first two only assert step identity and pure helpers, so a guard inside `ingestStep` cannot break them; `tests/api/documents.test.ts` proves the upload route still runs intake for real invoices. If any of them fails, the guard is in the wrong place — fix the placement rather than the test.

Run: `npm run typecheck && npm run lint`
Expected: clean. `ingestStep.execute` is optional in Mastra's step type, which is why the test calls it through `execute!`; leaving the `!` is correct, and adding a runtime `if (!ingestStep.execute)` in the source would be noise.

- [ ] **Step 8: Commit**

```bash
git add src/api/marketing.ts src/db/documents.ts src/mastra/workflows/ingest.ts \
  tests/api/marketing-asset-bytes.test.ts tests/mastra/workflows/ingest-asset-guard.test.ts \
  tests/db/queries.test.ts
git commit -m "feat(marketing): serve asset bytes behind the gate, and keep them out of the index"
```

---

### Task 13: The console — gate the reviewer, then show them the picture

**Files:**
- Modify: `console/lib/types.ts` (`ReviewerPrediction`, the withheld read's shape, and `MarketingBundleResponse` becoming a union)
- Modify: `console/components/MarketingBundleView.tsx` (the gate panel, and the image where the "Slice 1 renders no image" sentence is)
- Test: `console/tests/MarketingBundleView.test.tsx` (the fixture grows two keys, the image case is rewritten, the gate cases are added)

**Interfaces:**
- Consumes: the bundle GET's `predictionRequired` / `prediction` keys and its withheld shape (Task 11 Step 3), the prediction POST's `{ prediction, existed }` body (Task 11 Step 4), `GET /api/marketing/assets/:documentId/bytes` (Task 12), and the console's own `/api/:path*` rewrite (`console/middleware.ts:22` matcher `['/api/:path*']`, `console/next.config.js:29`), which is what stamps the identity headers onto a request an `<img>` tag cannot set.
- Produces: `ReviewerPrediction`, `WithheldMarketingBundleRecord`, `MarketingBundleFullResponse`, `MarketingBundleWithheldResponse` in `console/lib/types.ts`, and a rendered `<img>` whose `src` is `/api/marketing/assets/{documentId}/bytes`.

The gate is the point of this task, not the picture. Spec section 8.2's device only works if the reviewer physically cannot read the proposal before committing a prediction to the record, and the server already enforces that (Task 11). The console's job is to make the enforced state legible rather than mysterious, and to put the one sentence that says why in the reviewer's way.

- [ ] **Step 1: Write the failing tests**

Modify `console/tests/MarketingBundleView.test.tsx`. Three edits to what is already there, then the new cases.

First, the type-only import at the top (lines 8-12) gains the withheld shape and the prediction:

```ts
import type {
  MarketingActionRecord,
  MarketingBundleResponse,
  ReviewerPrediction,
  WithheldMarketingBundleRecord,
} from '../lib/types'
```

Second, `bundleResponse()`'s returned object gains the two new keys, after `actions: []`:

```ts
    predictionRequired: false,
    prediction: null,
```

Third, replace the whole existing case `it('links an image artifact to its document instead of pretending to render it', ...)` (lines 98-118) with the two cases below, because its last assertion — `expect(screen.getByText(/renders no image/))` — is a sentence this task deletes:

```tsx
  it('renders a generated image inline and still links the document record', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            artifacts: [
              {
                id: 'a2',
                role: 'creative-designer',
                kind: 'image',
                documentId: DOCUMENT_ID,
                textContent: null,
                status: 'pending_review',
                createdAt: '2026-10-30T02:00:00.000Z',
              },
            ],
          }),
        ),
      ),
    ])

    const img = await screen.findByRole('img')
    expect(img).toHaveAttribute('src', `/api/marketing/assets/${DOCUMENT_ID}/bytes`)
    expect(img).toHaveAttribute('alt', expect.stringContaining('Generated image'))
    // The document link stays: the picture is what the reviewer looks at, the
    // record is what they audit, and only the second carries the hash.
    expect(screen.getByRole('link', { name: DOCUMENT_ID.slice(0, 8) })).toHaveAttribute(
      'href',
      `/api/documents/${DOCUMENT_ID}`,
    )
    expect(screen.queryByText(/renders no image/)).toBeNull()
  })

  it('keeps a bare document link for an artifact that has no prose and is not an image', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            artifacts: [
              {
                id: 'a3',
                role: 'marketer-copywriter',
                kind: 'page_html',
                documentId: DOCUMENT_ID,
                textContent: null,
                status: 'pending_review',
                createdAt: '2026-10-30T02:00:00.000Z',
              },
            ],
          }),
        ),
      ),
    ])

    expect(await screen.findByRole('link', { name: DOCUMENT_ID.slice(0, 8) })).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })
```

Then add the gate fixtures beside `bundleResponse`, above `mount`:

```ts
const PREDICTION: ReviewerPrediction = {
  id: '66666666-6666-4666-8666-666666666666',
  tenantId: '11111111-1111-4111-8111-111111111111',
  pendingWriteId: DRAFT_ID,
  predictedOutcome: 'About forty assessments a month, and a cost per lead under thirty dollars.',
  createdAt: '2026-10-30T02:10:00.000Z',
}

/**
 * The bundle as a gated read delivers it: the prose keys are absent, not null,
 * because src/api/marketing.ts deletes them (Task 11). Written out field by
 * field rather than destructured, so this fixture fails loudly when a field is
 * added on the server and the console's copy of the shape has to grow with it.
 */
function withheldBundle(): WithheldMarketingBundleRecord {
  const full = bundleResponse().bundle
  return {
    id: full.id,
    tenantId: full.tenantId,
    brief: full.brief,
    objective: full.objective,
    status: full.status,
    promptVersion: full.promptVersion,
    draftHash: full.draftHash,
    leadToken: full.leadToken,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
  }
}

function gatedRead(): MarketingBundleResponse {
  return { bundle: withheldBundle(), actions: [], predictionRequired: true, prediction: null }
}
```

and the gate cases at the end of the `describe('MarketingBundleView')` block:

```tsx
  it('withholds the prose and asks for a prediction first', async () => {
    mount([route('/api/marketing/bundles/', { status: 200, body: gatedRead() })])

    expect(await screen.findByText(/write down what you expect/i)).toBeInTheDocument()
    // The brief stays visible: the owner typed it, and it is the only thing on
    // the screen that says which bundle is being gated.
    expect(screen.getByText('Book more physio assessments in Melbourne')).toBeInTheDocument()
    expect(screen.getByText(/staged/)).toBeInTheDocument()
    // And the proposal does not.
    expect(screen.queryByText('Strategy')).toBeNull()
    expect(screen.queryByText('Media plan')).toBeNull()
    expect(screen.queryByText('Assets')).toBeNull()
    expect(screen.queryByText('Your next patient is already searching')).toBeNull()
    expect(screen.getByRole('button', { name: /Record my prediction/i })).toBeDisabled()
  })

  it('sends the prediction and reads the bundle again', async () => {
    let reads = 0
    mount([
      (call) => {
        if (call.method !== 'GET' || !call.url.includes('/api/marketing/bundles/')) return null
        reads += 1
        return reads === 1 ? { status: 200, body: gatedRead() } : ok(bundleResponse())
      },
      route('/prediction', { status: 200, body: { prediction: PREDICTION, existed: false } }, 'POST'),
    ])

    expect(await screen.findByText(/write down what you expect/i)).toBeInTheDocument()
    await userEvent.type(
      screen.getByLabelText(/what do you expect/i),
      'About forty assessments a month, and a cost per lead under thirty dollars.',
    )
    await userEvent.click(screen.getByRole('button', { name: /Record my prediction/i }))

    expect(await screen.findByText('Your next patient is already searching')).toBeInTheDocument()
    expect(reads).toBe(2)
    const sent = server.last(`/api/marketing/bundles/${BUNDLE_ID}/prediction`)
    expect(sent?.method).toBe('POST')
    expect(sent?.body).toEqual({
      predictedOutcome: 'About forty assessments a month, and a cost per lead under thirty dollars.',
    })
  })

  it('shows what was already predicted instead of asking twice', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(bundleResponse({ predictionRequired: true, prediction: PREDICTION })),
      ),
    ])

    expect(await screen.findByText('Your next patient is already searching')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record my prediction/i })).toBeNull()
    expect(screen.getByText(/forty assessments a month/)).toBeInTheDocument()
  })

  it('a 409 from an older plane is reported as a failure, not as a missing bundle', async () => {
    mount([
      route('/api/marketing/bundles/', { status: 409, body: { error: 'prediction_required' } }),
    ])
    // 409 is not 404 and not a readable bundle: the screen must say what the
    // plane answered rather than claim the bundle is missing.
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Bundle not found.')).toBeNull()
  })
```

The last case exists because the bytes route answers 409 while the bundle GET withholds instead: two mechanisms for one rule, and a console pointed at a server older than this slice gets a 409 from a route that had no gate before. `ApiError` already maps that to an `error` state, so this case passes on today's code and stays as the guard against someone "helpfully" folding 409 into the 404 branch later.

- [ ] **Step 2: Run them to make sure they fail**

Run from `D:/Code/CRUM/console`: `npx vitest run tests/MarketingBundleView.test.tsx`
Expected: FAIL. The fixture edits alone break the type-only import (`ReviewerPrediction` and `WithheldMarketingBundleRecord` do not exist yet), the image case finds no `img` role, and the gate cases find no textarea and no button. The last new case may already pass; that is expected and is why its comment says what it defends.

- [ ] **Step 3: Describe the two reads in the console's own types**

Modify `console/lib/types.ts`, replacing the single `MarketingBundleResponse` interface (lines 531-535) with:

```ts
// One prediction per staged draft (spec section 8.2). Duplicated from
// ReviewerPrediction in src/db/reviewer-predictions.ts for the same reason as
// every record above: the console talks HTTP and never imports src/.
export interface ReviewerPrediction {
  id: string
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
  createdAt: string
}

// The prose the server deletes from a gated bundle that has no prediction yet.
// This is the list src/api/marketing.ts calls PROSE_BUNDLE_KEYS, restated as a
// type rather than a string array so a key added on the server without being
// added here fails the console build instead of leaking through as `unknown`.
export type MarketingProseKey =
  | 'strategy'
  | 'copy'
  | 'mediaPlan'
  | 'funnelPlan'
  | 'analysis'
  | 'audienceNote'

export type WithheldMarketingBundleRecord = Omit<MarketingBundleRecord, MarketingProseKey>

export interface MarketingBundleFullResponse {
  bundle: MarketingBundleRecord
  artifacts: MarketingArtifactRecord[]
  actions: MarketingActionRecord[]
  predictionRequired: boolean
  prediction: ReviewerPrediction | null
}

export interface MarketingBundleWithheldResponse {
  // No `artifacts` key at all: src/api/marketing.ts does not read the artifact
  // list for a gated bundle, and a withheld read that sent `[]` would tell the
  // reviewer this bundle has no assets rather than that they have not earned
  // them yet.
  bundle: WithheldMarketingBundleRecord
  actions: MarketingActionRecord[]
  predictionRequired: true
  prediction: null
}

export type MarketingBundleResponse = MarketingBundleFullResponse | MarketingBundleWithheldResponse
```

`audienceNote` is in the withheld list even though `PageHeader` only shows it as a suffix, because `src/api/marketing.ts` deletes it: the console's type has to describe the response that is actually sent, not the response that would be more convenient.

- [ ] **Step 4: Put the gate in front of the prose**

Modify `console/components/MarketingBundleView.tsx`. Add the two new types to the existing `import type { ... } from '../lib/types'` block:

```ts
import type {
  MarketingActionRecord,
  MarketingArtifactRecord,
  MarketingBundleFullResponse,
  MarketingBundleRecord,
  MarketingBundleResponse,
  MarketingBundleWithheldResponse,
  ReviewerPrediction,
  WithheldMarketingBundleRecord,
} from '../lib/types'
```

Add the narrowing helper above `function Artifact`, next to the other module-level helpers:

```tsx
/**
 * The one runtime rule that decides which of the two reads arrived.
 *
 * `predictionRequired && !prediction` is the withheld case and nothing else:
 * Task 11's server sends exactly that pair when it has deleted the prose, and a
 * gated bundle whose reviewer has already predicted arrives as the full read
 * with `predictionRequired` still true. The union in lib/types cannot tell those
 * apart by itself, because `predictionRequired: boolean` is compatible with
 * `true`, so the judgement lives here as a named predicate and the REST tests
 * for both shapes (Task 11 Step 1) are what keep it honest.
 */
function isWithheldRead(data: MarketingBundleResponse): data is MarketingBundleWithheldResponse {
  return data.predictionRequired === true && data.prediction === null
}
```

Add the gate panel above `function Artifact` as well:

```tsx
/**
 * The cognitive forcing gate, as the reviewer meets it (spec section 8.2).
 *
 * The server already withheld the prose; this panel's job is to explain why the
 * page is empty instead of looking broken, and to keep the one field the
 * reviewer has to fill in unambiguous. It stages nothing and decides nothing:
 * approving still goes through the queue, so the only thing a prediction can
 * change is what the reviewer is able to see next.
 */
function PredictionGate({
  bundle,
  value,
  onChange,
  onSubmit,
  busy,
}: {
  bundle: WithheldMarketingBundleRecord
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  busy: boolean
}) {
  return (
    <div className="mt-4">
      <PageHeader
        title={bundle.brief}
        description={OBJECTIVE_LABEL[bundle.objective]}
        actions={<Badge variant={STATUS_VARIANT[bundle.status]}>{bundle.status}</Badge>}
      />
      <p className="mt-3 text-sm text-text-secondary">
        The proposal is hidden until you write down what you expect from it. Reading it first makes
        any decision look informed, so this screen asks for your guess while you still have to make
        one.
      </p>
      <label className="mt-4 block text-sm text-text-secondary" htmlFor="crum-prediction">
        What do you expect this bundle to achieve, and what would tell you it failed?
      </label>
      <textarea
        id="crum-prediction"
        className="focus-ring mt-2 w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary"
        rows={5}
        maxLength={2000}
        value={value}
        placeholder="Example: about forty assessments a month, and a cost per lead under thirty dollars."
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="mt-1 text-xs text-text-muted">
        Up to 2000 characters. Nothing here approves anything.
      </p>
      <Button
        className="mt-3"
        size="sm"
        variant="default"
        disabled={busy || value.trim() === ''}
        onClick={onSubmit}
      >
        Record my prediction
      </Button>
    </div>
  )
}
```

The `maxLength={2000}` is the same ceiling the route enforces (`PredictionSchema` in Task 11 caps the parse at 2000 and rejects longer text), so a reviewer who hits the limit sees the field stop rather than a request fail. `value.trim() === ''` mirrors the route's empty-after-trim 400 for the same reason.

Inside `MarketingBundleView`, add the state beside the existing `useState` block (after `const [missing, setMissing] = useState(false)`):

```ts
  const [gated, setGated] = useState<WithheldMarketingBundleRecord | null>(null)
  const [predictionText, setPredictionText] = useState('')
  const [predicted, setPredicted] = useState<ReviewerPrediction | null>(null)
```

`gated` is the withheld record, `predictionText` is what the reviewer is typing, and `predicted` is the stored row the full read carries. Three pieces of state because they are three different lifetimes: `gated` survives only until the POST lands, `predictionText` is cleared by the submit, and `predicted` comes back from the server on every read so the console never claims a prediction the database does not have.

Then, in `load`: add `setGated(null)` and `setPredicted(null)` beside the existing `setLoading(true)` / `setError(null)` / `setMissing(false)` resets at the top of the `try`, and insert this branch immediately after the `!data.bundle` guard's closing brace and before `const loadedArtifacts = data.artifacts ?? []`:

```ts
      if (isWithheldRead(data)) {
        // Render the gate rather than a half-empty bundle. The prose keys are
        // absent, `artifacts` is absent, and a screen that tried to draw both
        // would read as a campaign with nothing in it instead of a campaign the
        // reviewer has not earned yet.
        setGated(data.bundle)
        setBundle(null)
        setArtifacts([])
        setActions([])
        setFiles([])
        return
      }
```

Because `data` narrows to `MarketingBundleWithheldResponse` inside that branch, `data.artifacts` is not merely `undefined` at runtime — it does not exist in the type, which is what stops a later edit from quietly rendering a withheld read's artifact list.

Then add the submit handler beside the existing `async function stage(path: string)`:

```ts
  async function recordPrediction() {
    if (gated === null) return
    setBusy(true)
    setError(null)
    try {
      await post<{ prediction: ReviewerPrediction; existed: boolean }>(
        `/api/marketing/bundles/${encodeURIComponent(gated.id)}/prediction`,
        { predictedOutcome: predictionText.trim() },
      )
      setPredictionText('')
      // The re-read is the whole refresh: the server now returns the full read,
      // so the prose, the artifacts and the prediction row arrive through the
      // same path that already works rather than a second state machine.
      await load()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }
```

and one render branch. In the ternary chain, between the `error ? (...)` arm and the `bundle ? (...)` arm, insert:

```tsx
      ) : gated ? (
        <PredictionGate
          bundle={gated}
          value={predictionText}
          onChange={setPredictionText}
          onSubmit={() => void recordPrediction()}
          busy={busy}
        />
```

On the full-read path in `load`, set it with the other assignments — add `setPredicted(data.prediction)` directly above the existing `setBundle(data.bundle)` line. The withheld branch returns before it, and the resets at the top of the `try` already cleared `predicted` and `gated`, so no branch has to clear them twice.

Finally, inside the `bundle ? (...)` arm, show the prediction the reviewer committed to. Immediately after the closing `</dl>` of the metadata grid (the block ending with `<Row label="Saved">{bundle.createdAt}</Row>`), insert:

```tsx
          {predicted ? (
            <p className="mt-3 break-words text-sm text-text-secondary">
              You predicted: <span className="text-text-primary">{predicted.predictedOutcome}</span>{' '}
              <span className="text-text-muted">
                (recorded {predicted.createdAt.slice(0, 10)}, before this page was opened)
              </span>
            </p>
          ) : null}
```

That sentence is the device's payoff. It is on screen while the reviewer reads the proposal, and it says the thing a rubber stamp cannot survive: their own expectation, in their own words, timestamped before the reading. It is rendered from `predicted` rather than from `bundle` because the row is a fact about the reviewer's visit, not about the bundle — a bundle that has been re-saved and re-staged keeps its prose and gets a new draft, and the read answers with whichever prediction belongs to the draft that is open now.

- [ ] **Step 5: Draw the picture**

In the same file, replace the `Artifact` component (lines 225-253) with:

```tsx
function Artifact({ artifact }: { artifact: MarketingArtifactRecord }) {
  return (
    <li className="rounded-lg border border-border bg-bg-card p-3">
      <p className="text-xs uppercase tracking-[0.06em] text-text-muted">
        {artifact.role} · {artifact.kind} · {artifact.status}
      </p>
      {artifact.textContent !== null ? (
        <p className="mt-2 break-words whitespace-pre-wrap text-sm text-text-secondary">
          {artifact.textContent}
        </p>
      ) : artifact.kind === 'image' && artifact.documentId !== null ? (
        <>
          {/* The browser fetches this through the console's own /api rewrite,
              which stamps the identity headers the REST plane requires
              (console/middleware.ts:22), so an <img> needs no token, no blob
              dance and no client-side fetch. The gate holds even with the URL in
              hand: a gated bundle's read carries no artifacts at all, and
              src/api/marketing.ts answers 409 for the bytes of one (Task 12). */}
          <img
            src={`/api/marketing/assets/${encodeURIComponent(artifact.documentId)}/bytes`}
            alt={`Generated image ${artifact.id.slice(0, 8)}`}
            className="mt-2 max-h-72 w-full rounded-md border border-border object-contain"
            loading="lazy"
          />
          <p className="mt-2 text-sm text-text-secondary">
            Stored as document{' '}
            <a
              className="focus-ring underline underline-offset-2"
              href={`/api/documents/${encodeURIComponent(artifact.documentId)}`}
              target="_blank"
              rel="noreferrer"
            >
              {artifact.documentId.slice(0, 8)}
            </a>
            .
          </p>
        </>
      ) : artifact.documentId !== null ? (
        <p className="mt-2 text-sm text-text-secondary">
          Stored as document{' '}
          <a
            className="focus-ring underline underline-offset-2"
            href={`/api/documents/${encodeURIComponent(artifact.documentId)}`}
            target="_blank"
            rel="noreferrer"
          >
            {artifact.documentId.slice(0, 8)}
          </a>
          . This kind has no renderer: the link reads the document's JSON record.
        </p>
      ) : (
        <p className="mt-2 text-sm text-text-muted">No content recorded.</p>
      )}
    </li>
  )
}
```

The `kind === 'image'` test is a string compare against the widened `kind: string` field, exactly as `SITE_SLOTS` already does it: the console renders what the server says rather than branching on a union it cannot import. The order of the arms matters — a generated image's `textContent` is `null` by construction (Task 6 books `textContent: null` for every image artifact), but an artifact that somehow carries both gets shown as prose, because prose is what the reviewer was promised.

- [ ] **Step 6: Run it green, typecheck the console, commit**

Run from `D:/Code/CRUM/console`: `npx vitest run tests/MarketingBundleView.test.tsx tests/ApprovalQueue.test.tsx`
Expected: PASS on both. `ApprovalQueue` is in the run because the queue is the other place a reviewer reads a bundle, and it must not have grown a second copy of the gate's copy.

Run from `D:/Code/CRUM/console`: `npx tsc --noEmit -p tsconfig.json`
Expected: clean. The root `npm run typecheck` does not cover `console/` (its `tsconfig.json` includes `src` and `tests` only), so a console-only type error is invisible to the verify script and this command is the only thing that catches it.

Run from `D:/Code/CRUM`: `npm run typecheck && npm run lint`
Expected: clean — `MarketingBundleResponse` is referenced only by `console/`, so the server planes are untouched.

```bash
git add console/lib/types.ts console/components/MarketingBundleView.tsx \
  console/tests/MarketingBundleView.test.tsx
git commit -m "feat(console): the prediction gate, and the image it unlocks"
```

---

## Closing the slice: proof, report, and one paid walk

Task 14 covers both halves. It runs the gates, spends money exactly once, records what the slice does not do, and hands the branch to `superpowers:finishing-a-development-branch`.

### Task 14: Prove the slice, name the holes, and walk it once by hand

**Files:**
- Create: `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md`
- No source file changes. If this task finds a defect, fix it in the task that introduced it, re-run that task's tests, and record the fix in the report rather than editing here.

**Interfaces:**
- Consumes: everything above.
- Produces: the report, the residual list that slice 5's spec reads, and the one number that matters to the owner — what the walkthrough cost in real cents.

The baseline is the slice 3 report at `docs/superpowers/plans/2026-10-31-marketing-team-slice-3-verification.md`: typecheck 0 errors, lint 0 errors 0 warnings, unit suites Marketing 158 / Governance 245 / Mastra 482 / DB 133 / API 260, console 205 across 24 files. Every count below is compared against that, and every difference is explained — a number that grew without a new test file is a test that stopped asserting something.

- [ ] **Step 1: Static gates**

Run: `npm run typecheck && npm run lint`
Expected: both clean. `npm run verify` is not the check: it is red in this repository at backlog M1 (six integration failures unrelated to this slice), and a report that quotes it as though it were a gate is worse than no report.

- [ ] **Step 2: The unit suites this slice touched**

Run with explicit paths. Never a bare `--project unit`, and never `tests/evals` as a directory: `tests/evals/golden-gate.test.ts` lives in the unit project and calls the live model, and an unfiltered run of it costs about twelve model-minutes.

```bash
npx vitest run tests/marketing tests/governance tests/mastra tests/db tests/api \
  tests/config/env.test.ts tests/evals/dataset-seed.test.ts
```

Expected: PASS. The counts move as follows, and the report states each one as a number rather than as "green":

| Suite | Slice 3 | This slice | Why it moved |
|---|---:|---:|---|
| `tests/marketing` | 158 | +48 to +55 | Tasks 2-7 add `replicate`, `image-provider`, `image-spend`, `asset-prompts`, `generate-assets-tool`, `marketing-assets`, and the payload sweep case |
| `tests/governance` | 245 | +3 | Task 6's policy row (count 44, auto 7) and the `tools.yaml` surface case |
| `tests/mastra` | 482 | +14 | Task 6's registry and active-tool counts, Task 7's designer instructions, Task 9's boot-lane cases, Task 12's guard file |
| `tests/db` | 133 | +16 | Task 5's asset reads, Task 10's two files, Task 12's `getDocumentKind` |
| `tests/api` | 260 | +22 | Task 11's two files and Task 12's bytes route file |
| `tests/config` | in `env.test.ts` | +4 | Task 9's four vars |

If a suite is red, stop and fix it. Do not annotate the report around a failure.

- [ ] **Step 3: The console**

Run from `D:/Code/CRUM/console`: `npx vitest run`
Expected: PASS, 24 files, and the count over 205 — Task 13 adds four cases and removes one, so 208 net if nothing else moves. Then `npx tsc --noEmit -p tsconfig.json` in the same directory, which the root `npm run typecheck` does not cover.

- [ ] **Step 4: Integration, against the throwaway cluster**

Start Postgres per the Integration cluster at the top of this plan if port 5455 answers nothing, then:

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice4"
npx vitest run --project integration \
  tests/integration/migrations.test.ts \
  tests/integration/marketing-assets-migration.test.ts \
  tests/integration/marketing-generate-assets.test.ts \
  tests/integration/reviewer-predictions.test.ts
```

Expected: PASS on three files, and two named failures in `migrations.test.ts` that are baseline rather than news. `marketing-assets-migration.test.ts` is the one that proves `0021` both applies and leaves the widened `documents` CHECK working for invoice and contract rows. `marketing-generate-assets.test.ts` and `reviewer-predictions.test.ts` are the two new constraint proofs. If a file reports **skipped** rather than passed, the `CRUM_INTEGRATION_DATABASE_URL` export did not reach the shell. Report which of the two happened; a skip is not a pass.

`migrations.test.ts` carries two failures that predate this slice, and Task 1 confirmed both against the repository while it was proving 0021 applies cleanly:

- `refuses a second receipt for the same staged draft` — its `pending_writes` INSERT at `tests/integration/migrations.test.ts:100-101` omits `draft_hash`, which `migrations/0003_crum_add_draft_hash.sql:21` made NOT NULL with no default. It fails on every database created after 0003, which is every database in existence.
- `boots through main()` — it asserts that `result.applied` contains `0002`, so it passes only on a genuinely empty database and loses that race on the shared `crum_slice4`, because the other three files in this very command call `migrate()` in their own `beforeAll`. `scripts/db-migrate.ts:96-149` has no advisory lock, so on a fresh cluster two workers can apply the same version and one dies on the `version` PRIMARY KEY.

So run this command and report the two above by name as baseline, exactly as the slice 3 report did for the six. Do not "fix" `migrations.test.ts` here — the assertion it is missing belongs to whoever takes backlog M1, and a slice 4 commit that edits an unrelated integration fixture would be invisible in the report and unforgettable in review. If you want the whole-chain proof for yourself, make a scratch database (`createdb -h localhost -p 5455 crum_s4_probe`), point `DATABASE_URL` at it, run `npm run db:migrate` and then this one file, and report what you saw. Then drop it. That is also the honest answer to "does 0021 apply from empty", which the shared database can no longer tell you once it has been migrated.

Then run the older integration files whose tables this slice's migration touches, so a moved rule cannot hide behind a new one:

```bash
npx vitest run --project integration \
  tests/integration/pending-writes.test.ts \
  tests/integration/approval-expiry.test.ts \
  tests/integration/marketing-bundle.test.ts \
  tests/integration/marketing-publish-migration.test.ts \
  tests/integration/marketing-publish.test.ts \
  tests/integration/marketing-leads.test.ts \
  tests/integration/marketing-metrics-migration.test.ts
```

Expected: PASS on seven files. Those are every `tests/integration` file that names `pending_writes` or a marketing table today, checked with `grep -l CRUM_INTEGRATION_DATABASE_URL tests/integration/*.ts`. `pending-writes.test.ts` and `approval-expiry.test.ts` are in the list because `getOpenStageDraft` reads `receipt_id IS NULL`, `rejected_at IS NULL` and `expires_at > now()` directly rather than through the module that owns those rules. Out of scope on purpose: `tenant-isolation.test.ts`, `user-isolation.test.ts`, `wave1b-queries.test.ts`, `om-client-history.test.ts`, `analyst-cron.test.ts` and `semantic-recall.test.ts` touch none of this slice's tables, and `semantic-recall.test.ts` needs a working embedder on top of the database, so it is not a check this plan can afford to run.

- [ ] **Step 5: The one paid model run**

This is the only step in the plan that spends money on a model, and it runs once.

```bash
npx vitest run tests/evals/golden-gate.test.ts 2>&1 | tee /tmp/crum-slice4-golden-gate.log
```

Expected: PASS with 43 golden items, 11 of them `write`. Task 7 added one item, so a count of 42 means the dataset seed did not pick it up and the gate is green for the wrong reason.

Two rules for this step. Do not re-run it on a whim: an assertion failure is investigated against the log and the fixture first, and only re-run once the cause is fixed. And if the new designer item's output names an aspect ratio the provider would refuse, that is a real finding about Task 7's instruction — record it in the report and fix the instruction, not the scorer.

- [ ] **Step 6: The manual walkthrough — the only place provider bytes are touched**

No automated test in this slice calls Replicate, and that is deliberate: a mocked provider proves the arithmetic and the refusal chain, and only a real run proves the request body. Spec section 10's opening rule holds — provider bytes are hit here and nowhere else.

4a needs `CRUM_REPLICATE_API_TOKEN` from the owner. Without it, run the steps marked **[4b]**, and record 4a as blocked rather than as passing.

```bash
# owner-supplied. Never written to .env, .env.example or a committed file.
export CRUM_REPLICATE_API_TOKEN='...'
export CRUM_IMAGE_SPEND_CEILING_MINOR=40
export CRUM_IMAGE_COST_MINOR_PER_IMAGE=4
export CRUM_REPLICATE_MODEL='black-forest-labs/flux-1.1-pro'
export DATABASE_URL='postgres://crum_test@localhost:5455/crum_slice4'
export CRUM_DEV_TENANT_ID=... CRUM_DEV_USER_ID=... CRUM_DEV_USER_ROLE=admin
npm run dev:all
(cd console && npm run dev)
```

Then, in order, in the console at `http://localhost:3100`:

6.1 Ask the orchestrator, in chat, for a campaign for a Melbourne physio clinic with four creative assets. Confirm the designer's artifact row has an `assets` array with four entries and that every `aspectRatio` is one the provider accepts. **[4a]**

6.2 Ask for the asset pass. Expect four generated images, four `documents` rows of kind `marketing_asset` at `needs_review`, four `marketing_artifacts` rows of kind `image`, and four `marketing_image_spend` rows. Read the ledger with `psql`:

```bash
"/c/Program Files/PostgreSQL/17/bin/psql.exe" -h localhost -p 5455 -U crum_test -d crum_slice4 -c \
  "SELECT cost_minor, provider, document_id IS NOT NULL AS has_doc,
          raw_extract->>'predictionId' AS prediction, spent_on
     FROM marketing_image_spend ORDER BY created_at"
```

The total is what the day actually cost, and it is the number that goes in the report. Every row names a prediction id: that is spec refinement 3 checked by eye, and it is what would let an owner re-fetch a prediction whose bytes failed to download. **[4a]**

6.3 Ask for the asset pass again on the same bundle. Expect the tool to **succeed**, not to refuse: four assets in the response, all with `deduplicated: true` and `costMinor: 0`, and expect **zero** new `marketing_image_spend` rows and zero new Replicate predictions. The reuse is the `carried` branch (Task 6's Step 6), which never reaches the provider. This is the dedup proof, and it is the difference between a ceiling and a drain. **[4a]**

6.4 With the ceiling still where it is, ask for a **second** campaign bundle through the normal chat path, let the designer write its four prompts, then ask for that bundle's asset pass. Because bundle one's run already consumed the day, the expectation is `image_spend_ceiling_reached` on every asset, no `documents` rows, no spend rows, and one `human_tasks` row whose body names the code. Do not lower `CRUM_IMAGE_SPEND_CEILING_MINOR` to force this: an estimate that only fits by editing config tests the arithmetic Task 4 already proves in a unit, while the second bundle tests the thing nothing else does, which is that the ceiling is per tenant per day rather than per bundle. **[4a]**

6.5 Go back to the **first** bundle, whose four images are still `needs_review`, and ask for it to be staged. Expect the refusal that names them (`unreviewed images: ...`), because a reviewer must not approve a page whose picture nobody has looked at. This is Task 8's guard, so it belongs to 4a even though it reads best after the console steps below. Then flip one image to `ready` through the document review screen and stage again: still refused, now naming the three that remain. **[4a]**

6.6 Open the bundle in the console. Expect the prediction panel, no prose, and no `Assets` section. Type a prediction and submit. Expect the prose, the artifacts, the image drawn inline, and the "You predicted:" line. Reload the page: the prediction stays, because it came from the read rather than from the click. **[4b]**

6.7 Copy the image's URL out of the `<img>` and open it in a private window with no identity headers. Expect `401`. Then, for a bundle with an open stage draft and no prediction, request its asset bytes with a valid identity: expect `409 prediction_required`. **[4b]**

6.8 Approve the staged bundle in the queue. Expect the approval to commit and the outbox to run. Then look at the published page for the picture — this is the residual check, and it is expected to show nothing. See Step 7's hole 1. **[4b]**

- [ ] **Step 7: Write the report**

Create `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md` in the shape the slice 3 report uses (Date, Branch, Commit, range, then the runs, then what was fixed, then what is left), and put these six holes in it by name. Five were decided during planning and are recorded here so the next slice inherits them as decisions rather than as surprises. The sixth was found while writing this plan, belongs to slice 3, and is listed so it is not mistaken for slice 4 damage:

1. **A generated image never reaches a published page.** The publisher's `SITE_SLOTS` admits `page_html` and `thank_you_html` and nothing else, so an `image` artifact is stored, reviewable and viewable in the console, but is not uploaded and not linked from the site. Spec section 9 deferred placement to slice 5, and Task 13 does not change it. The fix is a slot with a content-addressed file name plus an `<img>` in the page template, which is a publisher change and therefore an approval-surface change.
2. **Generating after staging leaves the draft stale.** Task 8 refuses a stage that carries unreviewed images, but nothing refuses the reverse order: generate, stage, then generate again, and the approval still points at the old artifact set while the bundle now holds more. `applyDraft` re-checks the payload hash, not the asset set, so the approval still commits. Spec section 6.1's reason for the stage guard was that a reviewer must not approve a page whose pictures arrived after they read it, and this is the same failure with the doors in the other order. Slice 5's re-stage invalidation is the fix; a `human_tasks` warning is the interim.
3. **The ceiling is per tenant per day, not per bundle.** `committedSpendMinor(tenantId)` sums `WHERE spent_on = CURRENT_DATE`, so one tenant's four campaigns compete for one number and a second bundle gets `image_spend_ceiling_reached` because the first bundle spent the day. The ledger row carries `document_id` and the tool records the bundle in the human task, so the data to make it per-bundle exists; the env var does not encode it.
4. **One provider, no fallback, and a refusal is not a refund.** A Replicate outage produces `image_generation_failed`, books the charge if the provider charged, and stops the run. There is no second adapter, and the seam (`setImageAdapter`) is a module-global singleton — safe today because `createCrumMastra` runs per request and one adapter serves every tenant, but it would not survive two adapters.
5. **`marketing_asset` rows are invisible in the document manager.** Task 1 excludes kind `marketing_asset` from `listDocuments` unless a caller asks for it, which is right for an invoice list and wrong for an owner who wants to browse what the designer made. The bundle screen is currently the only path to an asset.
6. **Found while writing this plan, not caused by it: `marketing.set_campaign_status` is declared and has no tool.** `policy/tools.yaml` names it, `src/mastra/processors/write-claim-guard.ts:24` lists it, `tests/governance/policy.test.ts` counts it in the 43, and `tests/mastra/active-tools.test.ts` hands it to an admin, yet `src/mastra/agent.ts`'s `crumToolRegistry` has no `'marketing.set_campaign_status'` key and `src/mastra/tools/marketing-writes.ts:776` exports only the `stageCampaignStatusChange` function that the analyst cron calls directly. Confirmed by a set difference between the policy names and the registry keys: the registry holds 40, the policy declares 43, and the three absent are `crm.bulk_import` (refuse class, deliberately unreachable), `run.side-effect` (a workflow, not a tool), and this one. So the analyst's recommended pause can reach `pending_writes` from the cron but no conversation can, and the governance counts describe a capability the agent does not have. Slice 4 must not fix it inside a task: it would move the registry count by two, mix a slice 3 repair into a slice 4 commit, and need its own tests. Report it as a one-tool task for slice 5, with the registry key, the `createTool` wrapper around the existing function, and the two count assertions that then move together.

Record also, plainly: which steps ran and which were blocked for want of a token; the real cent figure from 6.2; the golden-gate item count; and the exact commands for anything that cannot be re-run later, since a spend ledger is a fact about a day and tomorrow it reads differently.

- [ ] **Step 8: Commit**

`docs/` is gitignored in this repository, so the plan and the report both need `-f`:

```bash
git add -f docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md
git commit -m "docs(marketing): slice 4 verification report"
```

Then run `superpowers:finishing-a-development-branch` for the whole slice, after a whole-branch review pass over the fourteen tasks.

Do not stage `.env.example`, `src/mastra/memory.ts`, `src/mastra/recall.ts`, `tests/mastra/memory.test.ts` or `tests/mastra/recall.test.ts` in this or any commit: they carry another effort's uncommitted work. `git add` takes an explicit file list, every time.

## Self-review record

Three checks, run against the repository rather than against this document.

**Spec coverage.** Section by section against `2026-11-01-marketing-team-slice-4-design.md`. Sections 1 to 3 (what this is, the rule that keeps it survivable, the architecture) become this plan's Global constraints and the 4a/4b split rather than a task. Section 4.1's widened `documents` lane is Tasks 1 and 2, and its "never reach the vector index" goal is Task 12 through spec refinement 1. Section 4.2's ledger is Tasks 1 and 4, with the ceiling's number supplied by Task 9. Section 4.3's prediction record is Tasks 1 and 10. Sections 5.1 and 5.2 (the three calls and the byte download) are Task 3. Section 5.3's eight-row refusal table is covered in order: no token is Task 9's conditional registration plus Task 6's call-time refusal, the ceiling and the per-asset rows are Task 6, `prompt_too_long`, `unsupported_aspect_ratio`, `image_generation_failed`, `image_generation_timeout` and `asset_too_large` are Task 3's `ImageFailureCode` union, and the hash hit is the non-refusal — `deduplicated: true`, no new row, no new spend — in Tasks 5 and 6. Section 5.4's "record what Replicate reports, do not estimate" is `costUsdToMinor` in Task 3 and `raw_extract`'s `costUsd` in Task 4. Section 6's tool is Tasks 5, 6 and 7, with the draft question settled by refinement 2, and section 6.1's new review gate is Task 8. Section 7's designer and section 7.2's "the primary agent has to be told" are both Task 7. Sections 8.1 to 8.4 are Tasks 10, 11 and 12 for the read and write doors and Task 13 for what the reviewer sees. Section 9 is Tasks 1, 4, 6, and 12's error bodies, plus refinement 3. Section 10's test list is every task's Step 1 and Task 14's four gates. Section 11's non-goals are built by nobody, and where a non-goal leaves a hole an owner will notice it is in Task 14's residual list. Section 12's file map is each task's Files block, and the one row that moved — intake refusal out of `src/api/documents.ts` and into `ingestStep` — is refinement 1, recorded where it lands. Section 13's slice split is the two sub-slice headings. Section 14's three owner questions already carry conservative defaults in the spec, and Task 9 ships exactly those: FLUX 1.1 Pro, a 2000 minor-unit ceiling, four minor units per image, and the token in `PRODUCTION_REQUIRED_SECRETS`. Where an owner wants different numbers, Task 14's Step 6 walkthrough is the place they see what those numbers bought.

**Placeholders.** No step says "add appropriate validation", "similar to Task N", or "check the real column name before running". Where a step needs a fact about the repository, the fact is stated and is the one this review verified on disk: the NOT NULL column list of `pending_writes`, the `title`/`body` pair that carries a refusal's prose in `human_tasks`, the registry-count assertion at `tests/mastra/agent.test.ts:51-53`, the six-file set that declares the tool surface, and the two spaces `crumToolRegistry` is keyed at.

**Type consistency.** `PredictionGate` is the union Task 10 declares in every place Tasks 11 and 12 use it, including the ten mocks in Task 11's Step 1; `ImageAdapter`, `ReplicateAdapterParams`, `ReplicateConfig`, `ImageOutcome`, `SpendRawExtract`, `GenerateAssetsRiskView`, `ReviewerPrediction`, `AssetPrompt` and `AssetProvenance` are declared once and consumed with the same field names everywhere; `recordImageSpend`'s fifth parameter reaches Task 1's column list, Task 4's unit assertions, and all three of Task 6's `toHaveBeenCalledWith` cases, each of which also carries `provider` now that the tool passes the adapter's own. The counts that tests assert are the counts after this slice: `policy.test.ts:57` 44 declared tools, `:68` 22 read-only, `:69` 7 auto, `:70` 14 approval unchanged, `:71` one refuse unchanged; `agent.test.ts:51-53` 41 registry keys titled `7 auto`; `active-tools.test.ts` 29 for a user and 42 for an admin; `write-claim-guard.test.ts:52` 16 mutating ids; `dataset-seed.test.ts` and `golden-gate.test.ts` both 43 items with 11 `write`.

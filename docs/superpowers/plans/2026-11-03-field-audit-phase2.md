# Field Audit Phase 2: Validation Rules Engine and Review Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Phase 1 audit data a consumer. Validate every extracted invoice and contract value, show the findings next to the per-field confidence in the console, let a reviewer correct or waive them, and report the result as numbers and as a CSV.

**Architecture:** A pure TypeScript rules engine evaluates a record bundle against 19 catalogued rules. Findings persist as one row per live finding in `document_validation`. The intake workflow calls the engine before it decides a document's status, so an arithmetic failure queues a document even at high confidence. Six new REST routes expose findings, a prioritised review queue, aggregates and a CSV export. The console document surface grows a review mode that reads all of it and corrects through the Phase 1 `PATCH` routes.

**Tech Stack:** PostgreSQL 17, TypeScript ESM, Hono, Mastra workflow steps, Vitest, the Next.js React console. No new npm dependency anywhere in this plan.

**Spec:** `docs/superpowers/specs/2026-11-03-field-audit-phase2-design.md`. The spec is the authority the plan argues from. Sections 5, 6, 7, 9 and 11 carry the exact types, the full rule table, the DDL, the route contracts and the metric definitions. This plan names which spec rows a task implements and how they are tested rather than restating them. Read both files.

## Global Constraints

1. PostgreSQL 17. A migration file carries a 4-digit prefix, must not reuse an existing number, and must not contain `BEGIN` or `COMMIT`, because `scripts/db-migrate.ts` wraps each file and its version record in one transaction. The next free number is `0024`.
2. No new npm dependency. Not for charts, not for CSV, not for currency codes, not for dates.
3. Every query takes the tenant predicate. `document_validation.tenant_id` is written from the caller's identity, never copied from the document row.
4. Import extensions follow ruling R35, not a single repo-wide suffix. Measured: 505 extensionless relative imports against 19 with `.js`, and all 19 live in the async-intake surface Task 1 copied (`src/queue`, `src/temporal`, `src/mastra/{adaptive-extraction,multi-format-parser}.ts`). `tsconfig.json` sets `moduleResolution: "bundler"` and every entry point runs through `tsx` or `mastra dev/build`, never raw `node dist/`, so both forms resolve in both test and production paths. The rule is therefore: a file you modify keeps the convention already used by the other imports in that file (`src/api` and `src/db` are extensionless), and a file you create uses the form written in this plan's code blocks. Never "fix" an existing file's suffixes as a drive-by.
5. `pg` returns `numeric` as a string. Treat `''`, `null` and `NaN` as absent, never as zero.
6. Nothing under `src/validation/` may import `pg`, read `process.env`, or consult the wall clock. The date arrives as `ValidationContext.today`. `Date.UTC` inside `parseDate` validates fields of a supplied string and never reads today. **Calendar-day frame (R45):** a stored day is read *as written*, and no zone conversion happens anywhere in this layer. `localDay` in `src/validation/index.ts` is the only renderer of a calendar day, used for a `date` column arriving as a `Date` and for the `today` a caller puts in `ValidationContext`; `parseDate` matches a time and offset part and then drops them rather than converting. Callers outside the module read the clock themselves — `localDay(new Date())` at a route or workflow step — because the required parameter is what keeps that read visible at the boundary. The one place UTC arithmetic is right is `timestamptz` window maths (Tasks 12 and 13), which never compares against a stored day; there, build and render must both use the same zone inside the same function. **Ruling R54 settles which zone: local.** The window's `today` is `localDay(new Date())`, so an edge built at UTC midnight would end "the 90 days ending today" at 11:00 local on the last day on this box (UTC+11) and silently drop that afternoon's rows. `dayToMs` therefore builds with `new Date(y, m - 1, d).getTime()`, and the label renders through the same local-day renderer the rest of the system uses. A DST day is 23 or 25 hours and `Math.round` over 86_400_000 still counts it as one.
7. Unit tests live under `tests/**/*.test.ts` (vitest project `unit`), integration tests under `tests/integration/**` (project `integration`). A test that touches the database loads `.env` before importing anything that reads it, copying lines 1-12 of `tests/db/field-audit.test.ts`.
8. The gate for every task, in order: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run <touched files>`, then commit.
9. The primary tree at `D:\Code\CRUM` is occupied by a live `feat/marketing-slice-5` run. Phase 2 never writes there. Every command in this plan runs from `D:\Code\CRUM\.qoder\worktrees\field-audit-phase2`, and nothing outside that directory is staged or committed.
10. `tests/evals/golden-gate.test.ts` fails on this machine for the environmental reason recorded in `DOCUMENT_PROCESSING_STATUS.md` section 7. It is a known baseline failure, not a regression, and the final report names it rather than hiding it.
11. Console tests use the existing setup in `console/vitest.config.ts` and the patterns in `console/tests/DocumentManager.test.tsx`. `console/` is a separate npm workspace, so console commands run with `dir_path` set to `D:\Code\CRUM\.qoder\worktrees\field-audit-phase2\console`.
12. A test that touches the database runs against the live `DATABASE_URL` from `.env`, which this worktree carries as a copy. `tests/integration/**` additionally gate on `CRUM_INTEGRATION_DATABASE_URL` and skip without it; a skip is not a pass, and a task whose deliverable is an integration test says in its report whether the file ran or skipped.
13. Identity headers are `x-tenant-id`, `x-user-id` and `x-user-role` (`src/mastra/identity.ts:35-37`), and all three are mandatory: `TenantRequestContextSchema` requires `userRole` as `z.enum(['user', 'admin'])` (`src/mastra/tenant-context.ts:6`), so a request that omits it is rejected with 401 `missing-claim` before any route body runs. Every test in this plan sends `'x-user-role': 'admin'`. An earlier revision of these listings invented a `x-crum-*` pair and omitted the role; corrected at ruling R52 before Task 12.
14. The `seedInvoice` helper that Task 9 shipped into `tests/api/document-validation.test.ts` declares all four amount fields as required, while 41 of the 42 `seedInvoice(server.db, ...)` call sites written into Tasks 10 through 13 omit at least one of them (39 pass `total` alone; measured by `grep -c`). They do not typecheck against the helper as written. Copy it, then widen the parameter to `fields: { subtotal?: string; tax?: string; total?: string; currency?: string }` and insert `fields.subtotal ?? null` for each column. Do not substitute default amounts for the omitted ones: every column of `invoices` is nullable (`migrations/0009_crum_documents.sql:54-65`), constraint 5 makes `null` the absence a rule keys on, and a defaulted `subtotal` would fire `invoice.total.sum` on a row the test seeded as incidental. Each test file keeps its own copy, so this is a per-file one-line change.

## File Structure

| Path | New or modified | Responsibility |
| --- | --- | --- |
| `src/validation/types.ts` | new | `Severity`, `Violation`, `ValidationContext`, `DocumentRecordBundle`, `ValidationRule`. Types only. |
| `src/validation/values.ts` | new | The primitives every rule shares: `isAbsent`, `parseAmount`, `parseDate`, `isEmail`, `isCurrencyShape`, plus the two tolerance constants. Pure. |
| `src/validation/rules.ts` | new | The 19-entry catalogue. One `run` per entry, no shared control flow between entries. |
| `src/validation/index.ts` | new | `RULESET_VERSION`, `evaluate`, `buildBundle`, `localDay`. The only module other layers import. |
| `migrations/0024_crum_field_validation.sql` | new | `document_validation` and its three indexes. |
| `migrations/0025_crum_audit_user_placeholder_guard.sql` | new | `log_field_changes()` restated with one changed line, so the actor cast survives the custom GUC's `''` placeholder. |
| `src/db/validation.ts` | new | Every read and write over `document_validation`: `replaceValidation`, `listViolations`, `waiveViolation`, `openCounts` (Task 7), `reviewQueue` (Task 11), `reviewAnalytics` (Task 12), `exportAuditRows` (Task 13). |
| `src/mastra/workflows/document-intake.ts` | modify | Validate the bundle before the status decision, persist findings, widen the review trigger. |
| `src/api/documents.ts` | modify | Six new routes, the H3 projection fix, re-validation after a correction. |
| `src/api/audit-csv.ts` | new | RFC 4180 quoting and the BOM-prefixed rows-to-text render. Pure: it takes an array of already-loaded rows and returns a string. |
| `console/lib/review.ts` | new | View types and fetchers for validation, queue, analytics and export. |
| `console/components/FieldConfidenceChip.tsx` | new | One field's confidence, colour-graded against the intake threshold. |
| `console/components/FindingList.tsx` | new | Findings for a field or for the lines block, with waive. |
| `console/components/EditableField.tsx` | new | Value, correction input, mandatory reason, `PATCH`. |
| `console/components/AuditTrail.tsx` | new | Phase 1 audit rows as an old-to-new diff list. |
| `console/components/ReviewAnalytics.tsx` | new | The analytics panel and the export button. |
| `console/components/DocumentManager.tsx` | modify | Review mode: queue filter, editable detail views, audit panel. |
| `console/components/SidebarNav.tsx` | clean, modify only if a deep link is added | Leave alone unless Task 15 needs it. |

Tests mirror it: `tests/validation/{values,evaluate,rules-invoice,rules-contract}.test.ts`, `tests/db/{validation,audit-context-isolation,audit-context-placeholder}.test.ts`, `tests/api/{document-validation,review-queue,analytics,audit-export}.test.ts`, `tests/integration/correction-revalidates.test.ts`, `console/tests/{FindingList,EditableField,AuditTrail,DocumentManagerReviewMode,ReviewAnalytics}.test.tsx`. Fifteen test files, one per deliverable that a reviewer could reject on its own.

## Task Order and Why

Tasks 1 and 2 are prerequisites, not features. Task 2 fixes the provenance leak in `H4` because Tasks 9 and 10 write audit rows through the same connection, and an unfixed leak would corrupt the very counts Task 12 reports. Tasks 3 to 5 build the engine bottom-up so each layer is testable before the next consumes it. Tasks 6 to 8 persist and wire it. Tasks 9 to 13 are the read and write surface. Tasks 14 to 17 are the console. Task 18 verifies the whole.

Tasks 11, 12 and 13 are NOT parallel despite being three separate routes: each appends to `src/db/validation.ts`, each registers a route in `src/api/documents.ts`, and 12 consumes `intQuery` from 11 while 13 consumes `parseAnalyticsWindow` from 12. Run them strictly in order. Tasks 14, 15 and 16 all edit `DocumentManager.tsx` and must also run sequentially. The only genuinely parallel pair in this plan is 11 against 10.

---

### Task 1: Isolate Phase 2 in its own worktree

Ruling R27 — this task was a checkpoint commit of the uncommitted async-intake work until the tree was re-measured at execution time. The primary working tree at `D:\Code\CRUM` is occupied: a second SDD run is live on `feat/marketing-slice-5`, it committed at 17:23:48 and 17:24:35, and `src/mastra/tools/marketing-writes.ts` was written at 17:45:31 while this plan was being read. Committing there would drop a 29-path checkpoint inside that run's review windows, and Tasks 14 to 17 rewrite `console/components/DocumentManager.tsx`, which that run's own Task 19 brief already flags as shared console surface. So Phase 2 gets a worktree and the primary tree is left byte-for-byte alone. Ruling R26 survives inside this one: the four marketing-slice-5 paths are nobody's business but that run's.

**Files:**
- Create: the worktree at `D:\Code\CRUM\.qoder\worktrees\field-audit-phase2` on new branch `feat/field-audit-phase2`.
- Copy in: the async-intake surface, which is the 33 paths `git status` reports in the primary tree less the 4 marketing-slice-5 paths, so 29, plus this plan and its spec.
- Junction: `node_modules` and `console/node_modules` to the primary tree's installs.

**Interfaces:**
- Consumes: the primary tree as found, read-only.
- Produces: a `HEAD` where every file Phase 2 touches carries the content the later tasks were drafted against, with an empty `git status --porcelain` for Task 2 to start from, and with the spec and plan tracked so the ledger's identity line resolves.

- [x] **Step 1: Create the worktree without disturbing the occupied tree**

```bash
cd /d/Code/CRUM && git status --porcelain | wc -l
git worktree add .qoder/worktrees/field-audit-phase2 -b feat/field-audit-phase2 HEAD
git status --porcelain | wc -l
```

Expected: both counts equal, so the worktree changed nothing the other run can see. `.qoder` is gitignored at `.gitignore:14`, which is why the worktree may live inside the repository. `git worktree list` shows two entries.

- [x] **Step 2: Junction the dependencies instead of a second install**

```powershell
New-Item -ItemType Junction -Path 'D:\Code\CRUM\.qoder\worktrees\field-audit-phase2\node_modules' -Target 'D:\Code\CRUM\node_modules'
New-Item -ItemType Junction -Path 'D:\Code\CRUM\.qoder\worktrees\field-audit-phase2\console\node_modules' -Target 'D:\Code\CRUM\console\node_modules'
```

Run from Bash as `powershell -NoProfile -Command "..."`; `cmd //c mklink /J` mangles the quoted path here. Then check `node_modules/.bin/vitest` resolves inside the worktree. Phase 2 adds no dependency, so a shared install stays read-only for both runs. A task that ever needs `npm install` must break the junction first.

- [x] **Step 3: Copy the async surface the plan was drafted against**

```bash
W=/d/Code/CRUM/.qoder/worktrees/field-audit-phase2
mkdir -p $W/docs/superpowers/specs $W/docs/superpowers/plans
cp docs/superpowers/specs/2026-11-03-field-audit-phase2-design.md $W/docs/superpowers/specs/
cp docs/superpowers/plans/2026-11-03-field-audit-phase2.md $W/docs/superpowers/plans/
git status --porcelain | sed 's/^...//' | sed 's#/$##' \
  | grep -vE 'analyst-cron|marketing' > /tmp/async-paths.txt
wc -l < /tmp/async-paths.txt
while read -r p; do cp --parents -r "$p" "$W/"; done < /tmp/async-paths.txt
cd $W && git status --porcelain | wc -l
```

Expected: 29 paths copied, and the same 29 in the worktree status. Two of them are the reason the whole set is copied rather than just the console pair: `src/mastra/workflows/document-intake.ts:12` imports `../ocr`, and the already-committed `tests/integration/document-audit-flow.test.ts:7-8` imports `src/queue/document-queue.js` and `src/queue/intake-run.js`. So HEAD does not typecheck on its own, and the async surface has to arrive before Task 2 can start from a green baseline. The `analyst-cron|marketing` filter is R26: that run's in-flight files are not copied and not committed. The spec and plan are untracked in the primary tree because `docs` is gitignored at `.gitignore:16`; `git add -f` makes them tracked here, where the ledger's `plan:` path has to resolve.

- [x] **Step 4: Baseline gate**

Run from the worktree: `npx tsc --noEmit && npx eslint . && npx vitest run --project unit tests/api/documents.test.ts`
Expected: exit 0 and the documents suite passing. If it does not pass, report `BLOCKED` with the failing output and do not commit.

- [x] **Step 5: Commit the isolation**

```bash
git add -f docs/superpowers/specs/2026-11-03-field-audit-phase2-design.md \
  docs/superpowers/plans/2026-11-03-field-audit-phase2.md
while read -r p; do git add -f "$p"; done < /tmp/async-paths.txt
git status --porcelain | grep -c '^[AM]'
git commit -m "$(cat <<'EOF'
chore(field-audit): isolate phase 2 and carry the async surface it builds on

The primary tree is occupied by a live marketing-slice-5 run, so this branch
holds phase 2 instead of committing in that tree. The async document processing
files arrive as copies, not as new work: HEAD does not typecheck without them,
because document-intake imports ../ocr and the committed audit-flow test
imports src/queue, and every later task here was drafted against that content.
Their authorship stays with that roadmap rather than being invented in this
message. The four marketing-slice-5 paths are neither copied nor committed.
EOF
)"
```

- [x] **Step 6: Verify**

Run: `git status --porcelain` (empty), `git log --oneline -1`, and `git status --porcelain | wc -l` in `D:\Code\CRUM`.
Expected: empty here, the new commit at HEAD, and still 33 entries in the primary tree.

---

### Task 2: Audit context provenance fixes (spec section 12, H1 H4 H5)

**Files:**
- Modify: `src/db/audit-context.ts` (whole file, 15 lines)
- Modify: `src/api/documents.ts:397-423` (`handleCorrection`)
- Modify: `tests/db/audit-context.test.ts`
- Create: `tests/db/audit-context-isolation.test.ts`

**Interfaces:**
- Consumes: `getDbClient().connect()` returning `PoolClient`.
- Produces: `setAuditContext(client: PoolClient, context: AuditContext): Promise<void>`, `AuditContext.changeSource` with the `re-parse` spelling, and `CHANGE_SOURCES` as the single five-value list. Tasks 9 and 10 import `setAuditContext`; Task 13 imports `CHANGE_SOURCES`.

- [ ] **Step 1: Rewrite the unit test so it fails first**

Replace the body of `tests/db/audit-context.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest'
import { setAuditContext } from '../../src/db/audit-context.js'

function client() {
  const query = vi.fn().mockResolvedValue({ rows: [{}] })
  return { query, calls: query.mock.calls }
}

describe('setAuditContext', () => {
  it('sets both settings transaction-locally on the caller connection', async () => {
    const c = client()
    await setAuditContext(c as never, { userId: 'u-1', changeSource: 'manual_correction' })
    expect(c.calls).toEqual([
      ['SELECT set_config($1, $2, true)', ['app.current_user_id', 'u-1']],
      ['SELECT set_config($1, $2, true)', ['app.change_source', 'manual_correction']],
    ])
  })

  it('omits the user setting when the actor is unknown but always sets the source', async () => {
    const c = client()
    await setAuditContext(c as never, { userId: null, changeSource: 'extraction' })
    expect(c.calls).toEqual([
      ['SELECT set_config($1, $2, true)', ['app.change_source', 'extraction']],
    ])
  })

  it('accepts only the spellings the shipped CHECK constraint allows', async () => {
    const c = client()
    const sources = ['extraction', 'manual_correction', 're-parse', 'import', 'system'] as const
    for (const source of sources) {
      await setAuditContext(c as never, { userId: null, changeSource: source })
    }
    expect(c.calls.map((call) => (call[1] as string[])[1])).toEqual(sources)
  })
})
```

Run: `npx vitest run tests/db/audit-context.test.ts`
Expected: FAIL. The current signature takes one argument, passes `false` as the is-local flag, and its union says `re_parse`.

- [ ] **Step 2: Write the integration test that proves the leak**

Create `tests/db/audit-context-isolation.test.ts`. Copy the `.env` header, the `TENANT` and `USER` constants and the `seedInvoice` insert from `tests/db/field-audit.test.ts:1-80`, then add:

```ts
it('does not attribute a later write on the same connection to an earlier actor', async () => {
  const client = await getDbClient().connect()
  try {
    const docA = await seedInvoice(client, 'isolation-a')
    const docB = await seedInvoice(client, 'isolation-b')

    await client.query('BEGIN')
    await setAuditContext(client, { userId: USER, changeSource: 'manual_correction' })
    await client.query('UPDATE invoices SET total = $1 WHERE document_id = $2', ['11.00', docA])
    await client.query('COMMIT')

    // No setAuditContext on this transaction. With a session-scoped setting the
    // trigger still sees USER and blames the second document on the first actor.
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
  } finally {
    await client.query('RESET app.current_user_id').catch(() => undefined)
    await client.query('RESET app.change_source').catch(() => undefined)
    client.release()
  }
})
```

Run: `npx vitest run tests/db/audit-context-isolation.test.ts`
Expected: FAIL, `changed_by` equal to `USER`. That failure is the evidence the fix is real, so record it in the report.

- [ ] **Step 3: Implement**

`src/db/audit-context.ts` in full:

```ts
import type { PoolClient } from 'pg'

export const CHANGE_SOURCES = ['extraction', 'manual_correction', 're-parse', 'import', 'system'] as const

export interface AuditContext {
  userId: string | null
  changeSource: (typeof CHANGE_SOURCES)[number]
}

/**
 * The third argument to set_config is the transaction-local flag. A session-scoped
 * setting survives client.release() and is still set when the pool hands that
 * physical connection to a later request, which attributes that request's writes to
 * this actor. The caller must already be inside a transaction.
 */
export async function setAuditContext(client: PoolClient, context: AuditContext): Promise<void> {
  if (context.userId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', context.userId])
  }
  await client.query('SELECT set_config($1, $2, true)', ['app.change_source', context.changeSource])
}
```

The `changeSource` spelling now matches the shipped `CHECK` at `migrations/0023_crum_field_audit.sql:18`, which reads `re-parse`. The migration is the authority, so the literal moves, not the constraint. `CHANGE_SOURCES` is exported as a tuple so `Task 13` validates the export filter against the same list the type is derived from, rather than a second hand-written array.

- [ ] **Step 4: Route the correction handler through it**

In `src/api/documents.ts`, replace the two inline `set_config` queries at lines 400-401 with one call, keeping the `BEGIN` before it:

```ts
await client.query('BEGIN')
await setAuditContext(client, { userId: identity.userId, changeSource: 'manual_correction' })
```

Add `import { setAuditContext } from '../db/audit-context'` beside the other `../db` imports.

- [ ] **Step 5: Run the three affected suites**

Run: `npx vitest run tests/db/audit-context.test.ts tests/db/audit-context-isolation.test.ts tests/api/document-correction.test.ts`
Expected: all PASS. The correction suite proves `changed_by` is still stamped inside a transaction.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/db/audit-context.ts src/api/documents.ts tests/db/audit-context.test.ts tests/db/audit-context-isolation.test.ts
git commit -m "fix(audit): provenance settings stop surviving the connection they were set on"
```

---

### Task 3: Rules engine core

**Files:**
- Create: `src/validation/types.ts`
- Create: `src/validation/values.ts`
- Create: `src/validation/rules.ts` (empty catalogue at this task)
- Create: `src/validation/index.ts`
- Create: `tests/validation/values.test.ts`
- Create: `tests/validation/evaluate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the five types in spec section 5.1 verbatim, plus `RULESET_VERSION`, `evaluate`, `buildBundle`, `localDay`, the five primitives, and `AMOUNT_TOLERANCE`, `MAX_PLAUSIBLE_AMOUNT`, `RULES`.

`rules.ts` is created here as `export const RULES: ValidationRule[] = []` so `evaluate` is testable before any rule exists. Tasks 4 and 5 fill it.

- [ ] **Step 1: Write the failing primitive tests**

Create `tests/validation/values.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isAbsent, parseAmount, parseDate, isEmail, isCurrencyShape } from '../../src/validation/values.js'

describe('isAbsent', () => {
  it('treats null, undefined and blank as absent but zero as present', () => {
    expect(isAbsent(null)).toBe(true)
    expect(isAbsent(undefined)).toBe(true)
    expect(isAbsent('')).toBe(true)
    expect(isAbsent('   ')).toBe(true)
    expect(isAbsent('0')).toBe(false)
    expect(isAbsent(0)).toBe(false)
    expect(isAbsent(false)).toBe(false)
  })
})

describe('parseAmount', () => {
  it('parses the strings pg returns for numeric', () => {
    expect(parseAmount('1234.56')).toBe(1234.56)
    expect(parseAmount(7)).toBe(7)
  })
  it('strips a currency symbol and thousands separators', () => {
    expect(parseAmount('$1,240.00')).toBe(1240)
  })
  it('reads accounting parentheses as a negative', () => {
    expect(parseAmount('(350.00)')).toBe(-350)
  })
  it('returns null rather than zero for anything that is not a number', () => {
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(Number.NaN)).toBeNull()
    expect(parseAmount('-')).toBeNull()
  })
})

describe('parseDate', () => {
  it('normalises an ISO date and a timestamp down to the date', () => {
    expect(parseDate('2026-03-01')).toBe('2026-03-01')
    expect(parseDate('2026-03-01T00:00:00.000Z')).toBe('2026-03-01')
  })
  it('accepts a space separator and an offset, and keeps the day as written', () => {
    // Postgres renders its own timestamp text space-separated, and extraction hands over both forms,
    // so a strict `T` would read a well-formed value as absent and the rule judging it would say
    // nothing. The last two lines are the no-conversion half of the frame rule: the offset is matched
    // so it cannot invalidate the value and is then dropped, so the day returned is the day the string
    // writes. 23:00 at -05:00 is already the next day in UTC, and that is not what this returns.
    expect(parseDate('2026-03-01 09:00:00')).toBe('2026-03-01')
    expect(parseDate('2026-03-01T09:00:00+11:00')).toBe('2026-03-01')
    expect(parseDate('2026-03-01T23:00:00-05:00')).toBe('2026-03-01')
    expect(parseDate('2026-03-01T09:00:00Z')).toBe('2026-03-01')
  })
  it('still rejects a malformed value after the time part', () => {
    expect(parseDate('2026-03-01 09:00:00xyz')).toBeNull()
    expect(parseDate('2026-03-01T09')).toBeNull()
  })
  it('rejects trailing junk instead of reading the date out of its prefix', () => {
    expect(parseDate('2026-03-011')).toBeNull()
    expect(parseDate('2026-03-01xyz')).toBeNull()
  })
  it('rejects an ambiguous locale string', () => {
    expect(parseDate('01/03/2026')).toBeNull()
  })
  it('rejects a calendar-impossible date instead of rolling it over', () => {
    expect(parseDate('2026-02-30')).toBeNull()
    expect(parseDate('2026-13-01')).toBeNull()
  })
})

describe('isEmail', () => {
  it('accepts an ordinary address and rejects the rest', () => {
    expect(isEmail('billing@acme.com')).toBe(true)
    expect(isEmail('not-an-email')).toBe(false)
    expect(isEmail('a@b')).toBe(false)
    expect(isEmail('')).toBe(false)
  })
})

describe('isCurrencyShape', () => {
  it('accepts three ASCII letters in either case', () => {
    expect(isCurrencyShape('AUD')).toBe(true)
    expect(isCurrencyShape('aud')).toBe(true)
  })
  it('rejects a short code, a long code and a symbol', () => {
    expect(isCurrencyShape('AU')).toBe(false)
    expect(isCurrencyShape('AUSD')).toBe(false)
    expect(isCurrencyShape('$')).toBe(false)
    expect(isCurrencyShape(null)).toBe(false)
  })
})
```

Run: `npx vitest run tests/validation/values.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 2: Implement `src/validation/types.ts`**

Copy spec section 5.1 word for word. Five exported types, zero imports, zero runtime statements.

- [ ] **Step 3: Implement `src/validation/values.ts`**

```ts
export const AMOUNT_TOLERANCE = 0.01
export const MAX_PLAUSIBLE_AMOUNT = 100_000_000

export function isAbsent(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

export function parseAmount(v: unknown): number | null {
  if (isAbsent(v)) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  let s = v.trim()
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  s = s.replace(/[^0-9.,eE+-]/g, '').replace(/,/g, '')
  const n = Number(s)
  return s !== '' && Number.isFinite(n) ? sign * n : null
}

const EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[A-Za-z]{2,}$/

export function isEmail(v: unknown): boolean {
  return typeof v === 'string' && EMAIL.test(v.trim())
}

export function isCurrencyShape(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim())
}

// A date, optionally followed by a time. The separator is `[ T]` because Postgres' own text rendering
// is space-separated and ISO strings from extraction use `T`; the offset group accepts `Z`, `+11` and
// `+11:00`. The time and offset are matched only so they do not invalidate the value, then dropped:
// parseDate returns the day the string *writes*, and no zone conversion happens anywhere in this layer.
const DATE_OR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

export function parseDate(v: unknown): string | null {
  if (isAbsent(v)) return null
  const m = String(v).trim().match(DATE_OR_TIMESTAMP)
  if (!m) return null
  const [, y, mo, d] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  if (!Number.isFinite(ms)) return null
  const back = new Date(ms).toISOString().slice(0, 10)
  return back === `${y}-${mo}-${d}` ? back : null
}
```

`parseDate` rebuilds the instant from the three numeric components and re-reads them out of the ISO string. That is how `2026-02-30` is rejected rather than rolled to March. It never consults the clock. The pattern is anchored at both ends and spells out the optional time part, because a start-anchored `^\d{4}-\d{2}-\d{2}` would read `2026-03-01xyz` and `2026-03-011` as a valid `2026-03-01`; a truncated day is exactly the shape an OCR slip produces, and a rule that then compares that date against `ctx.today` would be judging a value the reader invented.

The time branch exists for strings that come out of extraction and out of `parsedJson`, not for `pg`. An earlier draft of this paragraph claimed `pg` renders a timestamp as `2026-03-01T00:00:00`, and that is wrong twice over: `pg-types` binds OID 1114 and 1184 to `postgres-date` as well as 1082, so a timestamp reaches `buildBundle` as a `Date` and never as a string, and when Postgres does emit text it is space-separated (`DateStyle=ISO`). The separator is therefore `[ T]` and an optional offset group follows, because rejecting `2026-03-01 09:00:00` as absent would silence a rule judging a perfectly well-formed extracted value. Whatever the time part says, the day returned is the day the string writes: `2026-03-01T23:00:00-05:00` gives `2026-03-01` even though that instant is already the next day in UTC, because the frame rule in constraint 6 forbids a conversion here and the values test pins it.

- [ ] **Step 4: Implement `src/validation/rules.ts` as an empty catalogue**

```ts
import type { ValidationRule } from './types.js'

export const RULES: ValidationRule[] = []
```

- [ ] **Step 5: Implement `src/validation/index.ts`**

```ts
import { RULES } from './rules.js'
import type { DocumentRecordBundle, ValidationContext, ValidationRule, Violation } from './types.js'

export const RULESET_VERSION = 'v1'
export { RULES }
export type * from './types.js'

const SEVERITY_RANK: Record<Violation['severity'], number> = { error: 0, warning: 1 }

/**
 * The one calendar-day renderer in this layer. `ValidationContext.today` and every `date` column in a
 * bundle go through here, so a date rule always compares two days read the same way; that unity is why
 * there is no second helper for "today".
 *
 * pg parses a `date` column into a JS Date at *local* midnight (`postgres-date` builds
 * `new Date(y, m, d)`), so the stored calendar day has to be read back with the local getters.
 * `toISOString().slice(0, 10)` would move 2026-11-03 to 2026-11-02 on any machine east of UTC, which is
 * where this project runs and where the findings get stored.
 *
 * Two properties to keep in mind. This is a wall-clock-free read: it consults the value's own fields and
 * the process timezone, never `Date.now()`, and the caller supplies the instant so that constraint 6's
 * clock stays outside `src/validation/`. And a Postgres `date` carries no zone of its own, so a worker
 * running in a different timezone would disagree about which day a stored value names.
 */
export function localDay(value: Date): string {
  const y = String(value.getFullYear())
  const mo = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

export function buildBundle(
  kind: 'invoice' | 'contract',
  header: Record<string, unknown> | null,
  lines: Array<Record<string, unknown>>,
  terms: Array<Record<string, unknown>>,
): DocumentRecordBundle {
  const coerce = (value: unknown): string | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    // Every Date becomes its local calendar day, so a `timestamptz` column that reaches this
    // boundary through a `SELECT *` loses its time of day. No Phase 2 rule reads one today; a later
    // task that wants an instant must read it from the row, not from a bundle.
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDay(value)
    return null
  }
  const toRow = (row: Record<string, unknown>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, coerce(value)]))
  const head = header == null ? null : toRow(header)
  return kind === 'invoice'
    ? { kind, invoice: head ?? undefined, lines: lines.map(toRow), terms: [] }
    : { kind, contract: head ?? undefined, terms: terms.map(toRow), lines: [] }
}

export function evaluate(
  bundle: DocumentRecordBundle,
  ctx: ValidationContext,
  rules: readonly ValidationRule[] = RULES,
): Violation[] {
  const header = bundle.kind === 'invoice' ? bundle.invoice : bundle.contract
  if (header === undefined && bundle.lines.length === 0 && bundle.terms.length === 0) return []
  const seen = new Set<string>()
  const found: Violation[] = []
  for (const rule of rules) {
    if (rule.appliesTo !== bundle.kind) continue
    for (const v of rule.run(bundle, ctx)) {
      const key = v.ruleId + '|' + v.field
      if (seen.has(key)) continue
      seen.add(key)
      found.push(v)
    }
  }
  return found.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
    if (a.field !== b.field) return a.field < b.field ? -1 : 1
    return 0
  })
}
```

Close the code block. `localDay` takes the `Date` as a required argument and is the only place in `src/validation/` that may accept one. Constraint 6 declares this module clock-free, and a default argument would let production code read the wall clock from inside it while every test stayed silent about that read, so the caller supplies the instant. Step 6 pins the requirement with `@ts-expect-error`: if a later task reintroduces a default, `npx tsc --noEmit` fails on an unused directive rather than shipping a clock read.

It is also the only renderer of a calendar day, and that is the ruling rather than an accident (R45). `ValidationContext.today` and a `date` column that arrives as a `Date` are compared against each other by `invoice.invoice_date.future`, so the two halves have to be produced the same way. The bundle half is fixed by `pg`: `postgres-date` builds `new Date(y, m, d)`, so a stored `2026-11-03` is local midnight and only the local getters recover it. A UTC `today` beside it made the rule fire on an invoice dated the auditor's own business day for every hour before 11:00 here (UTC+11, `getTimezoneOffset()` = `-660`). One exported helper means a future task cannot put the two halves in different frames even by mistake, and Tasks 8, 10 and 12 call `localDay(new Date())` at their own boundaries instead of being handed a zero-argument helper that reads the clock for them.

The first two lines of `evaluate` are spec 5.2's "drops rules whose subject row is absent" clause read at the one level where it is decidable without knowing any rule: a bundle with no header and no rows at all is not a record with missing fields, it is no record. Per-field absence stays each rule's business, because only a rule knows which of its fields it is judging, and Task 8's `normalized` precondition is what keeps a header-less bundle from reaching here in the first place. All three terms of that condition are pinned from both directions, because a mutation check showed the all-empty case alone leaves the over-broad reading alive: a guard written as just `header === undefined` keeps every other test green while silencing exactly the `*.present` rules this ruling exists to protect, and dropping either row-count term does the same for one kind. Step 6's `runs rules for a bundle that has rows even when its header is absent` case carries the three assertions that die, one per term, and the `bundle.kind` selection on the line above the guard, which is otherwise dead under test because every other call in the file passes an invoice. The comparator uses codepoint rather than `String.prototype.localeCompare` so the stored order of findings does not shift with the machine's locale; the two disagree on `'a'` versus `'B'`, which is why Step 6 has a case for it.

`coerce` narrows with `typeof` before it calls `String`, rather than applying `String(value)` to a value it has already checked for null. Two reasons, both measured. First, `@typescript-eslint/no-base-to-string` is enabled in this repo's config, and after `if (value === null || value === undefined) return null` the residual type is `{}`, which the rule errors on: a scratch file with `String(v)` on an unchecked `unknown` lints clean, while the same call after that null check fails at the `String` line. Narrowing first leaves no residual to complain about, so neither a lint suppression in production code nor a cast that lies about the value's type is needed. Second, a plain object reaching this boundary would stringify to `[object Object]`, which every rule then reads as a present value, and a finding on it is worse than no finding; returning `null` makes an unexpected object read as absent, which constraint 5 already defines as the safe state. One object type is not a guard, and this paragraph said otherwise until it was measured: `getInvoice` and `getContract` do `SELECT *` (`src/db/documents.ts:492,508`) and their row types declare `invoice_date: string | null`, but nothing in `src/` or `scripts/` calls `setTypeParser`, so `pg`'s default applies and a `date` column arrives as a `Date`. Measured against the project's live pooler, `SELECT '2026-11-03'::date` returns a `Date` whose `String()` is `Tue Nov 03 2026 00:00:00 GMT+1100` and whose `toISOString()` is `2026-11-02T13:00:00.000Z`; the same query returns `numeric` as a string and `boolean` as a boolean. Task 9's brief says those rows feed `buildBundle`, so without the `instanceof Date` branch every date rule would read `invoice_date` as absent, and with a `toISOString()` version it would judge the day before the one stored.

- [ ] **Step 6: Write the failing evaluate tests**

Create `tests/validation/evaluate.test.ts`. It builds rules inline rather than importing the catalogue, so the engine contract stays independent of which rules exist.

The `rule()` helper takes `out: Violation[]` and returns `run: () => out` with no cast, measured clean under both `tsc --noEmit` and eslint in this worktree. The earlier shape, `out: never[] | Array<Record<string, unknown>>` with `run: () => out as never`, threw away `Violation` shape checking on every fixture: a typo like `severity: 'warn'` compiled, made `SEVERITY_RANK[a.severity]` read `undefined`, returned `NaN` from the comparator, and silently degraded the total order this file exists to prove. Typing the parameter lets the compiler check each fixture, and 19 rules' worth of fixtures inherit that. One consequence, measured: a fixture the test extracts into `const dup = { ... }` before passing it loses its contextual type, `severity` widens to `string`, and `tsc` fails with TS2322. That is the typing working, so annotate the extraction (`const dup: Violation = { ... }`) rather than casting it. Fixtures written inline in an argument position keep the contextual type and need nothing.

```ts
import { describe, it, expect } from 'vitest'
import { buildBundle, evaluate, localDay, RULESET_VERSION } from '../../src/validation/index.js'
import { parseDate } from '../../src/validation/values.js'
import type { ValidationContext, ValidationRule, Violation } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }
const invoice = buildBundle('invoice', { total: '10' }, [], [])

function rule(partial: Partial<ValidationRule> & { id: string }, out: Violation[] = []): ValidationRule {
  return {
    appliesTo: 'invoice',
    fields: ['total'],
    run: () => out,
    ...partial,
  }
}

describe('localDay', () => {
  it('renders the day an instant falls on locally, including the early-morning hours', () => {
    // 00:30 is the hour that matters: this project runs at UTC+11, so a UTC read of a local
    // early-morning instant returns the day before. Inputs are built from local components, so a
    // correct implementation passes in any zone. The limit is the mirror of that: on a machine whose
    // offset is exactly zero both reads agree and this case cannot kill a UTC implementation. It
    // kills one here, measured at getTimezoneOffset() = -660, and the mutation was run.
    expect(localDay(new Date(2026, 10, 3, 0, 30, 0))).toBe('2026-11-03')
    expect(localDay(new Date(2026, 10, 3, 23, 59, 59))).toBe('2026-11-03')
    expect(localDay(new Date(2026, 10, 4))).toBe('2026-11-04')
  })

  it('requires the caller to supply the instant so the module never reads the clock', () => {
    // A default argument would make this a wall-clock read inside src/validation/, which
    // constraint 6 forbids. `npx tsc --noEmit` covers tests/, and reports TS2578 "Unused
    // '@ts-expect-error' directive" on the line below if anyone reintroduces one.
    // @ts-expect-error - value is required
    const callableWithoutAnInstant: () => string = localDay
    expect(callableWithoutAnInstant).toBeTypeOf('function')
  })

  it('is the single renderer, so a stored date and ctx.today cannot end up in different frames', () => {
    // The only catalogue rule that consumes ctx.today is invoice.invoice_date.future, whose body is
    // `parseDate(invoice_date) > ctx.today`. Before R45 the two halves came from two helpers in two
    // frames, and that fired a warning on an invoice dated the auditor's own business day for 11 of
    // 24 hours. There is now one renderer for both sides, so the first two lines below are the same
    // computation the boundary performs, and killing `localDay` kills both sides at once.
    const stamped = new Date(2026, 10, 3)
    const bundle = buildBundle('invoice', { invoice_date: stamped }, [], [])
    const future: ValidationRule = {
      id: 'invoice.invoice_date.future',
      appliesTo: 'invoice',
      fields: ['invoice_date'],
      run: (b, ctx) => {
        const d = parseDate(b.invoice?.invoice_date)
        return d !== null && d > ctx.today
          ? [{ ruleId: 'invoice.invoice_date.future', field: 'invoice_date', severity: 'warning', message: 'Invoice date is after today.' }]
          : []
      },
    }
    expect(bundle.invoice?.invoice_date).toBe('2026-11-03')
    expect(evaluate(bundle, { today: localDay(stamped) }, [future])).toEqual([])
    expect(evaluate(bundle, { today: '2026-11-02' }, [future])).toHaveLength(1)
  })
})

describe('evaluate', () => {
  it('skips rules that do not apply to the bundle kind', () => {
    const r = rule({ id: 'contract.x', appliesTo: 'contract' }, [{ ruleId: 'contract.x', field: 'y', severity: 'error', message: 'nope' }])
    expect(evaluate(invoice, CTX, [r])).toEqual([])
  })

  it('puts errors before warnings regardless of catalogue order', () => {
    const warn = rule({ id: 'a.warn' }, [{ ruleId: 'a.warn', field: 'total', severity: 'warning', message: 'w' }])
    const err = rule({ id: 'z.error' }, [{ ruleId: 'z.error', field: 'total', severity: 'error', message: 'e' }])
    expect(evaluate(invoice, CTX, [warn, err]).map((v) => v.severity)).toEqual(['error', 'warning'])
  })

  it('sorts by ruleId then field inside a severity tier so the output is total', () => {
    const r = rule({ id: 'same' }, [
      { ruleId: 'same', field: 'b', severity: 'error', message: '2' },
      { ruleId: 'same', field: 'a', severity: 'error', message: '1' },
      { ruleId: 'other', field: 'z', severity: 'error', message: '0' },
    ])
    expect(evaluate(invoice, CTX, [r]).map((v) => v.ruleId + ':' + v.field))
      .toEqual(['other:z', 'same:a', 'same:b'])
  })

  it('drops an exact ruleId and field duplicate a second rule produces', () => {
    // Annotated on purpose: an unannotated extraction of this literal loses its contextual
    // type, widens `severity` to `string`, and fails TS2322 against `out: Violation[]`. The
    // annotation keeps the compiler checking the fixture instead of casting the widening away.
    const dup: Violation = { ruleId: 'd', field: 'total', severity: 'error', message: 'm' }
    expect(evaluate(invoice, CTX, [rule({ id: 'd' }, [dup]), rule({ id: 'd2' }, [dup])]).length).toBe(1)
  })

  it('is deterministic across calls', () => {
    const rules = [rule({ id: 'x' }, [{ ruleId: 'x', field: 't', severity: 'warning', message: 'm' }])]
    expect(evaluate(invoice, CTX, rules)).toEqual(evaluate(invoice, CTX, rules))
  })

  it('pins the ruleset version so a stored finding says which rules judged it', () => {
    expect(RULESET_VERSION).toBe('v1')
  })

  it('buildBundle keeps lines only for an invoice and terms only for a contract', () => {
    const lines = [{ amount: '1' }]
    const terms = [{ title: 't' }]
    expect(buildBundle('invoice', {}, lines, terms)).toMatchObject({ kind: 'invoice', lines, terms: [] })
    expect(buildBundle('contract', {}, lines, terms)).toMatchObject({ kind: 'contract', terms, lines: [] })
    expect(buildBundle('invoice', null, [], []).invoice).toBeUndefined()
  })

  it('coerces row values at the bundle boundary so pg numbers and booleans arrive as strings', () => {
    const b = buildBundle('invoice', { total: 12, auto_renewal: true, blank: null }, [{ qty: 3 }], [])
    expect(b.invoice).toEqual({ total: '12', auto_renewal: 'true', blank: null })
    expect(b.lines).toEqual([{ qty: '3' }])
  })

  it('reads an object-valued column as absent rather than as [object Object]', () => {
    expect(buildBundle('invoice', { meta: { a: 1 } }, [], []).invoice).toEqual({ meta: null })
  })

  it('treats an undefined header like a null one instead of throwing', () => {
    // The declared parameter type forbids `undefined`, so the only way here is the cast Task 8's
    // call site already uses (`normalized` arrives through `as unknown as`, document-intake.ts).
    // Without this case the `== null` guard survives as decoration: a mutation to `=== null`
    // throws a TypeError only on a path no test can name.
    const header = undefined as unknown as Record<string, unknown>
    expect(buildBundle('invoice', header, [], []).invoice).toBeUndefined()
  })

  it('renders a pg date Date as the stored calendar day, not the UTC-shifted one', () => {
    // pg builds a `date` column as a Date at local midnight. A toISOString() read here would
    // turn 2026-11-03 into 2026-11-02 on any machine east of UTC, which is where this project
    // writes and reads. The input is built in local time, so the case *passes* in any zone; it
    // only *kills* a UTC implementation where the offset is not zero, which is true of this box
    // and is measured in the localDay case above rather than hidden here.
    expect(buildBundle('invoice', { invoice_date: new Date(2026, 10, 3) }, [], []).invoice)
      .toEqual({ invoice_date: '2026-11-03' })
    expect(buildBundle('invoice', { invoice_date: new Date('not a date') }, [], []).invoice)
      .toEqual({ invoice_date: null })
  })

  it('reads a NaN or infinite amount as absent rather than as a number', () => {
    const b = buildBundle('invoice', { total: Number.NaN, tax: Number.POSITIVE_INFINITY }, [], [])
    expect(b.invoice).toEqual({ total: null, tax: null })
  })

  it('runs rules against an empty header but drops them all when there is no header and no rows', () => {
    const wouldFire = rule({ id: 'invoice.needs_vendor', fields: ['vendor_name'] }, [
      { ruleId: 'invoice.needs_vendor', field: 'vendor_name', severity: 'error', message: 'absent' },
    ])
    // {} is a record whose fields are all missing, which is exactly what a rule judges.
    // null is no record at all, and there is nothing here for any of the 19 rules to say.
    expect(evaluate(buildBundle('invoice', {}, [], []), CTX, [wouldFire]).length).toBe(1)
    expect(evaluate(buildBundle('invoice', null, [], []), CTX, [wouldFire])).toEqual([])
  })

  it('runs rules for a bundle that has rows even when its header is absent, in both kinds', () => {
    const firesOnInvoice = rule({ id: 'invoice.needs_vendor', fields: ['vendor_name'] }, [
      { ruleId: 'invoice.needs_vendor', field: 'vendor_name', severity: 'error', message: 'absent' },
    ])
    const firesOnContract = rule({ id: 'contract.needs_party', appliesTo: 'contract', fields: ['party'] }, [
      { ruleId: 'contract.needs_party', field: 'party', severity: 'error', message: 'absent' },
    ])
    // A mutation check found the all-empty case above pins the guard in one direction only: a guard
    // reading `header === undefined` on its own keeps every earlier test green while silencing the
    // `*.present` rules for a record that does have rows. These three assertions each kill one term
    // of the real condition, and the third is what exercises the `bundle.kind` selection, which is
    // otherwise dead under test — hard-wiring it to `bundle.invoice` survives the first two.
    expect(evaluate(buildBundle('invoice', null, [{ amount: '1' }], []), CTX, [firesOnInvoice])).toHaveLength(1)
    expect(evaluate(buildBundle('contract', null, [], [{ description: 'x' }]), CTX, [firesOnContract])).toHaveLength(1)
    expect(evaluate(buildBundle('contract', { total: '10' }, [], []), CTX, [firesOnContract])).toHaveLength(1)
  })

  it('orders by codepoint, not locale collation, so the order survives a locale change', () => {
    const r = rule({ id: 'same' }, [
      { ruleId: 'same', field: 'a', severity: 'error', message: '1' },
      { ruleId: 'same', field: 'B', severity: 'error', message: '2' },
    ])
    // localeCompare in en-US puts 'a' before 'B'; a codepoint compare puts 'B' (66) first.
    expect(evaluate(invoice, CTX, [r]).map((v) => v.field)).toEqual(['B', 'a'])
  })

  it('orders ruleIds by codepoint too, so the arm that picks between rules is covered', () => {
    const lower = rule({ id: 'a.r' }, [{ ruleId: 'a.r', field: 'total', severity: 'error', message: '1' }])
    const upper = rule({ id: 'B.r' }, [{ ruleId: 'B.r', field: 'total', severity: 'error', message: '2' }])
    // This case exists because a mutation check caught the gap: reverting the ruleId arm to
    // localeCompare left every earlier test green, because the field arm is a separate line
    // of the comparator and only the field arm had a discriminating case. Measured:
    // 'a.r'.localeCompare('B.r') is -1, codepoint puts 'B.r' first.
    expect(evaluate(invoice, CTX, [lower, upper]).map((v) => v.ruleId)).toEqual(['B.r', 'a.r'])
  })
})
```

Run: `npx vitest run tests/validation/evaluate.test.ts`
Expected: FAIL until Step 5 is complete, then PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
npx vitest run tests/validation/values.test.ts tests/validation/evaluate.test.ts
git add src/validation tests/validation/values.test.ts tests/validation/evaluate.test.ts
git commit -m "feat(validation): a pure rules engine with a total order over its findings"
```

---
---

### Task 4: Invoice rule catalogue (spec section 6, rows 1 to 13)

**Files:**
- Modify: `src/validation/rules.ts`
- Create: `tests/validation/rules-invoice.test.ts`

**Interfaces:**
- Consumes: `src/validation/values.js` primitives, `DocumentRecordBundle`, `ValidationContext`.
- Produces: 13 entries in `RULES` with the exact ids in spec section 6. Task 5 appends 6 more to the same array. Task 7 asserts `RULES.length` is 19.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/rules-invoice.test.ts`. Every rule gets a case that fires and a case that stays silent. `CTX.today` is always pinned, so no test reads the clock.

```ts
import { describe, expect, it } from 'vitest'
import { buildBundle, evaluate, RULES } from '../../src/validation/index.js'
import type { ValidationContext } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }

const GOOD = {
  vendor_name: 'Acme Supplies',
  vendor_email: 'billing@acme.example',
  invoice_number: 'INV-2041',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  currency: 'AUD',
  subtotal: '1000.00',
  tax: '100.00',
  total: '1100.00',
}

function check(overrides: Record<string, unknown>, lines: Array<Record<string, unknown>> = [{ description: 'x', quantity: '2', unit_price: '550', amount: '1100' }]) {
  return evaluate(buildBundle('invoice', { ...GOOD, ...overrides }, lines, []), CTX)
}

function ids(violations: ReturnType<typeof check>): string[] {
  return violations.map((x) => x.ruleId)
}

it('fires nothing at all on a compliant invoice', () => {
  expect(check({})).toEqual([])
})

describe('presence rules', () => {
  it.each([
    ['invoice_number', 'invoice.invoice_number.present'],
    ['vendor_name', 'invoice.vendor_name.present'],
    ['total', 'invoice.total.present'],
    ['invoice_date', 'invoice.invoice_date.present'],
  ])('names %s absent as an error on itself', (field, ruleId) => {
    expect(ids(check({ [field]: null }))).toContain(ruleId)
  })
  it('treats a blank string as absent', () => {
    expect(ids(check({ invoice_number: '   ' }))).toContain('invoice.invoice_number.present')
  })
  it('keeps a zero total rather than calling it absent', () => {
    expect(ids(check({ total: '0' }))).not.toContain('invoice.total.present')
  })
})

describe('currency', () => {
  it('warns on a code that is not three letters', () => {
    expect(ids(check({ currency: 'AU' }))).toContain('invoice.currency.shape')
  })
  it('stays silent on a lowercase three-letter code', () => {
    expect(ids(check({ currency: 'aud' }))).not.toContain('invoice.currency.shape')
  })
})

describe('amounts', () => {
  it('errors on a negative total', () => {
    const hits = check({ total: '-5' })
    expect(ids(hits)).toContain('invoice.total.nonnegative')
    expect(hits.find((h) => h.ruleId === 'invoice.total.nonnegative')?.severity).toBe('error')
  })
  it('warns on a total that has run away past a plausible ceiling', () => {
    expect(ids(check({ total: '100000000' }))).toContain('invoice.total.range')
    expect(ids(check({ total: '99999999' }))).not.toContain('invoice.total.range')
  })
  it('errors where subtotal plus tax is not the total', () => {
    const hits = check({ total: '1200.00' })
    const sum = hits.find((h) => h.ruleId === 'invoice.total.sum')
    expect(sum?.field).toBe('total')
    expect(sum?.severity).toBe('error')
    expect(sum?.details).toMatchObject({ subtotal: 1000, tax: 100, total: 1200 })
  })
  it('forgives one cent of rounding', () => {
    expect(ids(check({ total: '1100.01' }))).not.toContain('invoice.total.sum')
  })
  it('stays silent when a component is missing, because absence is not arithmetic', () => {
    expect(ids(check({ subtotal: null }))).not.toContain('invoice.total.sum')
  })
  it('stays silent when a component is unparseable', () => {
    expect(ids(check({ tax: 'GST' }))).not.toContain('invoice.total.sum')
  })
})

describe('dates', () => {
  it('warns on an invoice dated after today', () => {
    expect(ids(check({ invoice_date: '2026-11-04' }))).toContain('invoice.invoice_date.future')
    expect(ids(check({ invoice_date: '2026-11-03' }))).not.toContain('invoice.invoice_date.future')
  })
  it('errors on a due date before the invoice date', () => {
    expect(ids(check({ due_date: '2026-09-01' }))).toContain('invoice.due_date.order')
  })
  it('does not invent an order check when the due date is absent', () => {
    expect(ids(check({ due_date: null }))).not.toContain('invoice.due_date.order')
  })
  it('ignores an unparseable date instead of reporting it twice', () => {
    expect(ids(check({ invoice_date: '31 Oct 2026' }))).not.toContain('invoice.invoice_date.future')
  })
})

it('warns on a malformed vendor email but stays silent when absent', () => {
  expect(ids(check({ vendor_email: 'not-an-email' }))).toContain('invoice.vendor_email.format')
  expect(ids(check({ vendor_email: null }))).not.toContain('invoice.vendor_email.format')
})

describe('lines', () => {
  it('warns on a line whose quantity times unit price is not its amount', () => {
    const hits = check({}, [{ description: 'x', quantity: '2', unit_price: '500', amount: '1100' }])
    const line = hits.find((h) => h.ruleId === 'invoice.lines.amount')
    expect(line?.field).toBe('lines.amount')
    expect(line?.details?.line).toBe(0)
  })
  it('forgives one cent of rounding on a line', () => {
    expect(ids(check({}, [{ quantity: '3', unit_price: '3.33', amount: '9.99' }))))
      .not.toContain('invoice.lines.amount')
  })
  it('reports the first bad line and how many are bad, because one rule and one field store one row', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ quantity: '2', unit_price: '1', amount: String(50 + i) }))
    const hits = check({}, many).filter((h) => h.ruleId === 'invoice.lines.amount')
    expect(hits.length).toBe(1)
    expect(hits[0].details).toMatchObject({ line: 0, badLineCount: 9 })
  })
  it('warns when a total exists and no line was extracted', () => {
    expect(ids(check({}, []))).toContain('invoice.lines.present')
    expect(ids(check({ total: null }, []))).not.toContain('invoice.lines.present')
  })
})

it('pins the thirteen invoice rule ids', () => {
  expect(RULES.filter((r) => r.appliesTo === 'invoice').map((r) => r.id).sort()).toEqual([
    'invoice.currency.shape',
    'invoice.due_date.order',
    'invoice.invoice_date.future',
    'invoice.invoice_date.present',
    'invoice.invoice_number.present',
    'invoice.lines.amount',
    'invoice.lines.present',
    'invoice.total.nonnegative',
    'invoice.total.present',
    'invoice.total.range',
    'invoice.total.sum',
    'invoice.vendor_email.format',
    'invoice.vendor_name.present',
  ])
})
```

Run: `npx vitest run tests/validation/rules-invoice.test.ts`
Expected: FAIL on every case, because `RULES` is empty.

- [ ] **Step 2: Implement**

Replace `src/validation/rules.ts` with the invoice half. Keep the shape so Task 5 appends cleanly.

```ts
import {
  AMOUNT_TOLERANCE,
  MAX_PLAUSIBLE_AMOUNT,
  isAbsent,
  isCurrencyShape,
  isEmail,
  parseAmount,
  parseDate,
} from './values.js'
import type { DocumentRecordBundle, ValidationRule, Violation } from './types.js'

type Row = Record<string, unknown>

function make(
  ruleId: string,
  field: string,
  severity: Violation['severity'],
  message: string,
  details?: Record<string, string | number>,
): Violation {
  return details ? { ruleId, field, severity, message, details } : { ruleId, field, severity, message }
}

function header(bundle: DocumentRecordBundle): Row {
  return (bundle.invoice ?? bundle.contract ?? {}) as Row
}

function present(row: Row, field: string): boolean {
  return !isAbsent(row[field])
}

/**
 * One rule and one field store one row, so the line rule reports the first bad line
 * and counts the rest. A reviewer sees that the table is wrong and that it is not
 * just one line, which is the whole job of the finding.
 */
function lineAmountFailure(lines: Row[]): { index: number; badCount: number } | null {
  let first = -1
  let badCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as Row
    const qty = parseAmount(line.quantity)
    const price = parseAmount(line.unit_price)
    const amount = parseAmount(line.amount)
    if (qty === null || price === null || amount === null) continue
    if (Math.abs(qty * price - amount) <= AMOUNT_TOLERANCE) continue
    badCount += 1
    if (first === -1) first = i
  }
  return first === -1 ? null : { index: first, badCount }
}

export const RULES: ValidationRule[] = [
  {
    id: 'invoice.vendor_name.present', appliesTo: 'invoice', fields: ['vendor_name'],
    run: (b) => present(header(b), 'vendor_name') ? []
      : [make('invoice.vendor_name.present', 'vendor_name', 'error', 'No vendor name was extracted.')],
  },
  {
    id: 'invoice.invoice_number.present', appliesTo: 'invoice', fields: ['invoice_number'],
    run: (b) => present(header(b), 'invoice_number') ? []
      : [make('invoice.invoice_number.present', 'invoice_number', 'error', 'No invoice number was extracted.')],
  },
  {
    id: 'invoice.invoice_date.present', appliesTo: 'invoice', fields: ['invoice_date'],
    run: (b) => present(header(b), 'invoice_date') ? []
      : [make('invoice.invoice_date.present', 'invoice_date', 'error', 'No invoice date was extracted.')],
  },
  {
    id: 'invoice.total.present', appliesTo: 'invoice', fields: ['total'],
    run: (b) => present(header(b), 'total') ? []
      : [make('invoice.total.present', 'total', 'error', 'No total amount was extracted.')],
  },
  {
    id: 'invoice.currency.shape', appliesTo: 'invoice', fields: ['currency'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'currency') || isCurrencyShape(h.currency)) return []
      return [make('invoice.currency.shape', 'currency', 'warning',
        'Currency is not a three-letter code.', { currency: String(h.currency) })]
    },
  },
  {
    id: 'invoice.total.nonnegative', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const n = parseAmount(header(b).total)
      return n !== null && n < 0
        ? [make('invoice.total.nonnegative', 'total', 'error', 'Total is negative.', { total: n })]
        : []
    },
  },
  {
    id: 'invoice.total.range', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const n = parseAmount(header(b).total)
      return n !== null && n >= MAX_PLAUSIBLE_AMOUNT
        ? [make('invoice.total.range', 'total', 'warning',
            'Total is at or above ' + MAX_PLAUSIBLE_AMOUNT + ', which usually means digits ran together.', { total: n })]
        : []
    },
  },
  {
    id: 'invoice.total.sum', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const h = header(b)
      const subtotal = parseAmount(h.subtotal)
      const tax = parseAmount(h.tax)
      const total = parseAmount(h.total)
      if (subtotal === null || tax === null || total === null) return []
      const expected = subtotal + tax
      if (Math.abs(expected - total) <= AMOUNT_TOLERANCE) return []
      return [make('invoice.total.sum', 'total', 'error',
        'Subtotal plus tax is ' + expected.toFixed(2) + ' but the total reads ' + total.toFixed(2) + '.',
        { subtotal, tax, total, expected })]
    },
  },
  {
    id: 'invoice.invoice_date.future', appliesTo: 'invoice', fields: ['invoice_date'],
    run: (b, ctx) => {
      const d = parseDate(header(b).invoice_date)
      return d !== null && d > ctx.today
        ? [make('invoice.invoice_date.future', 'invoice_date', 'warning',
            'Invoice date is after today.', { invoice_date: d, today: ctx.today })]
        : []
    },
  },
  {
    id: 'invoice.due_date.order', appliesTo: 'invoice', fields: ['due_date'],
    run: (b) => {
      const h = header(b)
      const issued = parseDate(h.invoice_date)
      const due = parseDate(h.due_date)
      if (issued === null || due === null) return []
      return due < issued
        ? [make('invoice.due_date.order', 'due_date', 'error',
            'Due date precedes the invoice date.', { invoice_date: issued, due_date: due })]
        : []
    },
  },
  {
    id: 'invoice.vendor_email.format', appliesTo: 'invoice', fields: ['vendor_email'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'vendor_email') || isEmail(h.vendor_email)) return []
      return [make('invoice.vendor_email.format', 'vendor_email', 'warning',
        'Vendor email is not a valid address.', { vendor_email: String(h.vendor_email) })]
    },
  },
  {
    id: 'invoice.lines.amount', appliesTo: 'invoice', fields: ['lines.amount'],
    run: (b) => {
      const bad = lineAmountFailure(b.lines)
      if (bad === null) return []
      const line = b.lines[bad.index] as Row
      return [make('invoice.lines.amount', 'lines.amount', 'warning',
        'Line ' + (bad.index + 1) + ' is ' + String(line.quantity) + ' at ' + String(line.unit_price)
          + ' but reads ' + String(line.amount) + '.',
        { line: bad.index, badLineCount: bad.badCount })]
    },
  },
  {
    id: 'invoice.lines.present', appliesTo: 'invoice', fields: ['lines.amount'],
    run: (b) => (present(header(b), 'total') && b.lines.length === 0)
      ? [make('invoice.lines.present', 'lines.amount', 'warning',
          'A total was extracted but no line item was.')]
      : [],
  },
]
```

A document missing its total yields `invoice.total.present` and no arithmetic complaint, because the
value rules require every operand to parse before they speak. That is why the silence tests in Step 1
matter as much as the firing tests.

- [ ] **Step 3: Run and confirm**

Run: `npx vitest run tests/validation/rules-invoice.test.ts tests/validation/evaluate.test.ts`
Expected: all PASS, and `evaluate.test.ts` still passes against a non-empty `RULES` because it injects its own rules.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/validation/rules.ts tests/validation/rules-invoice.test.ts
git commit -m "feat(validation): thirteen invoice rules, each with the case that fires it"
```

---
---

### Task 5: Contract rule catalogue (spec section 6, rows 14 to 19)

**Files:**
- Modify: `src/validation/rules.ts` (append six entries to `RULES`)
- Create: `tests/validation/rules-contract.test.ts`

**Interfaces:**
- Consumes: the same helpers Task 4 introduced: `make`, `header`, `present`, the `./values.js` primitives.
- Produces: `RULES.length === 19`. Tasks 6 to 13 import only `RULES`, `evaluate`, `buildBundle`, `RULESET_VERSION` and `localDay`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/rules-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildBundle, evaluate, RULES } from '../../src/validation/index.js'
import type { ValidationContext } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }

const GOOD = {
  counterparty: 'Blue Mountains Physio',
  counterparty_email: 'legal@bmpphysio.example',
  effective_date: '2026-01-01',
  expiry_date: '2026-12-31',
  term_months: 12,
  contract_value: '48000.00',
  currency: 'AUD',
  auto_renewal: true,
  renewal_notice_days: 60,
}

function check(overrides: Record<string, unknown>) {
  return evaluate(buildBundle('contract', { ...GOOD, ...overrides }, [], []), CTX)
}
const ids = (v: ReturnType<typeof check>) => v.map((x) => x.ruleId)

it('fires nothing at all on a compliant contract', () => {
  expect(check({})).toEqual([])
})

it('errors on a missing counterparty and stays silent on a missing value', () => {
  expect(ids(check({ counterparty: null }))).toEqual(['contract.counterparty.present'])
  expect(ids(check({ contract_value: null }))).toEqual([])
})

it('warns on a currency that is not three letters', () => {
  expect(ids(check({ currency: 'AUD$' }))).toContain('contract.currency.shape')
})

it('errors on a negative contract value', () => {
  const hit = check({ contract_value: '-48000' }).find((x) => x.ruleId === 'contract.value.nonnegative')
  expect(hit?.severity).toBe('error')
  expect(hit?.field).toBe('contract_value')
})

it('errors when expiry precedes effect and needs both dates', () => {
  expect(ids(check({ expiry_date: '2025-12-31' }))).toContain('contract.date.order')
  expect(ids(check({ expiry_date: null }))).not.toContain('contract.date.order')
  expect(ids(check({ effective_date: 'n/a' }))).not.toContain('contract.date.order')
})

describe('term_months', () => {
  it('warns outside one to six hundred', () => {
    expect(ids(check({ term_months: 0 }))).toContain('contract.term.range')
    expect(ids(check({ term_months: 601 }))).toContain('contract.term.range')
    expect(ids(check({ term_months: 1 }))).not.toContain('contract.term.range')
    expect(ids(check({ term_months: 600 }))).not.toContain('contract.term.range')
  })
  it('stays silent when absent', () => {
    expect(ids(check({ term_months: null }))).not.toContain('contract.term.range')
  })
})

it('warns on a malformed counterparty email but not on an absent one', () => {
  expect(ids(check({ counterparty_email: 'nope' }))).toContain('contract.counterparty_email.format')
  expect(ids(check({ counterparty_email: null }))).not.toContain('contract.counterparty_email.format')
})

it('never reaches into the other kind', () => {
  for (const violation of check({ counterparty: null, currency: 'X', term_months: 900 })) {
    expect(violation.ruleId.startsWith('contract.')).toBe(true)
  }
})

it('pins the nineteen rule ids across both kinds', () => {
  expect(RULES.length).toBe(19)
  expect(new Set(RULES.map((r) => r.id)).size).toBe(19)
  expect(RULES.filter((r) => r.appliesTo === 'contract').map((r) => r.id).sort()).toEqual([
    'contract.counterparty.present',
    'contract.counterparty_email.format',
    'contract.currency.shape',
    'contract.date.order',
    'contract.term.range',
    'contract.value.nonnegative',
  ])
})
```

Run: `npx vitest run tests/validation/rules-contract.test.ts`
Expected: FAIL, `RULES.length` is 13 and no `contract.*` id exists.

- [ ] **Step 2: Implement**

Append to the `RULES` array in `src/validation/rules.ts`. Reuse `make`, `header`, `present`; do not add a second helper file.

```ts
  {
    id: 'contract.counterparty.present', appliesTo: 'contract', fields: ['counterparty'],
    run: (b) => present(header(b), 'counterparty') ? []
      : [make('contract.counterparty.present', 'counterparty', 'error', 'No counterparty was extracted.')],
  },
  {
    id: 'contract.currency.shape', appliesTo: 'contract', fields: ['currency'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'currency') || isCurrencyShape(h.currency)) return []
      return [make('contract.currency.shape', 'currency', 'warning',
        'Currency is not a three-letter code.', { currency: String(h.currency) })]
    },
  },
  {
    id: 'contract.value.nonnegative', appliesTo: 'contract', fields: ['contract_value'],
    run: (b) => {
      const n = parseAmount(header(b).contract_value)
      return n !== null && n < 0
        ? [make('contract.value.nonnegative', 'contract_value', 'error', 'Contract value is negative.', { contract_value: n })]
        : []
    },
  },
  {
    id: 'contract.date.order', appliesTo: 'contract', fields: ['expiry_date'],
    run: (b) => {
      const h = header(b)
      const start = parseDate(h.effective_date)
      const end = parseDate(h.expiry_date)
      if (start === null || end === null) return []
      return end < start
        ? [make('contract.date.order', 'expiry_date', 'error',
            'Expiry date precedes the effective date.', { effective_date: start, expiry_date: end })]
        : []
    },
  },
  {
    id: 'contract.term.range', appliesTo: 'contract', fields: ['term_months'],
    run: (b) => {
      const raw = header(b).term_months
      if (isAbsent(raw)) return []
      const n = Number(raw)
      if (!Number.isFinite(n)) return []
      return n < 1 || n > 600
        ? [make('contract.term.range', 'term_months', 'warning',
            'Term is outside one to six hundred months.', { term_months: n })]
        : []
    },
  },
  {
    id: 'contract.counterparty_email.format', appliesTo: 'contract', fields: ['counterparty_email'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'counterparty_email') || isEmail(h.counterparty_email)) return []
      return [make('contract.counterparty_email.format', 'counterparty_email', 'warning',
        'Counterparty email is not a valid address.', { counterparty_email: String(h.counterparty_email) })]
    },
  },
```

- [ ] **Step 3: Run the whole validation suite**

Run: `npx vitest run tests/validation`
Expected: all PASS across the four files.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/validation/rules.ts tests/validation/rules-contract.test.ts
git commit -m "feat(validation): six contract rules and the nineteen-rule catalogue"
```

---

### Task 6: Migration 0024 and the audit trigger placeholder guard

**Files:**
- Create: `migrations/0024_crum_field_validation.sql`
- Create: `migrations/0025_crum_audit_user_placeholder_guard.sql`
- Create: `tests/db/audit-context-placeholder.test.ts`

Resolved at pre-flight: `tests/db/schema-parity.test.ts` does not exist, and the only table-enumerating test is `tests/integration/migrations.test.ts`, whose `SPINE_TABLES` list at `:34-45` names the nine spine tables and nothing added by `0018` to `0023`. Marketing's own migrations did not extend it, so neither does this one. No test file is modified by this task.

**Interfaces:**
- Consumes: `documents(id)`, and the `log_field_changes()` body shipped in `migrations/0023_crum_field_audit.sql:28-100`.
- Produces: table `document_validation` with columns `id, document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message, status, waived_by, waived_at, waiver_reason, created_at` and constraint `uq_validation_slot UNIQUE (document_id, rule_id, field_name)`. Task 7 writes it. Also produces the corrected `log_field_changes()`, which reads the actor as `NULLIF(current_setting('app.current_user_id', true), '')::uuid`, so Tasks 8 to 13 can write audited rows on a pooled backend that has already carried a correction.

- [ ] **Step 1: Confirm 0024 and 0025 are free**

Run: `ls migrations/ | tail -5 && grep -rl "002[45]" migrations/ | head`
Expected: the highest existing prefix is `0023`. If another file already claims one of these numbers, take the next free number and update every reference to the filename in this plan's later tasks.

- [ ] **Step 2: Write the migration**

```sql
-- Phase 2: validation findings for extracted business documents.
-- Migration 0024: one row per live finding, so analytics group by rule and by field
-- and export selects a date slice. Phase 1's document_field_audit records what
-- changed; this records what is wrong and whether a human overrode it.
--
-- Do not add BEGIN or COMMIT here; scripts/db-migrate.ts wraps this file and its
-- version record in one transaction.

CREATE TABLE IF NOT EXISTS document_validation (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Written from the caller's identity, never copied from the document row, so a
  -- mismatch is caught by the tenant predicate instead of inherited silently.
  tenant_id        uuid        NOT NULL,
  ruleset_version  text        NOT NULL,
  severity         text        NOT NULL CHECK (severity IN ('error', 'warning')),
  rule_id          text        NOT NULL,
  field_name       text        NOT NULL,
  message          text        NOT NULL,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waived')),
  waived_by        uuid,
  waived_at        timestamptz,
  waiver_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One live finding per rule per field per document.
  CONSTRAINT uq_validation_slot UNIQUE (document_id, rule_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_validation_doc_status  ON document_validation (document_id, status);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_rule ON document_validation (tenant_id, rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_field ON document_validation (tenant_id, field_name, created_at DESC);
```

- [ ] **Step 3: Write the failing placeholder-guard test**

Create `tests/db/audit-context-placeholder.test.ts`. Copy the `.env` header from `tests/db/field-audit.test.ts:1-12` and the session-mode connection and `seedInvoice` pattern from `tests/db/audit-context-isolation.test.ts`, which Task 2 landed. The point is a backend that has ALREADY carried a transaction-local context, because that is the state in which Postgres leaves the custom GUC holding the placeholder `''` rather than NULL.

```ts
it('still audits a contextless write on a backend that once carried a context', async () => {
  // 1. open a session-mode pool so one pinned backend sees both transactions
  // 2. BEGIN; setAuditContext(client, { userId: USER, changeSource: 'manual_correction' });
  //    UPDATE invoices SET total = ...; COMMIT
  // 3. assert the backend now reads the GUC as '' rather than NULL:
  //    SELECT current_setting('app.current_user_id', true) IS NULL
  // 4. BEGIN; UPDATE invoices SET total = ... on a SECOND seeded document with no
  //    setAuditContext call at all; COMMIT
  // 5. expect(step 4).toResolve(), and the second document's audit rows to carry
  //    changed_by IS NULL and change_source = 'extraction'
})
```

Run: `npx vitest run tests/db/audit-context-placeholder.test.ts`
Expected: FAIL at step 4 with `error: invalid input syntax for type uuid: ""`. Record that output in the report; it is the evidence the guard is needed. If step 3 reads NULL rather than `''`, the premise is wrong on this server version: stop and report BLOCKED with what the read returned, because then Step 4 has a different cause.

- [ ] **Step 4: Write 0025 and make the test pass**

Create `migrations/0025_crum_audit_user_placeholder_guard.sql`. Copy the body of `log_field_changes()` from `migrations/0023_crum_field_audit.sql:28-100` verbatim into a `CREATE OR REPLACE FUNCTION log_field_changes() RETURNS TRIGGER AS $$ ... $$ LANGUAGE plpgsql;` statement, and change exactly one line: 0023's

```sql
  user_id := current_setting('app.current_user_id', true)::uuid;
```

becomes

```sql
  user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
```

`NULLIF` turns the custom GUC's placeholder `''` back into SQL NULL before the uuid cast. The `change_source` two lines below already guards for `''` the same way; this line was the one that did not, so any contextless write to an audited table that landed on a backend which had ever carried a correction threw instead of auditing with a NULL actor.

Above the statement, put a header comment naming the single delta and why, and do not restate 0023's trigger attachment or the `field_confidence` `ALTER TABLE`s: the trigger already exists and points at this function by name, so replacing the function is enough. Do not add `BEGIN` or `COMMIT`.

Run: `npx vitest run tests/db/audit-context-placeholder.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply both migrations**

Run: `npx tsx scripts/db-migrate.ts`
Expected: it records versions `0024` and `0025` and prints no error. If the runner refuses because it expects a paired schema export, run `npm run db:export-schema` and include the regenerated artifact in Step 6's commit.

- [ ] **Step 6: Verify the shapes with psql through the runner's own client**

Run:

```bash
npx tsx -e "
import { getDbClient } from './src/db/client.ts'
const r = await getDbClient().query(\"select column_name, data_type, is_nullable from information_schema.columns where table_name='document_validation' order by ordinal_position\")
console.table(r.rows)
const c = await getDbClient().query(\"select conname from pg_constraint where conrelid='document_validation'::regclass\")
console.log(c.rows.map((x) => x.conname))
const f = await getDbClient().query(\"select prosrc from pg_proc where proname='log_field_changes'\")
console.log(f.rows[0].prosrc.includes(\"NULLIF(current_setting('app.current_user_id', true), '')::uuid\"))
"
```

Expected: 13 columns in the order above, the constraint list includes `uq_validation_slot`, `document_validation_severity_check`, `document_validation_status_check`, and the last line prints `true`, which proves the live server carries the guarded cast.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add migrations/0024_crum_field_validation.sql migrations/0025_crum_audit_user_placeholder_guard.sql tests/db/audit-context-placeholder.test.ts
git commit -m "feat(db): one row per validation finding, and the audit trigger stops casting the GUC placeholder"
```

The reviewer for this task must diff 0025's function body against `migrations/0023_crum_field_audit.sql:28-100` and confirm the two bodies differ by that one line and the header comment only. Restating a function body is how a plpgsql fix ships, so the copy is not a duplication finding; an undocumented second difference in the body is.

---
---

### Task 7: Persistence and read layer

**Files:**
- Create: `src/db/validation.ts`
- Create: `tests/db/validation.test.ts`

**Interfaces:**
- Consumes: `document_validation` from Task 6, `getDbClient()`, `Violation` from Task 3.
- Produces:

```ts
export interface StoredViolation {
  id: string
  documentId: string
  rulesetVersion: string
  severity: 'error' | 'warning'
  ruleId: string
  field: string
  message: string
  status: 'open' | 'waived'
  waivedBy: string | null
  waivedAt: string | null
  waiverReason: string | null
  createdAt: string
}
export interface WaiveResult { ok: true; violation: StoredViolation }
export interface WaiveFailure { ok: false; reason: 'not_found' | 'already_waived' }

export function replaceValidation(
  client: Q,
  documentId: string,
  tenantId: string,
  violations: readonly Violation[],
  rulesetVersion: string,
): Promise<{ openErrors: number; openWarnings: number }>
export function listViolations(documentId: string, tenantId: string): Promise<StoredViolation[]>
export function waiveViolation(violationId: string, tenantId: string, userId: string, reason: string): Promise<WaiveResult | WaiveFailure>
export function openCounts(documentIds: readonly string[], tenantId: string): Promise<Map<string, { errors: number; warnings: number }>>
```

`Q` is the query interface both `Pool` and `PoolClient` satisfy: `<T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>`. Export it so Task 9 can pass the correction handler's `PoolClient`.

Ruling carried from spec section 7.2: `replaceValidation` takes the caller's connection so Task 10 can keep the field write and the finding refresh in one transaction.

- [ ] **Step 1: Write the failing DB tests**

Create `tests/db/validation.test.ts`. Copy the `.env` header, the `TENANT` and `USER` constants, and the invoice seeding helper from `tests/db/field-audit.test.ts:1-80`.

```ts
async function run(documentId: string, violations: Violation[]) {
  return replaceValidation(getDbClient(), documentId, TENANT, violations, 'v1')
}

const sumFailure: Violation = {
  ruleId: 'invoice.total.sum', field: 'total', severity: 'error',
  message: 'Subtotal plus tax does not equal the total.',
}
const shapeWarning: Violation = {
  ruleId: 'invoice.currency.shape', field: 'currency', severity: 'warning',
  message: 'Currency is not a three-letter code.',
}

it('writes both severities and returns their open counts', async () => {
  const doc = await seedInvoice('val-counts')
  expect(await run(doc, [sumFailure, shapeWarning])).toEqual({ openErrors: 1, openWarnings: 1 })
  const rows = await listViolations(doc, TENANT)
  expect(rows.map((r) => r.ruleId)).toEqual(['invoice.total.sum', 'invoice.currency.shape'])
})

it('replaces an open finding that no longer fires and keeps the one that still does', async () => {
  const doc = await seedInvoice('val-replace')
  await run(doc, [sumFailure, shapeWarning])
  await run(doc, [sumFailure])
  expect((await listViolations(doc, TENANT)).map((r) => r.ruleId)).toEqual(['invoice.total.sum'])
})

it('is idempotent: running twice leaves one row per rule and field', async () => {
  const doc = await seedInvoice('val-idem')
  await run(doc, [sumFailure])
  await run(doc, [sumFailure])
  expect((await listViolations(doc, TENANT)).length).toBe(1)
})

it('never reopens a waived finding on a re-run', async () => {
  const doc = await seedInvoice('val-waive-rerun')
  await run(doc, [sumFailure])
  const [first] = await listViolations(doc, TENANT)
  const waived = await waiveViolation(first.id, TENANT, USER, 'credit note nets this invoice off')
  expect(waived.ok).toBe(true)

  const counts = await run(doc, [sumFailure])
  expect(counts.openErrors).toBe(0)
  const after = await listViolations(doc, TENANT)
  expect(after[0].status).toBe('waived')
  expect(after[0].waivedBy).toBe(USER)
  expect(after[0].waiverReason).toBe('credit note nets this invoice off')
})

it('refuses to waive the same finding twice', async () => {
  const doc = await seedInvoice('val-double-waive')
  await run(doc, [sumFailure])
  const [row] = await listViolations(doc, TENANT)
  expect(await waiveViolation(row.id, TENANT, USER, 'first override')).toMatchObject({ ok: true })
  expect(await waiveViolation(row.id, TENANT, USER, 'second override')).toEqual({ ok: false, reason: 'already_waived' })
})

it('will not read or waive across tenants', async () => {
  const doc = await seedInvoice('val-isolation')
  await run(doc, [sumFailure])
  const [row] = await listViolations(doc, TENANT)
  const OTHER = '00000000-0000-4000-8000-000000000099'
  expect(await listViolations(doc, OTHER)).toEqual([])
  expect(await waiveViolation(row.id, OTHER, USER, 'trying another tenant')).toEqual({ ok: false, reason: 'not_found' })
})

it('drops the findings with the document', async () => {
  const doc = await seedInvoice('val-cascade')
  await run(doc, [sumFailure])
  await getDbClient().query('DELETE FROM documents WHERE id = $1', [doc])
  const rows = await getDbClient().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM document_validation WHERE document_id = $1', [doc],
  )
  expect(rows.rows[0].n).toBe('0')
})

it('openCounts reports one entry per document and none for a clean one', async () => {
  const a = await seedInvoice('val-open-a')
  const b = await seedInvoice('val-open-b')
  await run(a, [sumFailure, shapeWarning])
  const counts = await openCounts([a, b], TENANT)
  expect(counts.get(a)).toEqual({ errors: 1, warnings: 1 })
  expect(counts.has(b)).toBe(false)
})
```

Run: `npx vitest run tests/db/validation.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 2: Implement**

```ts
import { getDbClient } from './client.js'
import { toIsoString } from './timestamps.js'
import type { Violation } from '../validation/index.js'

export interface Q {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface StoredViolation { /* the shape in the Interfaces block above */ }

const COLUMN_BY_KEY: Record<string, 'rule_id' | 'field_name' | 'severity' | 'message'> = {
  ruleId: 'rule_id', field: 'field_name', severity: 'severity', message: 'message',
}

function rowToStored(row: Record<string, unknown>): StoredViolation {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    rulesetVersion: row.ruleset_version as string,
    severity: row.severity as 'error' | 'warning',
    ruleId: row.rule_id as string,
    field: row.field_name as string,
    message: row.message as string,
    status: row.status as 'open' | 'waived',
    waivedBy: (row.waived_by as string | null) ?? null,
    waivedAt: row.waived_at == null ? null : toIsoString(row.waived_at, 'document_validation.waived_at'),
    waiverReason: (row.waiver_reason as string | null) ?? null,
    createdAt: toIsoString(row.created_at, 'document_validation.created_at'),
  }
}

const SELECT_COLUMNS = `id, document_id, ruleset_version, severity, rule_id, field_name, message,
        status, waived_by, waived_at, waiver_reason, created_at`

/**
 * Upsert the open findings, refresh the ones that still fire, then drop the open
 * rows this run did not produce. A waived row survives both steps, so an override
 * outlives the re-run that would otherwise erase it.
 */
export async function replaceValidation(
  client: Q,
  documentId: string,
  tenantId: string,
  violations: readonly Violation[],
  rulesetVersion: string,
): Promise<{ openErrors: number; openWarnings: number }> {
  for (const v of violations) {
    await client.query(
      `INSERT INTO document_validation
         (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (document_id, rule_id, field_name) DO UPDATE
         SET severity = EXCLUDED.severity,
             message = EXCLUDED.message,
             ruleset_version = EXCLUDED.ruleset_version,
             created_at = now()
         WHERE document_validation.status = 'open'`,
      [documentId, tenantId, rulesetVersion, v.severity, v.ruleId, v.field, v.message],
    )
  }

  if (violations.length > 0) {
    await client.query(
      `DELETE FROM document_validation
       WHERE document_id = $1 AND tenant_id = $2 AND status = 'open'
         AND (rule_id, field_name) NOT IN (
           SELECT unnest(pairs) FROM unnest($3::text[]) AS pairs
         )`,
      [documentId, tenantId, violations.map((v) => `(${v.ruleId},${v.field})`)],
    )
  } else {
    await client.query(
      `DELETE FROM document_validation WHERE document_id = $1 AND tenant_id = $2 AND status = 'open'`,
      [documentId, tenantId],
    )
  }

  const counts = await client.query<{ severity: string; n: string }>(
    `SELECT severity, count(*)::text AS n FROM document_validation
     WHERE document_id = $1 AND tenant_id = $2 AND status = 'open' GROUP BY severity`,
    [documentId, tenantId],
  )
  const of = (s: string) => Number(counts.rows.find((r) => r.severity === s)?.n ?? '0')
  return { openErrors: of('error'), openWarnings: of('warning') }
}

export async function listViolations(documentId: string, tenantId: string): Promise<StoredViolation[]> {
  const rows = await getDbClient().query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM document_validation
     WHERE document_id = $1 AND tenant_id = $2
     ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, rule_id`,
    [documentId, tenantId],
  )
  return rows.rows.map(rowToStored)
}

export async function waiveViolation(
  violationId: string,
  tenantId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true; violation: StoredViolation } | { ok: false; reason: 'not_found' | 'already_waived' }> {
  const updated = await getDbClient().query<Record<string, unknown>>(
    `UPDATE document_validation
     SET status = 'waived', waived_by = $4, waived_at = now(), waiver_reason = $5
     WHERE id = $1 AND tenant_id = $2 AND status = 'open'
     RETURNING ${SELECT_COLUMNS}`,
    [violationId, tenantId, reason, userId, reason],
  )
  if (updated.rows.length > 0) return { ok: true, violation: rowToStored(updated.rows[0]) }

  const existing = await getDbClient().query<{ id: string }>(
    'SELECT id FROM document_validation WHERE id = $1 AND tenant_id = $2',
    [violationId, tenantId],
  )
  return { ok: false, reason: existing.rows.length === 0 ? 'not_found' : 'already_waived' }
}

export async function openCounts(
  documentIds: readonly string[],
  tenantId: string,
): Promise<Map<string, { errors: number; warnings: number }>> {
  const out = new Map<string, { errors: number; warnings: number }>()
  if (documentIds.length === 0) return out
  const rows = await getDbClient().query<{ document_id: string; severity: string; n: string }>(
    `SELECT document_id, severity, count(*)::text AS n
     FROM document_validation
     WHERE tenant_id = $1 AND document_id = ANY($2::uuid[]) AND status = 'open'
     GROUP BY document_id, severity`,
    [tenantId, [...documentIds]],
  )
  for (const row of rows.rows) {
    const entry = out.get(row.document_id) ?? { errors: 0, warnings: 0 }
    if (row.severity === 'error') entry.errors = Number(row.n)
    else entry.warnings = Number(row.n)
    out.set(row.document_id, entry)
  }
  return out
}
```

Two points the implementer must verify rather than assume. First, `waiveViolation` binds `reason` twice because the `UPDATE` needs it for `waiver_reason` while `$3` is unused; delete the unused placeholder rather than leaving it, so the parameter list matches the SQL exactly. Second, the `NOT IN` row-comparison trick is awkward; the cleaner and equally correct form is

```sql
AND NOT EXISTS (
  SELECT 1 FROM unnest($3::text[], $4::text[]) AS p(rule, field)
  WHERE p.rule = document_validation.rule_id AND p.field = document_validation.field_name
)
```

Use that form, passing two parallel arrays, and confirm the replace test still passes. `COLUMN_BY_KEY` is dead once the row mapper is written; delete it rather than shipping it.

- [ ] **Step 3: Run the suite**

Run: `npx vitest run tests/db/validation.test.ts`
Expected: all PASS.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/db/validation.ts tests/db/validation.test.ts
git commit -m "feat(db): findings persist one row per rule and field, and a waiver outlives a re-run"
```

---

### Task 8: Intake wiring

**Files:**
- Modify: `src/mastra/workflows/document-intake.ts`
- Create: `src/validation/fields.ts`
- Create: `tests/mastra/workflows/intake-validation.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `buildBundle`, `localDay`, `RULESET_VERSION` from Task 3; `replaceValidation` from Task 7; the `normalized` shape already produced by `normalizeAndResolveStep` (`{ header, lines }` or `{ header, terms }`, cast at `document-intake.ts:540-550`).
- Produces:

```ts
// src/validation/fields.ts
export const INVOICE_FIELDS: readonly string[]
export const CONTRACT_FIELDS: readonly string[]
export const LINE_FIELDS: readonly string[]
export function isCorrectable(field: string): boolean
```

`INVOICE_FIELDS` and `CONTRACT_FIELDS` are the column lists currently duplicated as the local
`ALLOWED_INVOICE_FIELDS` and `ALLOWED_CONTRACT_FIELDS` at `src/api/documents.ts:359-360`. They move
here so the engine, the correction route and the queue agree on one list. Task 9 deletes the two local
copies. `persistStructuredStep` gains `export`, so the test can drive it directly.

- [ ] **Step 1: Create `src/validation/fields.ts`**

```ts
/** Columns a reviewer may correct. The audit trigger fires on each of these. */
export const INVOICE_FIELDS = [
  'vendor_name', 'vendor_email', 'invoice_number', 'invoice_date',
  'due_date', 'currency', 'subtotal', 'tax', 'total',
] as const

export const CONTRACT_FIELDS = [
  'counterparty', 'counterparty_email', 'effective_date', 'expiry_date',
  'term_months', 'contract_value', 'currency', 'auto_renewal', 'renewal_notice_days',
] as const

/** Qualified names for line findings, which display but do not correct in this phase. */
export const LINE_FIELDS = ['lines.amount'] as const

const CORRECTABLE = new Set<string>([...INVOICE_FIELDS, ...CONTRACT_FIELDS, ...LINE_FIELDS])

export function isCorrectable(field: string): boolean {
  return CORRECTABLE.has(field)
}
```

Run: `npx tsc --noEmit`
Expected: exit 0. Nothing imports the new module yet.

- [ ] **Step 2: Write the failing tests**

`persistStructuredStep` is the unit under test, so the test drives it with a mocked `src/db/documents` and a mocked `src/db/validation`, the same mock style and the same relative depth `tests/mastra/workflows/ingest-asset-guard.test.ts:13-17` uses.

```ts
const h = vi.hoisted(() => ({
  insertDocument: vi.fn(),
  replaceValidation: vi.fn(),
  resolveCustomerByEntity: vi.fn(async () => null),
}))
vi.mock('../../../src/db/documents', () => ({
  insertDocument: h.insertDocument,
  resolveCustomerByEntity: h.resolveCustomerByEntity,
}))
vi.mock('../../../src/db/validation', () => ({ replaceValidation: h.replaceValidation }))
```

Then use the real engine rather than a mocked one, because the point of the test is the blend of the two. Import `persistStructuredStep` from `../../../src/mastra/workflows/document-intake.js`.

```ts
const BAD_SUM = {
  kind: 'invoice',
  normalized: {
    header: {
      vendor_name: 'Acme', vendor_email: 'billing@acme.example', invoice_number: 'INV-1',
      invoice_date: '2026-10-01', due_date: '2026-10-31', currency: 'AUD',
      subtotal: '1000.00', tax: '100.00', total: '1200.00',
    },
    lines: [{ description: 'x', quantity: '2', unit_price: '600', amount: '1200' }],
  },
  confidence: 0.95,
  needsReview: false,
  fieldConfidence: { total: 0.95 },
  customerId: null,
  tenantId: TENANT, ownerId: OWNER, title: 't', text: 'body', contentType: 'text',
  documentTitle: 't', mime: 'text/plain', source: 'upload', sourceRef: null, extract: {},
}

it('queues a document at high confidence because the arithmetic is wrong', async () => {
  h.insertDocument.mockResolvedValue({ id: DOC })
  h.replaceValidation.mockResolvedValue({ openErrors: 1, openWarnings: 0 })
  const out = await persistStructuredStep.execute({ inputData: BAD_SUM } as never)
  expect(out.status).toBe('needs_review')
  expect(out.validationCount).toBeGreaterThan(0)
})

it('does not let a warning alone queue a clean document', async () => {
  h.insertDocument.mockResolvedValue({ id: DOC })
  h.replaceValidation.mockResolvedValue({ openErrors: 0, openWarnings: 1 })
  const out = await persistStructuredStep.execute({ inputData: WARN_ONLY } as never)
  expect(out.status).toBe('ready')
})

it('passes the document id and the tenant to the writer, not a guessed tenant', async () => {
  await persistStructuredStep.execute({ inputData: BAD_SUM } as never)
  expect(h.replaceValidation).toHaveBeenCalledWith(
    expect.anything(), DOC, TENANT, expect.arrayContaining([
      expect.objectContaining({ ruleId: 'invoice.total.sum', severity: 'error' }),
    ]), 'v1',
  )
})

it('does not validate a document that extracted nothing', async () => {
  const out = await persistStructuredStep.execute({ inputData: { ...BAD_SUM, normalized: null } } as never)
  expect(h.replaceValidation).not.toHaveBeenCalled()
  expect(out.validationCount).toBe(0)
})

it('leaves a compliant invoice at ready', async () => {
  h.replaceValidation.mockResolvedValue({ openErrors: 0, openWarnings: 0 })
  const out = await persistStructuredStep.execute({ inputData: COMPLIANT } as never)
  expect(out.status).toBe('ready')
  expect(out.validationCount).toBe(0)
})
```

`WARN_ONLY` is `BAD_SUM` with `currency: 'AUD$'` and a correct sum. `COMPLIANT` is `BAD_SUM` with `total: '1100.00'`. Set `h.replaceValidation` to resolve `{ openErrors: 1, openWarnings: 0 }` in the first three cases and derive the real count from the engine in the last two; assert on both, because a mock that agrees with the engine by accident proves nothing. If the step counts from the writer's return value, the mock decides the outcome and the test is hollow, so count from `evaluate` in the implementation and let the mock only stand in for the write.

Run: `npx vitest run tests/mastra/workflows/intake-validation.test.ts`
Expected: FAIL, no `validationCount` on the output and `status` is `ready` for `BAD_SUM`.

- [ ] **Step 3: Extend the persisted schema**

`persistedSchema` at `document-intake.ts:515` gains one field:

```ts
const persistedSchema = normalizedSchema.extend({
  documentId: z.string().uuid(),
  status: z.enum(['ready', 'needs_review']),
  validationCount: z.number().int().min(0),
  openErrors: z.number().int().min(0),
  text: z.string(),
  contentType: z.string(),
  documentTitle: z.string(),
})
```

Both new keys are additive, so `src/queue/intake-run.ts` and the processing dashboard keep reading the keys they know.

- [ ] **Step 4: Evaluate before the insert and feed the status**

Inside `persistStructuredStep.execute`, after `invoicePart` and `contractPart` are derived and before `insertDocument`:

```ts
const bundle = inputData.normalized
  ? buildBundle(
      inputData.kind as 'invoice' | 'contract',
      (invoicePart?.header ?? contractPart?.header ?? null) as Record<string, unknown> | null,
      (invoicePart?.lines ?? []) as Array<Record<string, unknown>>,
      (contractPart?.terms ?? []) as Array<Record<string, unknown>>,
    )
  : null
const violations = bundle
  ? evaluate(bundle, { today: localDay(new Date()) }).filter((v) => isCorrectable(v.field))
  : []
const openErrors = violations.filter((v) => v.severity === 'error').length
const status = inputData.needsReview || openErrors > 0 ? 'needs_review' : 'ready'
```

`isCorrectable` comes from `src/validation/fields.ts`, created in Step 1. Findings on any other field are dropped rather than stored, so a stored finding always names something the review surface can either correct or explain.

- [ ] **Step 5: Write the findings after the insert**

After `created` returns, on the same connection the step already uses:

```ts
const counts = await replaceValidation(
  getDbClient(), created.id, inputData.tenantId, violations, RULESET_VERSION,
)
return { ...inputData, documentId: created.id, status, validationCount: violations.length, openErrors: counts.openErrors, text: inputData.text, contentType: inputData.contentType, documentTitle: inputData.title }
```

`insertDocument` already runs in its own transaction, so a separate `replaceValidation` immediately after it can leave a persisted document with no findings if the second write throws. Wrap the two in one transaction using `getDbClient().connect()` and the `Q` parameter `replaceValidation` already accepts, and pass that client to `insertDocument` if it takes one; if it does not, accept the small window and record it in the report as a known gap rather than refactoring `insertDocument` in this task.

- [ ] **Step 6: Run the workflow suite and the queue suite**

Run: `npx vitest run tests/mastra/workflows tests/queue`
Expected: all PASS, including the pre-existing intake tests, which now assert a wider output shape.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/validation/fields.ts src/mastra/workflows/document-intake.ts tests/mastra/workflows/intake-validation.test.ts
git commit -m "feat(intake): a broken sum queues a document even at high confidence"
```

---
---

### Task 9: Validation read, re-run and waiver routes, plus the H3 projection fix

**Files:**
- Modify: `src/api/documents.ts` (three new routes, the two field-list imports, the `/:id` and `/:id/invoice` and `/:id/contract` responses)
- Create: `tests/api/document-validation.test.ts`

**Interfaces:**
- Consumes: `listViolations`, `waiveViolation`, `replaceValidation` from Task 7; `evaluate`, `buildBundle`, `localDay`, `RULESET_VERSION` from Task 3; `INVOICE_FIELDS`, `CONTRACT_FIELDS` from Task 8; `getInvoice`, `getContract`, `getDocument` from `src/db/documents.ts`.
- Produces: `GET /api/documents/:id/validation`, `POST /api/documents/:id/validation`, `POST /api/documents/:id/validation/:violationId/waive`. Task 10 reuses the `runValidationForDocument` helper this task extracts.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/document-validation.test.ts` using `createTestServer` from `tests/helpers/test-server.ts`, which already wires the real router to the real database. Seed through `server.db` the way `tests/api/document-correction.test.ts` does.

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../../helpers/test-server.js'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
  'content-type': 'application/json',
}

let server: TestServer
let documentId: string

beforeAll(async () => {
  server = await createTestServer()
  documentId = await seedInvoice(server.db, {
    subtotal: '1000.00', tax: '100.00', total: '1200.00', currency: 'AUD',
  })
})

async function get(path: string) {
  return server.fetch('/api/documents' + path, { headers: HEADERS })
}
async function post(path: string, body?: unknown) {
  return server.fetch('/api/documents' + path, {
    method: 'POST', headers: HEADERS, body: body === undefined ? '{}' : JSON.stringify(body),
  })
}

describe('GET /:id/validation', () => {
  it('refuses a non-uuid id with 400', async () => {
    expect((await get('/nope/validation')).status).toBe(400)
  })
  it('404s a document that is not this tenant', async () => {
    const res = await server.fetch('/api/documents/' + documentId + '/validation', {
      headers: { ...HEADERS, 'x-tenant-id': '00000000-0000-4000-8000-000000000077' },
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/validation', () => {
  it('runs the engine and stores what it finds', async () => {
    const res = await post('/' + documentId + '/validation')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rulesetVersion).toBe('v1')
    expect(body.violations.map((v: { ruleId: string }) => v.ruleId)).toContain('invoice.total.sum')
    expect((await get('/' + documentId + '/validation')).ok).toBe(true)
  })
  it('a second run does not double the rows', async () => {
    await post('/' + documentId + '/validation')
    const before = (await (await get('/' + documentId + '/validation')).json()).violations.length
    await post('/' + documentId + '/validation')
    expect((await (await get('/' + documentId + '/validation')).json()).violations.length).toBe(before)
  })
})

describe('POST /:id/validation/:violationId/waive', () => {
  it('requires a reason of at least eight characters', async () => {
    const [row] = (await (await get('/' + documentId + '/validation')).json()).violations
    expect((await post('/' + documentId + '/validation/' + row.id + '/waive', { reason: 'oops' })).status).toBe(400)
    expect((await post('/' + documentId + '/validation/' + row.id + '/waive', {})).status).toBe(400)
  })
  it('waives, then 409s a second attempt', async () => {
    const [row] = (await (await get('/' + documentId + '/validation')).json()).violations
    const ok = await post('/' + documentId + '/validation/' + row.id + '/waive', {
      reason: 'credit note nets this invoice off',
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).violation.status).toBe('waived')
    expect((await post('/' + documentId + '/validation/' + row.id + '/waive', {
      reason: 'trying to waive it a second time',
    })).status).toBe(409)
  })
  it('404s a violation belonging to another tenant', async () => {
    const res = await server.fetch(
      '/api/documents/' + documentId + '/validation/00000000-0000-4000-8000-000000000000/waive',
      { method: 'POST', headers: HEADERS, body: JSON.stringify({ reason: 'a long enough reason' }) },
    )
    expect(res.status).toBe(404)
  })
})

describe('H3, the detail responses stop leaking internal join columns', () => {
  it('never returns invoice_field_confidence or contract_field_confidence', async () => {
    for (const path of ['/' + documentId, '/' + documentId + '/invoice']) {
      const text = await (await get(path)).text()
      expect(text).not.toMatch(/invoice_field_confidence|contract_field_confidence/)
    }
  })
})
```

Run: `npx vitest run tests/api/document-validation.test.ts`
Expected: FAIL, the routes do not exist and the leak is present.

- [ ] **Step 2: Extract the shared evaluation**

Above the router factory in `src/api/documents.ts`:

```ts
async function runValidationForDocument(
  identity: TenantRequestContext,
  documentId: string,
): Promise<{ openErrors: number; openWarnings: number; violations: StoredViolation[] } | null> {
  const document = await getDocument(identity, documentId)
  if (!document || (document.kind !== 'invoice' && document.kind !== 'contract')) return null
  const bundle = document.kind === 'invoice'
    ? toInvoiceBundle(await getInvoice(identity, documentId))
    : toContractBundle(await getContract(identity, documentId))
  const violations = evaluate(bundle, { today: localDay(new Date()) }).filter((v) => isCorrectable(v.field))
  const counts = await replaceValidation(
    getDbClient(), documentId, identity.tenantId, violations, RULESET_VERSION,
  )
  return { ...counts, violations: await listViolations(documentId, identity.tenantId) }
}
```

`toInvoiceBundle` and `toContractBundle` turn the `{ header, lines }` and `{ header, terms }` pairs
`getInvoice` and `getContract` already return into a `DocumentRecordBundle` via `buildBundle`. They are
local to this module and take `null` headers, because a document with no header row must still evaluate
and produce the presence findings.

- [ ] **Step 3: The three routes**

```ts
app.get('/:id/validation', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const id = IdSchema.safeParse(c.req.param('id'))
  if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
  const violations = await listViolations(id.data, gate.identity.tenantId)
  const document = await getDocument(gate.identity, id.data)
  if (!document) return c.json({ error: 'not_found' }, 404)
  return c.json({
    documentId: id.data,
    rulesetVersion: violations[0]?.rulesetVersion ?? RULESET_VERSION,
    violations,
  })
})

app.post('/:id/validation', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const id = IdSchema.safeParse(c.req.param('id'))
  if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
  const result = await runValidationForDocument(gate.identity, id.data)
  if (result === null) return c.json({ error: 'not_found' }, 404)
  return c.json({
    documentId: id.data,
    rulesetVersion: RULESET_VERSION,
    violations: result.violations,
    openErrors: result.openErrors,
    openWarnings: result.openWarnings,
  })
})

app.post('/:id/validation/:violationId/waive', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const id = IdSchema.safeParse(c.req.param('id'))
  const violationId = IdSchema.safeParse(c.req.param('violationId'))
  if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
  if (!violationId.success) return c.json({ error: 'violationId must be a uuid' }, 400)
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}))
  const reason = (body.reason ?? '').trim()
  if (reason.length < 8) {
    return c.json({ error: 'reason_required', min_length: 8 }, 400)
  }
  const outcome = await waiveViolation(violationId.data, gate.identity.tenantId, gate.identity.userId, reason)
  if (!outcome.ok) {
    return c.json({ error: outcome.reason }, outcome.reason === 'not_found' ? 404 : 409)
  }
  const remaining = await runValidationForDocument(gate.identity, id.data)
  return c.json({ violation: outcome.violation, openErrors: remaining?.openErrors ?? 0 })
})
```

The waive route re-runs validation last so the response carries the count the queue will show next. That
re-run does not reopen the row it just waived, which `replaceValidation` guarantees and Task 7 tests.

- [ ] **Step 4: Delete the duplicated field lists and fix the projections**

Replace the two local `ALLOWED_INVOICE_FIELDS` and `ALLOWED_CONTRACT_FIELDS` at
`src/api/documents.ts:359-360` with imports of `INVOICE_FIELDS` and `CONTRACT_FIELDS` from
`src/validation/fields`. Then project the detail responses explicitly so the join columns stop leaking:

```ts
const { invoice_field_confidence: _ifc, ...invoiceHeader } = header
return c.json({ document, invoice: invoiceHeader, lines })
```

Do the same with `contract_field_confidence` in `/:id/contract`. In `GET /:id`, the internal column
arrives through `getDocument`, so keep `fieldConfidence` as the single camelCase key in the response and
drop `field_confidence` from the serialised document.

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run tests/api/document-validation.test.ts tests/api/document-audit.test.ts tests/api/document-correction.test.ts tests/api/documents.test.ts`
Expected: all PASS. `documents.test.ts` is the one that can catch the projection change, so read any failure there as a contract change rather than rewriting the assertion first.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/api/documents.ts tests/api/document-validation.test.ts
git commit -m "feat(api): read, re-run and waive a validation finding, and stop leaking join columns"
```

---

### Task 10: A correction re-validates, and the reason lands on the right row (H2)

**Files:**
- Modify: `src/api/documents.ts` (`handleCorrection`)
- Create: `tests/integration/correction-revalidates.test.ts`
- Modify: `tests/api/document-correction.test.ts`

**Interfaces:**
- Consumes: `runValidationForDocument` from Task 9, `setAuditContext` from Task 2, the dedicated `PoolClient` `handleCorrection` already opens.
- Produces: a `PATCH` response body of `{ success: true, openErrors, openWarnings, violations }`. The console in Task 14 repaints from that body without a second request.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/correction-revalidates.test.ts`. It is integration because it needs the trigger, the pool and the validation write in one flow. Copy the `.env` header from `tests/db/field-audit.test.ts:1-12` and use `createTestServer`.

```ts
it('clears the sum finding when the total is corrected, in the same response', async () => {
  const server = await createTestServer()
  const doc = await seedInvoice(server.db, { subtotal: '1000.00', tax: '100.00', total: '1200.00' })

  const first = await server.fetch('/api/documents/' + doc + '/validation', {
    method: 'POST', headers: HEADERS, body: '{}',
  })
  expect((await first.json()).violations.map((v: { ruleId: string }) => v.ruleId))
    .toContain('invoice.total.sum')

  const res = await server.fetch('/api/documents/' + doc + '/invoices/total', {
    method: 'PATCH', headers: HEADERS,
    body: JSON.stringify({ value: '1100.00', reason: 'the footer of the page carried the right total' }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.openErrors).toBe(0)
  expect(body.violations.map((v: { ruleId: string }) => v.ruleId)).not.toContain('invoice.total.sum')
})

it('keeps the finding open when the correction does not fix it', async () => {
  const server = await createTestServer()
  const doc = await seedInvoice(server.db, { subtotal: '1000.00', tax: '100.00', total: '1200.00' })
  const res = await server.fetch('/api/documents/' + doc + '/invoices/total', {
    method: 'PATCH', headers: HEADERS, body: JSON.stringify({ value: '1300.00' }),
  })
  expect((await res.json()).openErrors).toBeGreaterThan(0)
})

it('attributes both corrections on one pooled connection to their own actor', async () => {
  const server = await createTestServer()
  const docA = await seedInvoice(server.db, { total: '10.00' })
  const docB = await seedInvoice(server.db, { total: '20.00' })
  for (const [doc, value] of [[docA, '11.00'], [docB, '22.00']] as const) {
    await server.fetch('/api/documents/' + doc + '/invoices/total', {
      method: 'PATCH', headers: HEADERS, body: JSON.stringify({ value }),
    })
  }
  for (const doc of [docA, docB]) {
    const rows = await server.db.query<{ changed_by: string }>(
      `SELECT changed_by FROM document_field_audit
       WHERE document_id = $1 AND tenant_id = $2 AND action = 'update' AND field_name = 'total'`,
      [doc, TENANT],
    )
    expect(rows.rows.every((r) => r.changed_by === USER)).toBe(true)
  }
})
```

Run: `npx vitest run tests/integration/correction-revalidates.test.ts`
Expected: FAIL, the `PATCH` body carries no `openErrors`.

- [ ] **Step 2: Fix the reason stamp (H2) and re-validate (spec section 8.3)**

The Phase 1 stamp matched `changed_at = MAX(changed_at)` for the field, so two corrections landing in the
same instant stamp the same row. A per-request watermark cannot collide, because the trigger's `now()` is
the transaction start time and the pre-update maximum is read before this transaction has written
anything. In `handleCorrection`, replace the body between `BEGIN` and `COMMIT` with:

```ts
await client.query('BEGIN')
await setAuditContext(client, { userId: identity.userId, changeSource: 'manual_correction' })

const watermark = await client.query<{ at: string | null }>(
  `SELECT MAX(changed_at) AS at FROM document_field_audit
   WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3`,
  [docId, identity.tenantId, field],
)

await client.query(
  `UPDATE ${tableName} SET ${field} = $1 WHERE document_id = $2`,
  [body.value, docId],
)

if (body.reason) {
  const stamped = await client.query<{ id: string }>(
    watermark.rows[0]?.at === null
      ? `SELECT id FROM document_field_audit WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3`
      : `SELECT id FROM document_field_audit
         WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3 AND changed_at > $4`,
    watermark.rows[0]?.at === null
      ? [docId, identity.tenantId, field]
      : [docId, identity.tenantId, field, watermark.rows[0].at],
  )
  await client.query(
    `UPDATE document_field_audit SET reason = $1 WHERE id = ANY($2::uuid[])`,
    [body.reason, stamped.rows.map((r) => r.id)],
  )
}

const revalidated = await runValidationForDocumentOn(client, identity, docId)
await client.query('COMMIT')
return c.json({
  success: true,
  openErrors: revalidated.openErrors,
  openWarnings: revalidated.openWarnings,
  violations: revalidated.violations,
})
```

`tableName` and `field` stay interpolated exactly as Phase 1 has them, because both are already constrained:
`tableName` is one of two literals from the route registration and `field` is checked against the imported
whitelist before this point. Do not weaken either guard while editing this function.

`runValidationForDocumentOn(client, ...)` is Task 9's helper generalised to accept a connection, so the
correction, the stamp and the finding refresh commit or roll back as one unit. Add it beside the existing
helper by giving `runValidationForDocument` an optional last parameter `client: Q = getDbClient()`, and
export both names.

- [ ] **Step 3: Read the transaction isolation consequence**

`setAuditContext` is now transaction-local, so the reads inside `runValidationForDocumentOn` see the
uncommitted update on the same connection, and the fresh finding set reflects the corrected value before
`COMMIT` ever runs. Assert that explicitly in the test from Step 1 by reading `document_validation` on a
different connection after the response and confirming the same rows. If a finding survives that should
have cleared, the helper is reading a second pooled connection; fix it by passing `client` through.

- [ ] **Step 4: Update the correction unit tests**

In `tests/api/document-correction.test.ts`, the assertions on the response body now expect
`{ success: true, openErrors, openWarnings, violations }`. Add one case proving a reason is stored on the
row this request wrote and not on an older row for the same field:

```ts
it('stamps the reason on this correction, not on an earlier one for the same field', async () => {
  await patch(doc, 'total', '11.00', 'first reason that is long enough')
  await patch(doc, 'total', '12.00', 'second reason that is long enough')
  const rows = await server.db.query<{ reason: string; new_value: unknown }>(
    `SELECT reason, new_value FROM document_field_audit
     WHERE document_id = $1 AND field_name = 'total' AND action = 'update' ORDER BY changed_at`,
    [doc],
  )
  expect(rows.rows.map((r) => r.reason)).toEqual([
    'first reason that is long enough',
    'second reason that is long enough',
  ])
})
```

- [ ] **Step 5: Run the four affected suites**

Run: `npx vitest run --project integration tests/integration/correction-revalidates.test.ts && npx vitest run tests/api/document-correction.test.ts tests/api/document-validation.test.ts tests/db/audit-context-isolation.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/api/documents.ts tests/integration/correction-revalidates.test.ts tests/api/document-correction.test.ts
git commit -m "feat(api): a correction re-validates in its own transaction and stamps its own audit row"
```

---
### Task 11: The review queue route

**Files:**
- Modify: `src/db/validation.ts` (add `reviewQueue` and its row types)
- Modify: `src/api/documents.ts` (one new route, registered before the `/:id` handler)
- Create: `tests/api/review-queue.test.ts`

**Interfaces:**
- Consumes: `document_validation` from Task 6, `documents.field_confidence` from Phase 1, `CONFIDENCE_THRESHOLD` exported at `src/mastra/workflows/document-intake.ts:30`. Measured at dispatch: `src/api/documents.ts` does NOT already import it, contrary to an earlier revision of this line; line 22 of that file already imports `MAX_DOCUMENT_BYTES` from the same module, so extend that statement rather than opening a new edge.
- Produces: `GET /api/documents/review-queue`. Task 15 consumes `{ items, total }`.

```ts
export interface ReviewQueueItem {
  documentId: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: number | null
  lowestFieldConfidence: number | null
  openErrors: number
  openWarnings: number
  reasons: string[]
  createdAt: string
}
export interface ReviewQueueFilter {
  kind: 'invoice' | 'contract' | null
  severity: 'error' | 'warning' | null
  limit: number
  offset: number
}
export function reviewQueue(
  tenantId: string,
  filter: ReviewQueueFilter,
): Promise<{ items: ReviewQueueItem[]; total: number }>
```

A document is queued when its status is `needs_review` or it has at least one open finding. The `OR` matters: Task 10 lets a correction clear a finding while the document stays `ready`, and Task 8 can be bypassed by a back-dated row, so status alone is not the queue.

Order is `openErrors DESC, lowestFieldConfidence ASC NULLS LAST, created_at ASC` exactly as spec 9.1 rules it. `reasons` is built in TypeScript, in this fixed order, from literals the panel prints verbatim: `'needs review'`, `'open error'`, `'open warning'`, `'low confidence'`.

Ruling R11. `limit` is clamped to `[1, 200]`, not rejected. Why: a client asking for 500 items is asking for less precision, not breaking a contract, and a 400 there would make the panel's "load more" a crash. Cost if wrong: a caller silently receives fewer rows than requested, which the response admits by echoing the effective `limit` and `offset`.

Ruling R12. `lowestFieldConfidence` is computed in the queue SQL over `documents.field_confidence` only. The per-table confidence columns (`invoices.field_confidence` and friends) are not folded in. Why: `documents.field_confidence` is the one the intake step writes for every required field (spec E6), and a `min` over five tables would need five joins for a sort key. Cost if wrong: a line-level low confidence does not by itself pull a document up the queue.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/review-queue.test.ts` with `createTestServer` and the `.env` header from `tests/helpers/test-server.ts:1-12`. Copy `seedInvoice` from `tests/api/document-validation.test.ts` (Task 9) and add these two helpers under it:

```ts
async function setStatus(docId: string, status: string) {
  await server.db.query('UPDATE documents SET status = $1 WHERE id = $2', [status, docId])
}

async function setConfidence(docId: string, map: Record<string, number>) {
  await server.db.query('UPDATE documents SET field_confidence = $2::jsonb WHERE id = $1', [docId, JSON.stringify(map)])
}

async function setCreated(docId: string, at: string) {
  await server.db.query('UPDATE documents SET created_at = $2::timestamptz WHERE id = $1', [docId, at])
}

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning') {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by review-queue test')
     RETURNING id`,
    [docId, TENANT, severity, ruleId, field],
  )
  return r.rows[0].id
}
```

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../../helpers/test-server.js'

const TENANT = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000009'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

let server: TestServer

async function queue(query = '') {
  return (await server.fetch('/api/documents/review-queue' + query, { headers: HEADERS })) as Response
}
async function body(query = '') {
  const res = await queue(query)
  return { status: res.status, json: (await res.json()) as Record<string, never> }
}

beforeAll(async () => {
  server = await createTestServer()
})

describe('GET /review-queue auth and filters', () => {
  it('refuses a request with no identity headers', async () => {
    expect((await server.fetch('/api/documents/review-queue')).status).toBe(401)
  })
  it('400s an unknown kind', async () => {
    expect((await body('?kind=receipt')).json.error).toBe('bad_filter')
  })
  it('400s an unknown severity', async () => {
    expect((await body('?severity=critical')).json.error).toBe('bad_filter')
  })
  it('400s a non-numeric limit', async () => {
    const res = await body('?limit=abc')
    expect(res.json.error).toBe('bad_filter')
    expect(res.status).toBe(400)
  })
})

describe('GET /review-queue membership', () => {
  beforeEach(async () => {
    await server.db.query('DELETE FROM document_validation WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
    await server.db.query('DELETE FROM documents WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  })

  it('routes /review-queue to the queue, not to the :id handler', async () => {
    const res = await queue()
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('items')
  })

  it('queues a needs_review document with no findings', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    const { json } = await body()
    expect(json.total).toBe(1)
    expect(json.items[0].reasons).toEqual(['needs review'])
  })

  it('queues a ready document that carries one open finding', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'ready')
    await addFinding(doc, 'invoice.total.sum', 'total', 'error')
    const { json } = await body()
    expect(json.items).toHaveLength(1)
    expect(json.items[0].openErrors).toBe(1)
    expect(json.items[0].reasons).toEqual(['open error'])
  })

  it('does not queue a ready document whose only finding is waived', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'ready')
    await addFinding(doc, 'invoice.total.sum', 'total', 'error')
    await server.db.query("UPDATE document_validation SET status = 'waived' WHERE document_id = $1", [doc])
    expect((await body()).json.total).toBe(0)
  })

  it('never shows another tenant document', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await server.db.query('UPDATE documents SET tenant_id = $2 WHERE id = $1', [doc, OTHER])
    await setStatus(doc, 'needs_review')
    expect((await body()).json.total).toBe(0)
  })

  it('excludes a document of kind other', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await server.db.query("UPDATE documents SET kind = 'other', status = 'needs_review' WHERE id = $1", [doc])
    expect((await body()).json.total).toBe(0)
  })
})

describe('GET /review-queue ordering', () => {
  beforeEach(async () => {
    await server.db.query('DELETE FROM document_validation WHERE tenant_id = $1', [TENANT])
    await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
  })

  it('puts more open errors first', async () => {
    const two = await seedInvoice(server.db, { total: '10.00' })
    const one = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(two, 'ready')
    await setStatus(one, 'ready')
    await addFinding(two, 'invoice.total.sum', 'total', 'error')
    await addFinding(two, 'invoice.vendor_name.present', 'vendor_name', 'error')
    await addFinding(one, 'invoice.total.sum', 'total', 'error')
    const { json } = await body()
    expect(json.items.map((i: { documentId: string }) => i.documentId)).toEqual([two, one])
  })

  it('prefers an error document over a warning-only document regardless of confidence', async () => {
    const warnLow = await seedInvoice(server.db, { total: '10.00' })
    const errHigh = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(warnLow, 'ready')
    await setStatus(errHigh, 'ready')
    await addFinding(warnLow, 'invoice.currency.shape', 'currency', 'warning')
    await addFinding(errHigh, 'invoice.total.sum', 'total', 'error')
    await setConfidence(warnLow, { vendorName: 0.05 })
    await setConfidence(errHigh, { vendorName: 0.99 })
    const { json } = await body()
    expect(json.items[0].documentId).toBe(errHigh)
  })

  it('sorts equal error counts by lowest field confidence, nulls last', async () => {
    const noMap = await seedInvoice(server.db, { total: '10.00' })
    const low = await seedInvoice(server.db, { total: '20.00' })
    const high = await seedInvoice(server.db, { total: '30.00' })
    for (const d of [noMap, low, high]) await setStatus(d, 'ready')
    for (const d of [noMap, low, high]) await addFinding(d, 'invoice.total.sum', 'total', 'error')
    await setConfidence(low, { vendorName: 0.1, total: 0.4 })
    await setConfidence(high, { vendorName: 0.95 })
    const { json } = await body()
    const ids = json.items.map((i: { documentId: string }) => i.documentId)
    expect(ids).toEqual([low, high, noMap])
    expect(json.items[0].lowestFieldConfidence).toBe(0.1)
    expect(json.items[2].lowestFieldConfidence).toBeNull()
  })

  it('sorts oldest first inside a tier', async () => {
    const older = await seedInvoice(server.db, { total: '10.00' })
    const newer = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(older, 'needs_review')
    await setStatus(newer, 'needs_review')
    await setCreated(older, '2026-08-01T00:00:00Z')
    const { json } = await body()
    expect(json.items.map((i: { documentId: string }) => i.documentId)).toEqual([older, newer])
  })

  it('reports low confidence in reasons only below the intake threshold', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    await setConfidence(doc, { vendorName: 0.699 })
    expect((await body()).json.items[0].reasons).toContain('low confidence')
    await setConfidence(doc, { vendorName: 0.7 })
    expect((await body()).json.items[0].reasons).not.toContain('low confidence')
  })
})

describe('GET /review-queue paging', () => {
  beforeEach(async () => {
    await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
  })

  it('defaults to 50 and clamps a request above 200', async () => {
    expect((await body()).json.limit).toBe(50)
    expect((await body('?limit=500')).json.limit).toBe(200)
    expect((await body('?limit=0')).json.error).toBe('bad_filter')
  })

  it('pages without dropping items', async () => {
    for (let i = 0; i < 5; i++) {
      const doc = await seedInvoice(server.db, { total: String(i) + '.00' })
      await setStatus(doc, 'needs_review')
    }
    const all = await body()
    const page1 = await body('?limit=2&offset=0')
    const page2 = await body('?limit=2&offset=2')
    const page3 = await body('?limit=2&offset=4')
    expect(all.json.total).toBe(5)
    expect(page1.json.total).toBe(5)
    const seen = [...page1.json.items, ...page2.json.items, ...page3.json.items]
      .map((i: { documentId: string }) => i.documentId)
    expect(new Set(seen).size).toBe(5)
  })

  it('filters by severity and by kind', async () => {
    const inv = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(inv, 'invoice.total.sum', 'total', 'warning')
    const con = await seedInvoice(server.db, { total: '20.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addFinding(con, 'contract.value.present', 'contract_value', 'error')
    expect((await body('?severity=error')).json.total).toBe(1)
    expect((await body('?severity=warning')).json.total).toBe(1)
    expect((await body('?kind=contract')).json.total).toBe(1)
    expect((await body('?kind=contract&severity=warning')).json.total).toBe(0)
  })
})
```

Run: `npx vitest run tests/api/review-queue.test.ts`
Expected: FAIL. The routing case answers 400 with `{ error: 'bad_uuid' }` because `/:id` swallows the segment, and every other case fails on the missing table or the missing route.

- [ ] **Step 2: Add the queue read to `src/db/validation.ts`**

Append to the file. `::int` and `::float8` casts on every aggregate and numeric are deliberate: `count()` is `bigint` and `pg` returns `bigint` as a string, which Global Constraint 5 says never to hand across the boundary as a string.

```ts
export interface ReviewQueueRow {
  document_id: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: string | null
  lowest_field_confidence: string | null
  open_errors: number
  open_warnings: number
  created_at: string
}

const QUEUE_FROM = `
  FROM documents d
  LEFT JOIN (
    SELECT document_id,
           COUNT(*) FILTER (WHERE severity = 'error')   AS errors,
           COUNT(*) FILTER (WHERE severity = 'warning') AS warnings
    FROM document_validation
    WHERE tenant_id = $1 AND status = 'open'
    GROUP BY document_id
  ) c ON c.document_id = d.id
  LEFT JOIN (
    SELECT d2.id AS document_id,
           (SELECT MIN(NULLIF(kv.value, 'null'::jsonb)::numeric)
              FROM jsonb_each(d2.field_confidence) AS kv(key, value)) AS lowest
    FROM documents d2
    WHERE d2.tenant_id = $1 AND d2.kind IN ('invoice', 'contract')
  ) f ON f.document_id = d.id
  WHERE d.tenant_id = $1
    AND d.kind IN ('invoice', 'contract')
    AND ($2::text IS NULL OR d.kind = $2)
    AND (d.status = 'needs_review' OR COALESCE(c.errors, 0) + COALESCE(c.warnings, 0) > 0)
    AND ($3::text IS NULL OR EXISTS (
      SELECT 1 FROM document_validation s
      WHERE s.document_id = d.id AND s.tenant_id = $1
        AND s.status = 'open' AND s.severity = $3
    ))
`

export async function reviewQueue(
  tenantId: string,
  filter: ReviewQueueFilter,
): Promise<{ items: ReviewQueueItem[]; total: number }> {
  const client = getDbClient()
  const params = [tenantId, filter.kind, filter.severity]

  const countResult = await client.query<{ total: number }>(
    'SELECT COUNT(*)::int AS total' + QUEUE_FROM,
    params,
  )
  const pageResult = await client.query<ReviewQueueRow>(
    `SELECT d.id AS document_id, d.title, d.kind, d.status, d.confidence,
            d.created_at::text AS created_at, f.lowest AS lowest_field_confidence,
            COALESCE(c.errors, 0)::int   AS open_errors,
            COALESCE(c.warnings, 0)::int AS open_warnings` +
      QUEUE_FROM +
      ` ORDER BY COALESCE(c.errors, 0) DESC, f.lowest ASC NULLS LAST, d.created_at ASC
         LIMIT $4 OFFSET $5`,
    [...params, filter.limit, filter.offset],
  )

  return { items: pageResult.rows.map(toQueueItem), total: countResult.rows[0].total }
}

function toQueueItem(row: ReviewQueueRow): ReviewQueueItem {
  const lowest = row.lowest_field_confidence === null ? null : Number(row.lowest_field_confidence)
  const reasons: string[] = []
  if (row.status === 'needs_review') reasons.push('needs review')
  if (row.open_errors > 0) reasons.push('open error')
  if (row.open_warnings > 0) reasons.push('open warning')
  if (lowest !== null && lowest < CONFIDENCE_THRESHOLD) reasons.push('low confidence')
  return {
    documentId: row.document_id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    lowestFieldConfidence: lowest,
    openErrors: row.open_errors,
    openWarnings: row.open_warnings,
    reasons,
    createdAt: row.created_at,
  }
}
```

`NULLIF(kv.value, 'null'::jsonb)` is not decoration: a `field_confidence` written as `{"vendorName": null}` would otherwise reach `NULL::jsonb::numeric` and the `MIN` would silently ignore it, but a `jsonb` string value would raise. The JSONB this column holds is written by `normalizeAndResolveStep` as numbers only, so the null guard is the whole requirement.

**Corrected at ruling R57: do NOT import `CONFIDENCE_THRESHOLD` into `src/db/validation.ts`.** Measured: `src/mastra/workflows/document-intake.ts:21` already imports `replaceValidation` from `../../db/validation` (Task 8 put it there), so the reverse import is a genuine module cycle, and `document-intake.ts` pulls `@mastra/core`, `unpdf`, `mammoth`, the extractor agent, docling and OCR into whatever imports it — a heavy graph for a storage module to carry. `CONFIDENCE_THRESHOLD` is exported at `src/mastra/workflows/document-intake.ts:30`, and `src/api/documents.ts:22` already imports `MAX_DOCUMENT_BYTES` from that same module, so extend THAT statement and move `toQueueItem` into the route handler. The db module returns rows; the route maps them. The ordering and membership SQL do not change, and this is the fallback this line itself offered, now made mandatory.

- [ ] **Step 3: Register the route ahead of `/:id`**

In `src/api/documents.ts`, insert the handler immediately before the `app.get('/:id', ...)` — measured at dispatch: that handler is at line 305 of the current file, not :253 — and not after it. Hono's `SmartRouter` prefers a static segment over a named one, but relying on that for a single-segment path that competes with `/:id` is not worth a debugging session; registration order makes it unambiguous.

```ts
function intQuery(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

app.get('/review-queue', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const { tenantId } = gate.identity

  const kind = c.req.query('kind')
  if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
    return c.json({ error: 'bad_filter', param: 'kind' }, 400)
  }
  const severity = c.req.query('severity')
  if (severity !== undefined && severity !== 'error' && severity !== 'warning') {
    return c.json({ error: 'bad_filter', param: 'severity' }, 400)
  }

  const rawLimit = intQuery(c.req.query('limit'), 50)
  const rawOffset = intQuery(c.req.query('offset'), 0)
  if (rawLimit === null || rawOffset === null) {
    return c.json({ error: 'bad_filter', param: rawLimit === null ? 'limit' : 'offset' }, 400)
  }
  const limit = Math.min(200, Math.max(1, rawLimit))
  const offset = Math.max(0, rawOffset)

  const { items, total } = await reviewQueue(tenantId, {
    kind: (kind as 'invoice' | 'contract' | undefined) ?? null,
    severity: (severity as 'error' | 'warning' | undefined) ?? null,
    limit,
    offset,
  })
  return c.json({ items, total, limit, offset })
})
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/api/review-queue.test.ts`
Expected: PASS. If the routing case is the only one still failing, the handler was registered after `/:id`.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/db/validation.ts src/api/documents.ts tests/api/review-queue.test.ts
git commit -m "feat(api): a prioritised review queue ordered by open errors then lowest confidence"
```

---

### Task 12: The analytics route

**Files:**
- Modify: `src/db/validation.ts` (add `reviewAnalytics`)
- Modify: `src/api/documents.ts` (one new route plus the shared window parser)
- Create: `tests/api/analytics.test.ts`

**Interfaces:**
- Consumes: `document_validation` (Task 6), `document_field_audit` (Phase 1), `documents`, `parseDate` from `src/validation/values.js`, `localDay` from `src/validation/index.js`.
- Produces: `GET /api/documents/analytics/review` with the six spec-11 keys plus a `window` object the panel labels itself with. Task 16 consumes it.

```ts
export interface AnalyticsWindow {
  from: Date
  toExclusive: Date
  fromLabel: string
  toLabel: string
  days: number
}
export interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
}
export function reviewAnalytics(
  tenantId: string,
  window: AnalyticsWindow,
  kind: 'invoice' | 'contract' | null,
): Promise<ReviewAnalytics>
```

Ruling R13, carried from R8. `turnaround` is measured from `documents.created_at`, so it contains queue wait. The panel labels the row "created to first correction" rather than "review time", because the label is the only place a reader meets that number.

Ruling R14. The top-level `correctionRate` follows spec 11 literally: its numerator counts corrections in the window on documents of any age, its denominator counts documents created in the window. It can exceed 1 when a window reviews older work. The response therefore carries the two integers beside the rate, and the panel prints "12 of 9 corrected" before it prints a percentage. Silently redefining the metric to stay inside `[0, 1]` would break the comparison against the CSV export, which counts the same rows.

Ruling R15. `confidenceTrend[].correctionRate` is a different number from the top-level one on purpose: it is the share of documents *created* in that ISO week that ever received a correction, ignoring the window. Why: the top-level metric compares two populations and is not attributable to a week, and a per-week version of it would put a correction in a week its document was not created in. The panel titles the column "corrected (lifetime)".

- [ ] **Step 1: Write the failing tests**

Create `tests/api/analytics.test.ts` with the same `createTestServer` header, `seedInvoice`, `addFinding` and `setConfidence` helpers as Task 11, plus:

```ts
async function addAudit(docId: string, field: string, source: string, at: string, by = USER) {
  await server.db.query(
    `INSERT INTO document_field_audit
       (document_id, tenant_id, table_name, field_name, action, new_value, changed_by, changed_at, change_source)
     VALUES ($1, $2, 'invoices', $3, 'update', $4::jsonb, $5, $6::timestamptz, $7)`,
    [docId, TENANT, field, JSON.stringify('x'), by, at, source],
  )
}
async function setCreated(docId: string, at: string) {
  await server.db.query('UPDATE documents SET created_at = $2::timestamptz WHERE id = $1', [docId, at])
}
function hoursAfter(hours: number): string {
  return new Date(Date.UTC(2026, 8, 20, hours)).toISOString()
}
async function wipe() {
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM document_validation WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
}
async function analytics(query = '') {
  const res = await server.fetch('/api/documents/analytics/review' + query, { headers: HEADERS })
  return { status: res.status, json: (await res.json()) as Record<string, never> }
}
```

```ts
describe('GET /analytics/review window handling', () => {
  it('refuses a malformed from', async () => {
    expect((await analytics('?from=31-12-2026')).json.error).toBe('bad_range')
  })
  it('refuses from after to', async () => {
    const res = await analytics('?from=2026-06-01&to=2026-05-01')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_range')
  })
  it('refuses a window longer than 365 days', async () => {
    expect((await analytics('?from=2025-01-01&to=2026-12-31')).json.error).toBe('bad_range')
  })
  it('defaults to the last 90 days and labels the window it used', async () => {
    const { json } = await analytics()
    expect(json.window.days).toBe(90)
    expect(String(json.window.to)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('GET /analytics/review metrics', () => {
  beforeEach(wipe)

  it('returns every key empty and a null rate when there is no data', async () => {
    const { json } = await analytics()
    expect(json.byRule).toEqual([])
    expect(json.topFields).toEqual([])
    expect(json.bySource).toEqual([])
    expect(json.confidenceTrend).toEqual([])
    expect(json.correctionRate).toEqual({ corrected: 0, documents: 0, rate: null })
    expect(json.turnaround).toEqual({ p50Hours: null, p90Hours: null })
  })

  it('groups findings by rule with open and waived split', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    const b = await seedInvoice(server.db, { total: '20.00' })
    const id1 = await addFinding(a, 'invoice.total.sum', 'total', 'error')
    await addFinding(b, 'invoice.total.sum', 'total', 'error')
    await addFinding(a, 'invoice.currency.shape', 'currency', 'warning')
    await server.db.query("UPDATE document_validation SET status='waived' WHERE id = $1", [id1])
    const { json } = await analytics()
    const sum = json.byRule.find((r: { ruleId: string }) => r.ruleId === 'invoice.total.sum')
    expect(sum).toEqual({ ruleId: 'invoice.total.sum', total: 2, open: 1, waived: 1 })
    expect(json.byRule[0].total).toBeGreaterThanOrEqual(json.byRule[json.byRule.length - 1].total)
  })

  it('excludes a finding created outside the window', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    await server.db.query("UPDATE document_validation SET created_at = '2020-01-01T00:00:00Z'::timestamptz")
    expect((await analytics()).json.byRule).toEqual([])
  })

  it('ranks topFields by corrections and pairs the violation count', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(a, 'vendor_name', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(a, 'currency', 'extraction', '2026-10-02T00:00:00Z')
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    const { json } = await analytics()
    expect(json.topFields).toEqual([
      { field: 'total', corrections: 2, violations: 1 },
      { field: 'vendor_name', corrections: 1, violations: 0 },
    ])
  })

  it('counts audit rows by change source', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'tax', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'vendor_name', 'extraction', '2026-10-01T00:00:00Z')
    const { json } = await analytics()
    expect(json.bySource).toEqual([
      { changeSource: 'manual_correction', count: 2 },
      { changeSource: 'extraction', count: 1 },
    ])
  })

  it('computes correctionRate as corrected documents over documents created in the window', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    const b = await seedInvoice(server.db, { total: '20.00' })
    await seedInvoice(server.db, { total: '30.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'tax', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(b, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    const { json } = await analytics()
    expect(json.correctionRate).toEqual({ corrected: 2, documents: 3, rate: 2 / 3 })
  })

  it('reports turnaround as the median and p90 of creation to first correction, in hours', async () => {
    const hours = [1, 2, 3, 4, 10]
    for (const h of hours) {
      const d = await seedInvoice(server.db, { total: '10.00' })
      await setCreated(d, '2026-09-20T00:00:00Z')
      await addAudit(d, 'total', 'manual_correction', hoursAfter(h))
    }
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    expect(json.turnaround.p50Hours).toBeCloseTo(3, 6)
    expect(json.turnaround.p90Hours).toBeCloseTo(7.6, 6)
  })

  it('uses the first correction when a document has several', async () => {
    const d = await seedInvoice(server.db, { total: '10.00' })
    await setCreated(d, '2026-09-20T00:00:00Z')
    await addAudit(d, 'total', 'manual_correction', '2026-09-21T00:00:00Z')
    await addAudit(d, 'tax', 'manual_correction', '2026-09-25T00:00:00Z')
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    expect(json.turnaround.p50Hours).toBeCloseTo(24, 6)
  })

  it('groups confidence trend by ISO week with a Monday boundary', async () => {
    const mon = await seedInvoice(server.db, { total: '10.00' })
    const fri = await seedInvoice(server.db, { total: '20.00' })
    const other = await seedInvoice(server.db, { total: '30.00' })
    await setCreated(mon, '2026-09-21T00:00:00Z')
    await setCreated(fri, '2026-09-25T00:00:00Z')
    await setCreated(other, '2026-09-28T00:00:00Z')
    await server.db.query('UPDATE documents SET confidence = 0.8 WHERE id = ANY($1::uuid[])', [[mon, fri]])
    await server.db.query('UPDATE documents SET confidence = 0.4 WHERE id = $1', [other])
    await addAudit(mon, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    expect(json.confidenceTrend).toEqual([
      { week: '2026-09-21', avgConfidence: 0.8, correctionRate: 0.5 },
      { week: '2026-09-28', avgConfidence: 0.4, correctionRate: 0 },
    ])
  })

  it('filters every metric by kind', async () => {
    const inv = await seedInvoice(server.db, { total: '10.00' })
    const con = await seedInvoice(server.db, { total: '20.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addFinding(inv, 'invoice.total.sum', 'total', 'error')
    await addFinding(con, 'contract.value.present', 'contract_value', 'error')
    const invoice = (await analytics('?kind=invoice')).json
    expect(invoice.byRule).toHaveLength(1)
    expect(invoice.correctionRate.documents).toBe(1)
    expect((await analytics('?kind=contract')).json.byRule[0].ruleId).toBe('contract.value.present')
  })

  it('never sees another tenant', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    await server.db.query('UPDATE document_validation SET tenant_id = $2 WHERE document_id = $1', [a, OTHER])
    expect((await analytics()).json.byRule).toEqual([])
  })
})
```

Spec 13 files analytics under a DB test. It is written here as an API test against the real database instead, because `reviewAnalytics` has exactly one caller, the route, and the interesting assertion is the number the reviewer sees rather than the row shape underneath it. The queries still run against PostgreSQL, so nothing is mocked.

Run: `npx vitest run tests/api/analytics.test.ts`
Expected: FAIL, 404 from the missing route.

- [ ] **Step 2: Add the analytics read**

Append to `src/db/validation.ts`. One function, four queries, all sharing `$1` tenant, `$2` from, `$3` to-exclusive, `$4` kind.

```ts
export async function reviewAnalytics(
  tenantId: string,
  window: AnalyticsWindow,
  kind: 'invoice' | 'contract' | null,
): Promise<ReviewAnalytics> {
  const client = getDbClient()
  const p = [tenantId, window.from, window.toExclusive, kind]

  const [byRule, topFields, bySource, rate, turnaround, trend] = await Promise.all([
    client.query<{ rule_id: string; total: number; open: number; waived: number }>(
      `SELECT rule_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'open')::int   AS open,
              COUNT(*) FILTER (WHERE status = 'waived')::int AS waived
         FROM document_validation v
        WHERE v.tenant_id = $1
          AND v.created_at >= $2 AND v.created_at < $3
          AND ($4::text IS NULL OR EXISTS (
                SELECT 1 FROM documents kd WHERE kd.id = v.document_id AND kd.kind = $4))
        GROUP BY rule_id
        ORDER BY total DESC, rule_id`,
      p,
    ),
    client.query<{ field: string; corrections: number; violations: number }>(
      `WITH corr AS (
         SELECT a.field_name, COUNT(*)::int AS corrections
           FROM document_field_audit a
          WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
            AND a.changed_at >= $2 AND a.changed_at < $3
            AND ($4::text IS NULL OR EXISTS (
                  SELECT 1 FROM documents kd WHERE kd.id = a.document_id AND kd.kind = $4))
          GROUP BY a.field_name
       ), viol AS (
         SELECT v.field_name, COUNT(*)::int AS violations
           FROM document_validation v
          WHERE v.tenant_id = $1
            AND v.created_at >= $2 AND v.created_at < $3
            AND ($4::text IS NULL OR EXISTS (
                  SELECT 1 FROM documents kd WHERE kd.id = v.document_id AND kd.kind = $4))
          GROUP BY v.field_name
       )
       SELECT corr.field_name AS field, corr.corrections, COALESCE(viol.violations, 0) AS violations
         FROM corr LEFT JOIN viol USING (field_name)
        ORDER BY corr.corrections DESC, corr.field_name
          LIMIT 10`,
      p,
    ),
    client.query<{ change_source: string; count: number }>(
      `SELECT a.change_source, COUNT(*)::int AS count
         FROM document_field_audit a
        WHERE a.tenant_id = $1
          AND a.changed_at >= $2 AND a.changed_at < $3
          AND ($4::text IS NULL OR EXISTS (
                SELECT 1 FROM documents kd WHERE kd.id = a.document_id AND kd.kind = $4))
        GROUP BY a.change_source
        ORDER BY count DESC, a.change_source`,
      p,
    ),
    client.query<{ corrected: number; documents: number }>(
      `SELECT
         (SELECT COUNT(DISTINCT a.document_id)::int
            FROM document_field_audit a
           WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
             AND a.changed_at >= $2 AND a.changed_at < $3
             AND ($4::text IS NULL OR EXISTS (
                   SELECT 1 FROM documents k1 WHERE k1.id = a.document_id AND k1.kind = $4))) AS corrected,
         (SELECT COUNT(*)::int FROM documents d
           WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
             AND ($4::text IS NULL OR d.kind = $4)
             AND d.created_at >= $2 AND d.created_at < $3) AS documents`,
      p,
    ),
    client.query<{ p50: number | null; p90: number | null }>(
      `WITH first_corr AS (
         SELECT a.document_id, MIN(a.changed_at) AS at
           FROM document_field_audit a
          WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
            AND a.changed_at >= $2 AND a.changed_at < $3
          GROUP BY a.document_id
       )
       SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (fc.at - d.created_at)) / 3600
              )::float8 AS p50,
              PERCENTILE_CONT(0.9) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (fc.at - d.created_at)) / 3600
              )::float8 AS p90
         FROM first_corr fc JOIN documents d ON d.id = fc.document_id
        WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
          AND ($4::text IS NULL OR d.kind = $4)`,
      p,
    ),
    client.query<{ week: string; avg_confidence: number | null; correction_rate: number | null }>(
      `WITH docs AS (
         SELECT TO_CHAR(DATE_TRUNC('week', d.created_at), 'YYYY-MM-DD') AS week,
                d.confidence::float8 AS conf,
                EXISTS (SELECT 1 FROM document_field_audit a
                         WHERE a.document_id = d.id
                           AND a.change_source = 'manual_correction') AS corrected
           FROM documents d
          WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
            AND ($4::text IS NULL OR d.kind = $4)
            AND d.created_at >= $2 AND d.created_at < $3
       )
       SELECT week, AVG(conf)::float8 AS avg_confidence,
              (COUNT(*) FILTER (WHERE corrected))::float8 / NULLIF(COUNT(*), 0) AS correction_rate
         FROM docs GROUP BY week ORDER BY week`,
      p,
    ),
  ])

  const documents = rate.rows[0].documents
  const corrected = rate.rows[0].corrected
  return {
    window: { from: window.fromLabel, to: window.toLabel, days: window.days },
    byRule: byRule.rows.map((r) => ({ ruleId: r.rule_id, total: r.total, open: r.open, waived: r.waived })),
    topFields: topFields.rows.map((r) => ({ field: r.field, corrections: r.corrections, violations: r.violations })),
    bySource: bySource.rows.map((r) => ({ changeSource: r.change_source, count: r.count })),
    correctionRate: { corrected, documents, rate: documents === 0 ? null : corrected / documents },
    turnaround: { p50Hours: turnaround.rows[0].p50, p90Hours: turnaround.rows[0].p90 },
    confidenceTrend: trend.rows.map((r) => ({
      week: r.week,
      avgConfidence: r.avg_confidence,
      correctionRate: r.correction_rate,
    })),
  }
}
```

Every aggregate that must become a JavaScript number carries an explicit `::int` or `::float8`, which is what keeps Global Constraint 5 from leaking `"2"` into a `number` field. `PERCENTILE_CONT` over an empty set is `NULL`, so an uncorrected tenant gets `null` rather than `0` — the panel prints "no corrections yet", which is not the same claim as "instant".

- [ ] **Step 3: The window parser and the route**

In `src/api/documents.ts`, above the routes:

```ts
const MAX_WINDOW_DAYS = 365
const DEFAULT_WINDOW_DAYS = 90

function parseAnalyticsWindow(
  from: string | undefined,
  to: string | undefined,
): { ok: true; window: AnalyticsWindow } | { ok: false; error: string } {
  const today = localDay(new Date())
  const toDay = to === undefined || to === '' ? today : parseDate(to)
  if (toDay === null) return { ok: false, error: 'bad_range' }
  const fromDay = from === undefined || from === '' ? null : parseDate(from)
  if (from !== undefined && from !== '' && fromDay === null) return { ok: false, error: 'bad_range' }

  const fromMs = fromDay === null
    ? toDay.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000
    : fromDay.getTime()
  const toExclusiveMs = toDay.getTime() + 86_400_000
  const days = Math.round((toExclusiveMs - fromMs) / 86_400_000)
  if (days < 1 || days > MAX_WINDOW_DAYS) return { ok: false, error: 'bad_range' }

  return {
    ok: true,
    window: {
      from: new Date(fromMs),
      toExclusive: new Date(toExclusiveMs),
      fromLabel: dayLabel(fromMs),
      toLabel: dayLabel(toDay.getTime()),
      days,
    },
  }
}

function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
```

`to` names the last day the reader wants, so `toExclusive` is that day plus one and `window.days` counts calendar days inclusively on both ends: `from=2026-09-01&to=2026-09-30` is a 30-day window, and the default is the 90 days ending today. The default `today` is `localDay(new Date())`, read here because the route is the boundary and constraint 6 keeps the clock out of `src/validation/`; local, because the day an operator means by "today" is their own business day, not the UTC one. Window maths is the one place this plan renders a day in UTC deliberately: `parseDate` builds with `Date.UTC` and `dayLabel` reads it back with `toISOString()`, so build and render agree inside the same function and no stored `date` is ever compared against these labels.

Two defects in the snippet above are measured and belong to Task 12, which is why they are recorded here rather than silently carried: `parseDate` returns `string | null` (`src/validation/values.ts:37`), so `toDay.getTime()` and `fromDay.getTime()` do not typecheck as written, and the fix is a `dayToMs(day: string)` helper that splits the three components and rebuilds them as a LOCAL midnight per ruling R54, keeping build and render in that one zone. Separately, and for the same reason, the resulting window edges must be the operator's day boundaries rather than UTC midnights: R54 decides it, so `from`/`toExclusive` are local midnights and the last day's afternoon rows are inside the window.

```ts
app.get('/analytics/review', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const { tenantId } = gate.identity

  const parsed = parseAnalyticsWindow(c.req.query('from'), c.req.query('to'))
  if (!parsed.ok) return c.json({ error: parsed.error, maxDays: MAX_WINDOW_DAYS }, 400)

  const kind = c.req.query('kind')
  if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
    return c.json({ error: 'bad_filter', param: 'kind' }, 400)
  }

  const analytics = await reviewAnalytics(tenantId, parsed.window, (kind as 'invoice' | 'contract' | undefined) ?? null)
  return c.json(analytics)
})
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/api/analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/db/validation.ts src/api/documents.ts tests/api/analytics.test.ts
git commit -m "feat(api): review analytics with one defined formula per reported number"
```

---

### Task 13: The CSV export route

**Files:**
- Create: `src/api/audit-csv.ts`
- Modify: `src/db/validation.ts` (add `exportAuditRows`)
- Modify: `src/api/documents.ts` (one new route)
- Create: `tests/api/audit-export.test.ts`

**Interfaces:**
- Consumes: `document_field_audit` (Phase 1), `documents.title`, `parseDate` from `src/validation/values.js`, `localDay` from `src/validation/index.js`, the `parseAnalyticsWindow` helper Task 12 added (reused here unchanged).
- Produces: `GET /api/documents/audit/export` returning `text/csv`. Task 16 puts a button on it.

```ts
export const AUDIT_CSV_HEADER = [
  'document_id', 'document_title', 'table_name', 'field_name', 'action',
  'old_value', 'new_value', 'changed_by', 'changed_at', 'change_source', 'reason',
]
export const MAX_EXPORT_ROWS = 50_000

export interface AuditExportRow {
  document_id: string
  document_title: string
  table_name: string
  field_name: string
  action: string
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

export function csvCell(value: string | null): string
export function csvRow(cells: readonly (string | null)[]): string
export function buildAuditCsv(rows: readonly AuditExportRow[]): string

export function exportAuditRows(
  tenantId: string,
  window: AnalyticsWindow,
  changeSource: string | null,
  kind: 'invoice' | 'contract' | null,
  max: number,
): Promise<AuditExportRow[]>
```

Ruling R16. The row cap is caller-reducible but never caller-raisable: `?max=` is clamped to `[1, MAX_EXPORT_ROWS]` and defaults to `MAX_EXPORT_ROWS`. Why: the branch that matters, "this slice is too big to hand over", is otherwise only reachable by inserting fifty thousand audit rows in a test, which is a minute of database churn for one assertion. Cost if wrong: a caller who types `max=999999` silently gets `50000` and the response says so in the `X-Export-Row-Cap` header.

Ruling R17. The cap is enforced with `LIMIT max + 1`, not a preflight `COUNT(*)`. Why: one round trip, and the extra row is exactly the evidence needed to refuse. Cost if wrong: the refusal cannot say how many rows really exist, so it says the cap instead, which is the number the reader can act on.

Ruling R18. A `jsonb` audit cell is rendered with `#>> '{}'` in SQL, not re-serialized in TypeScript. Why: for the scalar values the trigger stores that yields the bare text the reviewer read on screen, and it keeps `audit-csv.ts` free of a database type it has no business knowing. Cost if wrong: an object-valued cell arrives as its JSON text, which is still lossless.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/audit-export.test.ts`. The pure half needs no server and runs in the `unit` project; the route half uses `createTestServer` and the `seedInvoice` plus `addAudit` helpers from Task 12.

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_CSV_HEADER, buildAuditCsv, csvCell } from '../../src/api/audit-csv.js'

describe('csvCell', () => {
  it('leaves a plain value bare', () => {
    expect(csvCell('AUD')).toBe('AUD')
  })
  it('quotes a comma without touching the rest', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"')
  })
  it('doubles an interior quote and quotes the field', () => {
    expect(csvCell('the "vendor" field')).toBe('"the ""vendor"" field"')
  })
  it('quotes a newline', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })
  it('quotes a carriage return', () => {
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"')
  })
  it('maps null to an empty cell, not to the word null', () => {
    expect(csvCell(null)).toBe('')
  })
  it('maps the empty string to an empty cell', () => {
    expect(csvCell('')).toBe('')
  })
  it('keeps a leading space, which Excel would otherwise trim silently', () => {
    expect(csvCell(' AUD')).toBe(' AUD')
  })
})

describe('buildAuditCsv', () => {
  const row = {
    document_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    document_title: 'Acme, Co',
    table_name: 'invoices',
    field_name: 'total',
    action: 'update',
    old_value: '1200.00',
    new_value: '1100.00',
    changed_by: null,
    changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction',
    reason: null,
  }

  it('leads the body with a UTF-8 byte order mark', () => {
    expect(buildAuditCsv([row]).charCodeAt(0)).toBe(0xfeff)
  })
  it('starts with the header in the fixed column order', () => {
    const lines = buildAuditCsv([row]).slice(1).split('\r\n')
    expect(lines[0]).toBe(AUDIT_CSV_HEADER.join(','))
  })
  it('terminates every record with CRLF, as RFC 4180 requires', () => {
    const text = buildAuditCsv([row])
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.split('\n').length).toBe(3)
  })
  it('quotes only the cells that need it, in order', () => {
    const lines = buildAuditCsv([row]).slice(1).split('\r\n')
    expect(lines[1]).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001,"Acme, Co",invoices,total,update,1200.00,1100.00,' +
        ',2026-11-03T09:00:00.000Z,manual_correction,',
    )
  })
  it('emits a header-only file for no rows', () => {
    const text = buildAuditCsv([])
    expect(text).toBe('\uFEFF' + AUDIT_CSV_HEADER.join(',') + '\r\n')
  })
})
```

`''.charCodeAt(0)` is `0xfeff` written as an escape, never pasted as an invisible character — a literal BOM in a source file is unreadable and gets stripped by half the editors on this machine.

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../../helpers/test-server.js'

const TENANT = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000009'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

let server: TestServer
let documentId: string

async function exportCsv(query: string) {
  return server.fetch('/api/documents/audit/export' + query, { headers: HEADERS })
}

function exportLines(text: string): string[] {
  return text.slice(1).split('\r\n').filter((line) => line !== '')
}

beforeAll(async () => {
  server = await createTestServer()
})

beforeEach(async () => {
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  await server.db.query('DELETE FROM documents WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  documentId = await seedInvoice(server.db, { total: '1200.00', vendor_name: 'Acme' })
})

describe('GET /audit/export', () => {
  it('refuses a request with no identity', async () => {
    expect((await server.fetch('/api/documents/audit/export')).status).toBe(401)
  })

  it('answers 204 when the window holds nothing', async () => {
    const res = await exportCsv('?from=2020-01-01&to=2020-01-31')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('serves csv with an attachment name built from the window', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const res = await exportCsv('?from=2026-10-01&to=2026-10-31')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="field-audit-2026-10-01-to-2026-10-31.csv"')
  })

  it('quotes a title containing a comma and a reason containing a quote', async () => {
    await server.db.query("UPDATE documents SET title = 'Acme, Co' WHERE id = $1", [documentId])
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z', USER, 'fixed the "sum"')
    const text = await (await exportCsv()).text()
    expect(text).toContain('"Acme, Co"')
    expect(text).toContain('"fixed the ""sum"""')
  })

  it('renders jsonb cells as their bare text, not as quoted json', async () => {
    await server.db.query(
      `INSERT INTO document_field_audit
         (document_id, tenant_id, table_name, field_name, action, old_value, new_value, changed_by, changed_at, change_source)
       VALUES ($1, $2, 'invoices', 'total', 'update', $3::jsonb, $4::jsonb, $5, '2026-10-01T00:00:00Z', 'manual_correction')`,
      [documentId, TENANT, JSON.stringify('1100.00'), JSON.stringify(1200.5), USER],
    )
    const lines = exportLines(await (await exportCsv()).text())
    expect(lines[1]).toContain(',invoices,total,update,1100.00,1200.5,' + USER)
  })
  })

  it('filters by change source', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(documentId, 'tax', 'extraction', '2026-10-01T00:00:00Z')
    const filtered = await (await exportCsv('?change_source=manual_correction')).text()
    expect(filtered.split('\r\n').length).toBe(3)
    expect(filtered).not.toContain('extraction')
  })

  it('rejects an unknown change source', async () => {
    const res = await exportCsv('?change_source=somehow')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_filter', param: 'change_source' })
  })

  it('rejects a malformed window with bad_range', async () => {
    const res = await exportCsv('?from=not-a-date')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_range' })
  })

  it('refuses rather than truncating past the cap', async () => {
    for (let i = 0; i < 3; i++) {
      await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:0' + i + 'Z')
    }
    const res = await exportCsv('?max=2')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'too_many_rows', max: 2 })
  })

  it('clamps a requested cap above the ceiling instead of raising it', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const res = await exportCsv('?max=999999')
    expect(res.headers.get('x-export-row-cap')).toBe('50000')
  })

  it('never exports another tenant row', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await server.db.query('UPDATE document_field_audit SET tenant_id = $2 WHERE document_id = $1', [documentId, OTHER])
    const text = await (await exportCsv()).text()
    expect(exportLines(text)).toHaveLength(1)
  })

  it('orders newest first and honours the kind filter', async () => {
    const con = await seedInvoice(server.db, { total: '5.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(con, 'contract_value', 'manual_correction', '2026-10-01T00:00:00Z')
    const text = await (await exportCsv('?kind=contract')).text()
    expect(text).toContain(con)
    expect(text).not.toContain(documentId)
  })
})
```

Two of these tests depend on `addAudit` accepting a reason argument, so widen the Task 12 helper to `addAudit(docId, field, source, at, by = USER, reason = null)` and put `$8` in the insert's `reason` column. The helper stays one function shared by three suites; that is the point of putting it in the plan once.

Run: `npx vitest run tests/api/audit-export.test.ts`
Expected: FAIL, the pure describe blocks first because `src/api/audit-csv.ts` does not exist.

- [ ] **Step 2: The pure formatter**

Create `src/api/audit-csv.ts`.

```ts
export const AUDIT_CSV_HEADER = [
  'document_id', 'document_title', 'table_name', 'field_name', 'action',
  'old_value', 'new_value', 'changed_by', 'changed_at', 'change_source', 'reason',
] as const

export const MAX_EXPORT_ROWS = 50_000
const NEEDS_QUOTING = /[",\r\n]/

export interface AuditExportRow {
  document_id: string
  document_title: string
  table_name: string
  field_name: string
  action: string
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

const FIELDS: readonly (keyof AuditExportRow)[] = AUDIT_CSV_HEADER

export function csvCell(value: string | null): string {
  if (value === null) return ''
  if (!NEEDS_QUOTING.test(value)) return value
  return '"' + value.replaceAll('"', '""') + '"'
}

export function csvRow(cells: readonly (string | null)[]): string {
  return cells.map(csvCell).join(',') + '\r\n'
}

export function buildAuditCsv(rows: readonly AuditExportRow[]): string {
  const lines = [csvRow([...AUDIT_CSV_HEADER])]
  for (const row of rows) {
    lines.push(csvRow(FIELDS.map((key) => (row[key] == null ? null : String(row[key])))))
  }
  return '\uFEFF' + lines.join('')
}
```

The BOM is the only non-ASCII character permitted in this file, and Step 2 is where it is typed: write it as `'\uFEFF'` in the source. `FIELDS.map((key) => row[key])` rather than eleven hand-written arguments is what keeps the header and the body from ever disagreeing, which is the failure mode a CSV export has.

- [ ] **Step 3: The read**

Append to `src/db/validation.ts`.

```ts
const EXPORT_FIELDS = `
  a.document_id::text,
  d.title AS document_title,
  a.table_name,
  a.field_name,
  a.action,
  a.old_value #>> '{}' AS old_value,
  a.new_value #>> '{}' AS new_value,
  a.changed_by::text,
  TO_CHAR(a.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
  a.change_source,
  a.reason
`

export async function exportAuditRows(
  tenantId: string,
  window: AnalyticsWindow,
  changeSource: string | null,
  kind: 'invoice' | 'contract' | null,
  max: number,
): Promise<AuditExportRow[]> {
  const client = getDbClient()
  const result = await client.query<AuditExportRow>(
    'SELECT ' + EXPORT_FIELDS + `
       FROM document_field_audit a
       JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id = $1
        AND a.changed_at >= $2 AND a.changed_at < $3
        AND ($4::text IS NULL OR a.change_source = $4)
        AND ($5::text IS NULL OR d.kind = $5)
      ORDER BY a.changed_at DESC, a.id
      LIMIT $6`,
    [tenantId, window.from, window.toExclusive, changeSource, kind, max + 1],
  )
  return result.rows
}
```

`ORDER BY a.changed_at DESC, a.id` breaks ties deterministically, because a batch of corrections lands in the same transaction and shares `now()` to the microsecond. Without the `a.id` the reader's row order changes between two exports of the same window, and a compliance officer comparing files would see a diff that is not there.

`AT TIME ZONE 'UTC'` before `TO_CHAR` is not cosmetic: `to_char` on a `timestamptz` formats in the session timezone, so the same row would export different text from a machine set to Sydney and a machine set to London.

- [ ] **Step 4: The route**

In `src/api/documents.ts`, register it after `/review-queue`. `/audit/export` is two segments so it cannot be reached by `/:id`, which is one segment; order still groups the three read routes together.

```ts
app.get('/audit/export', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error
  const { tenantId } = gate.identity

  const parsed = parseAnalyticsWindow(c.req.query('from'), c.req.query('to'))
  if (!parsed.ok) return c.json({ error: parsed.error, maxDays: MAX_WINDOW_DAYS }, 400)

  const changeSource = c.req.query('change_source') ?? null
  if (changeSource !== null && !CHANGE_SOURCES.has(changeSource)) {
    return c.json({ error: 'bad_filter', param: 'change_source' }, 400)
  }
  const kind = c.req.query('kind')
  if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
    return c.json({ error: 'bad_filter', param: 'kind' }, 400)
  }
  const rawMax = intQuery(c.req.query('max'), MAX_EXPORT_ROWS)
  if (rawMax === null || rawMax < 1) return c.json({ error: 'bad_filter', param: 'max' }, 400)
  const cap = Math.min(MAX_EXPORT_ROWS, rawMax)

  const rows = await exportAuditRows(
    tenantId, parsed.window, changeSource, (kind as 'invoice' | 'contract' | undefined) ?? null, cap,
  )
  c.header('X-Export-Row-Cap', String(cap))
  if (rows.length > cap) {
    return c.json({ error: 'too_many_rows', max: cap }, 400)
  }
  if (rows.length === 0) return c.body(null, 204)

  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header(
    'Content-Disposition',
    'attachment; filename="field-audit-' + parsed.window.fromLabel + '-to-' + parsed.window.toLabel + '.csv"',
  )
  return c.body(buildAuditCsv(rows))
})
```

`CHANGE_SOURCES` is the five-value tuple Task 2 exported from `src/db/audit-context.ts`, so the export filter, the `AuditContext` type and the `CHECK` constraint in `migrations/0023` all read one list. Import it with `(await import('../db/audit-context.js')).CHANGE_SOURCES` if adding a fourth import line to `src/api/documents.ts` trips the file's existing import style; a plain top-level import is what Task 2 expects and is the better choice.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/api/audit-export.test.ts`
Expected: PASS. Then confirm no regression in the neighbours: `npx vitest run tests/api/review-queue.test.ts tests/api/analytics.test.ts`.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx eslint .
git add src/api/audit-csv.ts src/db/validation.ts src/api/documents.ts tests/api/audit-export.test.ts
git commit -m "feat(api): csv export of the field audit trail that refuses rather than truncates"
```

---

### Task 14: The console review client and the two read-only components

**Files:**
- Create: `console/lib/review.ts`
- Create: `console/components/FieldConfidenceChip.tsx`
- Create: `console/components/FindingList.tsx`
- Create: `console/tests/FindingList.test.tsx`

**Interfaces:**
- Consumes: `get`, `post`, `patch`, `describeError` from `console/lib/api.ts:112-125`, `route` and `stubFetch` from `console/tests/fetchStub.ts`.
- Produces: every type and fetcher Tasks 15, 16 and 17 import. `FindingList` renders the array `Task 9`'s `GET /:id/validation` returns and calls `onWaive(id, reason)`; `FieldConfidenceChip` takes one number and colours it.

Ruling R19. `console/lib/review.ts` re-declares the shapes the server returns rather than importing them. Why: `console/` is a separate npm workspace whose `tsconfig.json` maps `@/*` to itself and never reaches `../src`, and every existing console type lives in `console/lib/types.ts` for the same reason. Cost if wrong: a server field rename surfaces as a console type error only at render time, which is why Task 18 adds a contract test that reads the server's own route file for the key names it claims.

Ruling R20. `CONFIDENCE_THRESHOLD = 0.7` is duplicated in `console/lib/review.ts` as `REVIEW_CONFIDENCE_FLOOR`, with a comment naming `src/mastra/workflows/document-intake.ts:26`. Why: the alternative is a new `/api/documents/meta` route to deliver one number the server already knows, which is more surface than the value. Cost if wrong: a chip colour disagrees with the server's queue ordering until someone notices. Task 18 pins the server constant at `0.7` in a test so the drift is at least loud.

```ts
// console/lib/review.ts
export const REVIEW_CONFIDENCE_FLOOR = 0.7

export type Severity = 'error' | 'warning'

export interface StoredViolation {
  id: string
  documentId: string
  rulesetVersion: string
  severity: Severity
  ruleId: string
  field: string
  message: string
  status: 'open' | 'waived'
  waivedBy: string | null
  waivedAt: string | null
  waiverReason: string | null
  createdAt: string
}

export interface ValidationResponse {
  documentId: string
  rulesetVersion: string
  violations: StoredViolation[]
}

export interface ReviewQueueItem {
  documentId: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: number | null
  lowestFieldConfidence: number | null
  openErrors: number
  openWarnings: number
  reasons: string[]
  createdAt: string
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[]
  total: number
  limit: number
  offset: number
}

export interface AuditRow {
  document_id: string
  tenant_id: string
  table_name: string
  field_name: string
  action: string
  old_value: unknown
  new_value: unknown
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

export interface CorrectionResult {
  success: boolean
  openErrors: number
  openWarnings: number
  violations: StoredViolation[]
}

export interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
}

export const getValidation = (id: string): Promise<ValidationResponse> =>
  get<ValidationResponse>(`/api/documents/${id}/validation`)
export const revalidateDocument = (id: string): Promise<ValidationResponse> =>
  post<ValidationResponse>(`/api/documents/${id}/validation`)
export const waiveFinding = (id: string, violationId: string, reason: string): Promise<{ violation: StoredViolation }> =>
  post<{ violation: StoredViolation }>(`/api/documents/${id}/validation/${violationId}/waive`, { reason })
export const getReviewQueue = (query: string): Promise<ReviewQueueResponse> =>
  get<ReviewQueueResponse>(`/api/documents/review-queue${query}`)
export const getAuditTrail = (id: string): Promise<{ audit: AuditRow[] }> =>
  get<{ audit: AuditRow[] }>(`/api/documents/${id}/audit`)
export const patchInvoiceField = (id: string, field: string, value: string, reason?: string) =>
  patch<CorrectionResult>(`/api/documents/${id}/invoices/${field}`, reason === undefined ? { value } : { value, reason })
export const patchContractField = (id: string, field: string, value: string, reason?: string) =>
  patch<CorrectionResult>(`/api/documents/${id}/contracts/${field}`, reason === undefined ? { value } : { value, reason })
export const getReviewAnalytics = (query: string): Promise<ReviewAnalytics> =>
  get<ReviewAnalytics>(`/api/documents/analytics/review${query}`)

export function findingsFor(violations: readonly StoredViolation[], field: string): StoredViolation[]
export function cellText(value: unknown): string
export function shortTime(iso: string): string
```

`cellText` is the one function that keeps `jsonb` from leaking into the UI: the server returns `old_value` as a parsed JSON value, so a string arrives as a string, a number as a number, and an absent value as `null`. It renders `null` as an empty string, a string without quotes, and anything else as `JSON.stringify`.

- [ ] **Step 1: Write the failing component tests**

Create `console/tests/FindingList.test.tsx`.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingList } from '../components/FindingList'
import type { StoredViolation } from '../lib/review'

function violation(over: Partial<StoredViolation> = {}): StoredViolation {
  return {
    id: 'v1v1v1v1-0000-4000-8000-000000000001',
    documentId: 'd1d1d1d1-0000-4000-8000-000000000001',
    rulesetVersion: 'v1',
    severity: 'error',
    ruleId: 'invoice.total.sum',
    field: 'total',
    message: 'Subtotal plus tax does not equal the total.',
    status: 'open',
    waivedBy: null,
    waivedAt: null,
    waiverReason: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    ...over,
  }
}

beforeEach(() => vi.stubGlobal('confirm', vi.fn(() => true)))
afterEach(() => vi.unstubAllGlobals())

describe('FindingList', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<FindingList violations={[]} onWaive={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the message with its severity named in words', () => {
    render(<FindingList violations={[violation()]} onWaive={vi.fn()} />)
    expect(screen.getByText('Subtotal plus tax does not equal the total.')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('error')
  })

  it('shows a warning as a warning, not as an error', () => {
    render(<FindingList violations={[violation({ severity: 'warning', ruleId: 'invoice.currency.shape' })]} onWaive={vi.fn()} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('warning')
  })

  it('names the field the finding points at', () => {
    render(<FindingList violations={[violation({ field: 'lines.amount' })]} onWaive={vi.fn()} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('lines.amount')
  })

  it('offers waive on an open finding', () => {
    render(<FindingList violations={[violation()]} onWaive={vi.fn()} />)
    expect(screen.getByRole('button', { name: /waive/i })).toBeInTheDocument()
  })

  it('asks for a reason and passes it up', async () => {
    const onWaive = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('prompt', vi.fn(() => 'vendor corrected it on the phone'))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).toHaveBeenCalledWith(violation().id, 'vendor corrected it on the phone'))
  })

  it('sends nothing when the reviewer cancels the prompt', async () => {
    const onWaive = vi.fn()
    vi.stubGlobal('prompt', vi.fn(() => null))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).not.toHaveBeenCalled())
  })

  it('sends nothing when the reason is shorter than the server will accept', async () => {
    const onWaive = vi.fn()
    vi.stubGlobal('prompt', vi.fn(() => 'sure'))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).not.toHaveBeenCalled())
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
  })

  it('shows a waived finding as waived, with who and why, and no waive button', () => {
    render(
      <FindingList
        violations={[violation({ status: 'waived', waiverReason: 'confirmed with the vendor', waivedAt: '2026-11-03T10:00:00.000Z' })]}
        onWaive={vi.fn()}
      />,
    )
    expect(screen.getByRole('listitem')).toHaveTextContent('waived')
    expect(screen.getByRole('listitem')).toHaveTextContent('confirmed with the vendor')
    expect(screen.queryByRole('button', { name: /waive/i })).not.toBeInTheDocument()
  })
})
```

Run: `cd console && npx vitest run tests/FindingList.test.tsx` (with `dir_path` `D:\Code\CRUM\console`)
Expected: FAIL, `../components/FindingList` does not resolve.

- [ ] **Step 2: Write the library and the chip**

Create `console/lib/review.ts` with the declarations listed above, importing `get`, `patch`, `post` from `./api`, and these three implementations verbatim:

```ts
export function findingsFor(violations: readonly StoredViolation[], field: string): StoredViolation[] {
  return violations.filter((v) => v.field === field)
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}
```

Create `console/components/FieldConfidenceChip.tsx`.

```tsx
'use client'

import { REVIEW_CONFIDENCE_FLOOR } from '../lib/review'

export function FieldConfidenceChip({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-text-muted" data-testid="confidence-chip">no score</span>
  }
  const tone = value < REVIEW_CONFIDENCE_FLOOR ? 'text-danger' : value < 0.9 ? 'text-warning' : 'text-success'
  return (
    <span className={'text-xs tabular-nums ' + tone} data-testid="confidence-chip" title={'field confidence ' + value.toFixed(3)}>
      {Math.round(value * 100)}%
    </span>
  )
}
```

`data-testid="confidence-chip"` is on both branches on purpose, so a test can assert the absent case rather than infer it from the absence of a percentage.

- [ ] **Step 3: Write `FindingList`**

Create `console/components/FindingList.tsx`.

```tsx
'use client'

import { useState } from 'react'

import type { StoredViolation } from '../lib/review'

const MIN_WAIVER_REASON = 8

export function FindingList({
  violations,
  onWaive,
}: {
  violations: readonly StoredViolation[]
  onWaive: (violationId: string, reason: string) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  if (violations.length === 0) return null

  return (
    <ul className="space-y-1">
      {violations.map((v) => (
        <li key={v.id} className="rounded border border-border bg-bg-card px-2 py-1 text-xs">
          <span className={v.severity === 'error' ? 'text-danger font-semibold' : 'text-warning font-semibold'}>
            {v.severity}
          </span>
          <span className="mx-1 text-text-muted">{v.field}</span>
          <span className="text-text-primary">{v.message}</span>
          {v.status === 'waived' ? (
            <span className="ml-1 text-text-muted">
              waived{v.waiverReason ? `: ${v.waiverReason}` : ''}
            </span>
          ) : (
            <button
              type="button"
              className="ml-2 underline text-text-muted hover:text-text-primary"
              onClick={async () => {
                const reason = window.prompt('Why can this finding be ignored? A reason is required.')
                if (reason === null) return
                const trimmed = reason.trim()
                if (trimmed.length < MIN_WAIVER_REASON) {
                  setError('A waiver reason needs at least 8 characters.')
                  return
                }
                setError(null)
                await onWaive(v.id, trimmed)
              }}
            >
              waive
            </button>
          )}
        </li>
      ))}
      {error ? <li className="text-xs text-danger">{error}</li> : null}
    </ul>
  )
}
```

The reason gate exists twice, here and in `Task 9`'s route. That is deliberate and not a duplicated rule: the server's check is the one that protects the record, and this one only saves a round trip, so a reviewer who pastes a seven-character reason sees the complaint before the POST. `MIN_WAIVER_REASON` is a local constant rather than an import because the two live in different workspaces.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/FindingList.test.tsx` from `D:\Code\CRUM\console`
Expected: PASS, nine cases.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd console && npx tsc --noEmit && npx next lint
git add console/lib/review.ts console/components/FieldConfidenceChip.tsx console/components/FindingList.tsx console/tests/FindingList.test.tsx
git commit -m "feat(console): the review client, a confidence chip, and a finding list that waives with a reason"
```

---

### Task 15: Inline correction and the audit trail panel

**Files:**
- Create: `console/components/EditableField.tsx`
- Create: `console/components/AuditTrail.tsx`
- Create: `console/tests/EditableField.test.tsx`
- Create: `console/tests/AuditTrail.test.tsx`

**Interfaces:**
- Consumes: `patchInvoiceField`, `patchContractField`, `cellText`, `shortTime`, `AuditRow`, `CorrectionResult` from `console/lib/review.ts` (Task 14).
- Produces: `<EditableField tableName="invoices" documentId field label value confidence findings requiredReason onCorrected />` and `<AuditTrail rows onReload />`. Task 16 places both inside `DocumentManager`.

`requiredReason` is the whole point of this component. The panel sets it true when the field carries an open `error` finding, and the component refuses to send the `PATCH` without one, matching the server rule that a reason is what makes a correction auditable. The server (Task 10) is authoritative: this is the same guard, one layer earlier, for the same round-trip reason as in Task 14.

- [ ] **Step 1: Write the failing tests**

Create `console/tests/EditableField.test.tsx`.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableField } from '../components/EditableField'
import { route, stubFetch, type FetchStub } from './fetchStub'
import type React from 'react'

const DOC = 'd1d1d1d1-0000-4000-8000-000000000001'
const PATCHED = { success: true, openErrors: 0, openWarnings: 1, violations: [] }

let server: FetchStub

beforeEach(() => {
  server = stubFetch([route('/invoices/total', { status: 200, body: PATCHED }, 'PATCH')])
})

type FieldProps = React.ComponentProps<typeof EditableField>

function props(over: Partial<FieldProps> = {}): FieldProps {
  return {
    documentId: DOC,
    tableName: 'invoices',
    field: 'total',
    label: 'Total',
    value: '1200.00',
    confidence: 0.95,
    findings: [],
    requiredReason: false,
    onCorrected: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('EditableField', () => {
  it('shows the current value and an edit affordance', () => {
    render(<EditableField {...props()} />)
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('1200.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
  })

  it('does nothing until the reviewer saves', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /total/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    expect(server.count('/invoices/total')).toBe(0)
  })

  it('sends the new value with no reason when one is not required', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /total/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.last('/invoices/total')?.body).toEqual({ value: '1100.00' }))
  })

  it('refuses to send when a reason is required and blank', async () => {
    render(<EditableField {...props({ requiredReason: true })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/reason is required/i)).toBeInTheDocument())
    expect(server.count('/invoices/total')).toBe(0)
  })

  it('sends value and reason together once the reason is long enough', async () => {
    render(<EditableField {...props({ requiredReason: true })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /^total$/i }), '1100.00')
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'vendor reissued the invoice')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(server.last('/invoices/total')?.body).toEqual({ value: '1100.00', reason: 'vendor reissued the invoice' }),
    )
  })

  it('reports the open error count that came back with the correction', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/1 warning still open/i)).toBeInTheDocument())
  })

  it('tells the parent so it can repaint', async () => {
    const onCorrected = vi.fn().mockResolvedValue(undefined)
    render(<EditableField {...props({ onCorrected })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(onCorrected).toHaveBeenCalledTimes(1))
  })

  it('surfaces a server rejection instead of swallowing it', async () => {
    server = stubFetch([route('/invoices/total', { status: 400, body: { error: 'reason_required' } }, 'PATCH')])
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/reason_required/i)).toBeInTheDocument())
  })

  it('cancels back to the value it started with', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '999')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.getByText('1200.00')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('routes a contract field to the contract path', async () => {
    server = stubFetch([route('/contracts/contract_value', { status: 200, body: PATCHED }, 'PATCH')])
    render(<EditableField {...props({ tableName: 'contracts', field: 'contract_value', label: 'Contract value' })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /contract value/i }), '50000')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.count('/contracts/contract_value')).toBe(1))
  })
})
```

Create `console/tests/AuditTrail.test.tsx`.

```ts
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuditTrail } from '../components/AuditTrail'
import type { AuditRow } from '../lib/review'

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    document_id: 'd1',
    tenant_id: 't1',
    table_name: 'invoices',
    field_name: 'total',
    action: 'update',
    old_value: '1200.00',
    new_value: '1100.00',
    changed_by: '00000000-0000-4000-8000-000000000002',
    changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction',
    reason: 'vendor reissued',
    ...over,
  }
}

describe('AuditTrail', () => {
  it('says so when there is no history at all', () => {
    render(<AuditTrail rows={[]} onReload={vi.fn()} />)
    expect(screen.getByText(/no field changes recorded/i)).toBeInTheDocument()
  })

  it('renders old struck and new for an update', () => {
    render(<AuditTrail rows={[row()]} onReload={vi.fn()} />)
    expect(screen.getByText('1200.00')).toHaveClass('line-through')
    expect(screen.getByText('1100.00')).toBeInTheDocument()
  })

  it('names the source and the reason', () => {
    render(<AuditTrail rows={[row()]} onReload={vi.fn()} />)
    expect(screen.getByText('manual correction')).toBeInTheDocument()
    expect(screen.getByText('vendor reissued')).toBeInTheDocument()
  })

  it('leaves the reason slot empty rather than inventing one', () => {
    render(<AuditTrail rows={[row({ reason: null })]} onReload={vi.fn()} />)
    expect(screen.getByText('extraction').closest('li')).toHaveTextContent('total')
  })

  it('renders an extraction row without an old value', () => {
    render(<AuditTrail rows={[row({ change_source: 'extraction', action: 'insert', old_value: null })]} onReload={vi.fn()} />)
    expect(screen.getByText('1100.00')).toBeInTheDocument()
    expect(screen.queryByText('1200.00')).not.toBeInTheDocument()
  })

  it('renders a numeric jsonb value as a number, not as quoted json', () => {
    render(<AuditTrail rows={[row({ new_value: 1200.5 })]} onReload={vi.fn()} />)
    expect(screen.getByText('1200.5')).toBeInTheDocument()
  })

  it('offers a reload', async () => {
    const onReload = vi.fn()
    render(<AuditTrail rows={[]} onReload={onReload} />)
    await userEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
```

Run: `npx vitest run tests/EditableField.test.tsx tests/AuditTrail.test.tsx`
Expected: FAIL, neither module resolves.

- [ ] **Step 2: `EditableField`**

Create `console/components/EditableField.tsx`.

```tsx
'use client'

import { useState } from 'react'

import { FieldConfidenceChip } from './FieldConfidenceChip'
import { FindingList } from './FindingList'
import { patchContractField, patchInvoiceField } from '../lib/review'
import type { CorrectionResult, StoredViolation } from '../lib/review'
import { describeError } from '../lib/api'

const MIN_REASON = 8

export function EditableField({
  documentId,
  tableName,
  field,
  label,
  value,
  confidence,
  findings,
  requiredReason,
  onCorrected,
  onWaive,
}: {
  documentId: string
  tableName: 'invoices' | 'contracts'
  field: string
  label: string
  value: string
  confidence: number | null | undefined
  findings: readonly StoredViolation[]
  requiredReason: boolean
  onCorrected: (result: CorrectionResult) => Promise<void> | void
  onWaive?: (violationId: string, reason: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<CorrectionResult | null>(null)

  const start = () => {
    setDraft(value)
    setReason('')
    setProblem(null)
    setOutcome(null)
    setEditing(true)
  }

  async function save() {
    if (requiredReason && reason.trim().length < MIN_REASON) {
      setProblem('A reason is required for a field with an open error (at least 8 characters).')
      return
    }
    setSaving(true)
    setProblem(null)
    try {
      const patch = tableName === 'invoices' ? patchInvoiceField : patchContractField
      const result = await patch(documentId, field, draft, reason.trim() === '' ? undefined : reason.trim())
      setOutcome(result)
      setEditing(false)
      await onCorrected(result)
    } catch (err) {
      setProblem(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  const openErrors = outcome ? outcome.openErrors : 0
  const openWarnings = outcome ? outcome.openWarnings : 0

  return (
    <div className="border-b border-border py-1 text-sm last:border-0">
      <div className="flex items-center justify-between gap-4">
        <span className="text-text-muted">{label}</span>
        <span className="flex items-center gap-2 text-right text-text-primary">
          {!editing ? value : null}
          <FieldConfidenceChip value={confidence} />
          {!editing ? (
            <button type="button" className="text-xs underline text-text-muted" onClick={start}>
              edit
            </button>
          ) : null}
        </span>
      </div>

      {editing ? (
        <div className="mt-1 space-y-1">
          <label className="block text-xs text-text-muted">
            {label}
            <input
              className="mt-1 w-full rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <label className="block text-xs text-text-muted">
            Reason{requiredReason ? ' (required)' : ' (optional)'}
            <input
              className="mt-1 w-full rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button type="button" className="text-xs underline" onClick={save} disabled={saving}>
              {saving ? 'saving' : 'save'}
            </button>
            <button type="button" className="text-xs underline text-text-muted" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
        </div>
      ) : null}

      {problem ? <p className="mt-1 text-xs text-danger">{problem}</p> : null}
      {outcome && !editing ? (
        <p className="mt-1 text-xs text-text-muted">
          {openErrors === 0 && openWarnings === 0
            ? 'correction saved, nothing left open'
            : `${openErrors} error${openErrors === 1 ? '' : 's'} and ${openWarnings} warning${openWarnings === 1 ? '' : 's'} still open`}
        </p>
      ) : null}

      {findings.length > 0 && onWaive ? <FindingList violations={findings} onWaive={onWaive} /> : null}
    </div>
  )
}
```

Two things the reviewer should check rather than assume. The `label` element wraps its `input` so `getByRole('textbox', { name: /total/i })` resolves, and the empty-reason branch passes `undefined` rather than `''` so the server distinguishes "no reason given" from "a blank reason", which Task 10 treats as absent.

The outcome line reads `1 error and 1 warning still open`, which the test asserts through `/1 warning still open/`. Keep that phrasing: a correction that clears the arithmetic error but leaves a currency-shape warning must not read as a full success.

- [ ] **Step 3: `AuditTrail`**

Create `console/components/AuditTrail.tsx`.

```tsx
'use client'

import { cellText, shortTime } from '../lib/review'
import type { AuditRow } from '../lib/review'

const SOURCE_WORDS: Record<string, string> = {
  extraction: 'extraction',
  manual_correction: 'manual correction',
  're-parse': 're-parse',
  import: 'import',
  system: 'system',
}

export function AuditTrail({ rows, onReload }: { rows: readonly AuditRow[]; onReload: () => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.06em] text-text-muted">Field history</p>
        <button type="button" className="text-xs underline text-text-muted" onClick={onReload}>
          reload
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">No field changes recorded yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row, index) => (
            <li key={row.document_id + '-' + row.field_name + '-' + row.changed_at + '-' + index} className="text-xs">
              <span className="text-text-muted">{shortTime(row.changed_at)}</span>
              <span className="mx-1 font-semibold text-text-primary">{row.field_name}</span>
              {row.old_value === null || row.old_value === undefined ? null : (
                <span className="line-through text-text-muted">{cellText(row.old_value)} </span>
              )}
              <span className="text-text-primary">{cellText(row.new_value)}</span>
              <span className="ml-1 text-text-muted">{SOURCE_WORDS[row.change_source] ?? row.change_source}</span>
              {row.reason ? <span className="ml-1 text-text-primary">{row.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

`SOURCE_WORDS` keys are the five values the shipped `CHECK` allows, which after Task 2 are also the five `CHANGE_SOURCES` members, so `'re-parse'` is quoted as a key because it contains a hyphen. A source the map has never seen still renders: the `?? row.change_source` fallback means a value added by a future migration shows as its raw token rather than crashing the panel.

The `key` includes the array index because `document_field_audit` has a primary key the route does not select, so two rows in the same transaction can otherwise share every visible field. The honest alternative, selecting `id` in `GET /:id/audit`, is a one-word change to an existing route and is not required here.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run tests/EditableField.test.tsx tests/AuditTrail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd console && npx tsc --noEmit && npx next lint
git add console/components/EditableField.tsx console/components/AuditTrail.tsx console/tests/EditableField.test.tsx console/tests/AuditTrail.test.tsx
git commit -m "feat(console): an editable field that demands a reason and a field history panel"
```

---

### Task 16: Review mode in `DocumentManager`

**Files:**
- Modify: `console/components/DocumentManager.tsx` (`openDetail` :196, the list table :287-330, `DocumentDetail` :338, `InvoiceView` :384, `ContractView` :417)
- Create: `console/tests/DocumentManagerReviewMode.test.tsx`

**Interfaces:**
- Consumes: `getReviewQueue`, `getValidation`, `getAuditTrail`, `waiveFinding`, `revalidateDocument`, `findingsFor`, `ReviewQueueItem`, `StoredViolation`, `AuditRow`, `CorrectionResult` from `console/lib/review.ts` (Task 14); `EditableField` and `AuditTrail` (Task 15); `FieldConfidenceChip`.
- Produces: the review surface the spec's success criterion 5 is measured on. Nothing downstream consumes it inside this plan.

Ruling R21. `openDetail` stops taking a whole `CrmDocument` and takes `(documentId, title)`, then sets `selected` from `detail.document`, which every detail response already carries. Why: a review-mode row is a `ReviewQueueItem`, not a `CrmDocument`, and the alternative is fabricating `content_hash`, `mime` and `updated_at` in the browser to satisfy a type. Cost if wrong: the two list modes now disagree about which title they show for one frame while the detail loads, which the tests pin.

Ruling R22. After a correction the panel repaints from the `violations` the `PATCH` response already returned (Task 10) rather than issuing the extra `POST /:id/validation` spec 10 describes. Why: the correction re-validates inside its own transaction and hands back the same array a re-run would compute, so the extra round trip would recompute an answer already in hand and could land after a second edit begins. Cost if wrong: a finding cleared by a rule-set change between the two requests stays visible one refresh longer. `revalidateDocument` is still wired, to the explicit "re-check" button, which is the case where the reviewer has changed nothing and wants the rules re-run.

Ruling R23. Review mode is a filter chip on the existing list, not a new page and not a new tab. This is spec R1 and it is also the constraint that keeps `console/app/knowledge/page.tsx` and `SidebarNav.tsx` untouched: no router change appears in this task, so the two files the async roadmap is still dirty with stay out of it.

- [ ] **Step 1: Write the failing integration test**

Create `console/tests/DocumentManagerReviewMode.test.tsx`. It drives the real component against `stubFetch`, so the assertions are about what a reviewer sees and which request follows which click.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentManager } from '../components/DocumentManager'
import { route, stubFetch, type FetchStub, type Reply } from './fetchStub'
import type { CrmDocument } from '../lib/types'

const DOC = 'a1a1a1a1-0000-4000-8000-000000000001'
const VIOL = 'v1v1v1v1-0000-4000-8000-000000000001'

function document(over: Partial<CrmDocument> = {}): CrmDocument {
  return {
    id: DOC, tenant_id: 't', owner_id: 'u', kind: 'invoice',
    title: 'Acme hosting invoice', source: 'upload', source_ref: null,
    content_hash: 'sha256:abc', mime: 'application/pdf', status: 'needs_review',
    confidence: '0.92', customer_id: null,
    created_at: '2026-10-20T09:00:00.000Z', updated_at: '2026-10-24T09:00:00.000Z',
    ...over,
  }
}

const QUEUE: Reply = {
  status: 200,
  body: {
    total: 1, limit: 50, offset: 0,
    items: [{
      documentId: DOC, title: 'Acme hosting invoice', kind: 'invoice', status: 'needs_review',
      confidence: 0.92, lowestFieldConfidence: 0.2, openErrors: 1, openWarnings: 0,
      reasons: ['needs review', 'open error'], createdAt: '2026-10-20T09:00:00.000Z',
    }],
  },
}

const VIOLATION = {
  id: VIOL, documentId: DOC, rulesetVersion: 'v1', severity: 'error', ruleId: 'invoice.total.sum',
  field: 'total', message: 'Subtotal plus tax does not equal the total.', status: 'open',
  waivedBy: null, waivedAt: null, waiverReason: null, createdAt: '2026-11-03T09:00:00.000Z',
}

const DETAIL: Reply = {
  status: 200,
  body: {
    document: document(),
    invoice: {
      vendor_name: 'Acme Cloud', vendor_email: null, invoice_number: 'INV-1',
      invoice_date: '2026-03-01', due_date: null, currency: 'AUD',
      subtotal: '1000.00', tax: '100.00', total: '1200.00',
    },
    lines: [{ id: 'l1', description: 'Hosting', quantity: '1', unit_price: '1000.00', amount: '1000.00', currency: 'AUD' }],
  },
}

const VALIDATION: Reply = { status: 200, body: { documentId: DOC, rulesetVersion: 'v1', violations: [VIOLATION] } }
const AUDIT: Reply = {
  status: 200,
  body: { audit: [{
    document_id: DOC, tenant_id: 't', table_name: 'invoices', field_name: 'total', action: 'update',
    old_value: '1200.00', new_value: '1100.00', changed_by: 'u', changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction', reason: 'vendor reissued',
  }] },
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([
    route('/api/documents/review-queue', QUEUE, 'GET'),
    route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
    route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
    route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
    route(`/api/documents/${DOC}/invoices/total`, {
      status: 200,
      body: { success: true, openErrors: 0, openWarnings: 1, violations: [{ ...VIOLATION, severity: 'warning' }] },
    }, 'PATCH'),
    route('/api/documents?kind=invoice', { status: 200, body: { documents: [document()], total: 1 } }, 'GET'),
  ])
})

async function openReviewRow() {
  await userEvent.click(screen.getByRole('button', { name: /needs review/i }))
  await waitFor(() => expect(server.count('review-queue')).toBe(1))
  await userEvent.click(await screen.findByText('Acme hosting invoice'))
}

describe('DocumentManager review mode', () => {
  it('starts in the normal list and only switches source when the chip is clicked', async () => {
    render(<DocumentManager kind="invoice" />)
    await waitFor(() => expect(server.count('/api/documents?kind=invoice')).toBe(1))
    expect(server.count('review-queue')).toBe(0)
    await openReviewRow()
    expect(server.count('review-queue')).toBe(1)
  })

  it('shows the reason badges the queue computed', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    expect(await screen.findByText('open error')).toBeInTheDocument()
    expect(screen.getByText('needs review')).toBeInTheDocument()
  })

  it('shows the lowest field confidence in the queue column', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    expect(await screen.findByText('20%')).toBeInTheDocument()
  })

  it('loads findings and audit history when a review row opens', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await waitFor(() => expect(server.count(`/${DOC}/validation`)).toBe(1))
    await waitFor(() => expect(server.count(`/${DOC}/audit`)).toBe(1))
    expect(await screen.findByText('Subtotal plus tax does not equal the total.')).toBeInTheDocument()
    expect(screen.getByText('Field history')).toBeInTheDocument()
  })

  it('renders the total field as editable with a required reason while its error is open', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    expect(screen.getByText(/reason \(required\)/i)).toBeInTheDocument()
  })

  it('saves a correction and repaints from the response without a second validation call', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    await userEvent.type(screen.getByRole('textbox', { name: /^total$/i }), '1100.00')
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'vendor reissued the invoice')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.count(`/${DOC}/invoices/total`)).toBe(1))
    await waitFor(() => expect(screen.getByText(/1 warning still open/i)).toBeInTheDocument())
    expect(server.count(`/${DOC}/validation`)).toBe(1)
  })

  it('waives a finding with a reason and refetches the list', async () => {
    server = stubFetch([
      route('/api/documents/review-queue', QUEUE, 'GET'),
      route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
      route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
      route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
      route(`/validation/${VIOL}/waive`, { status: 200, body: { violation: { ...VIOLATION, status: 'waived' } } }, 'POST'),
    ])
    vi.stubGlobal('prompt', vi.fn(() => 'confirmed with the vendor by phone'))
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await userEvent.click(await screen.findByRole('button', { name: /waive/i }))
    await waitFor(() => expect(server.count('/waive')).toBe(1))
    await waitFor(() => expect(server.count(`/${DOC}/validation`)).toBe(2))
  })

  it('re-checks on demand and paints the newest findings', async () => {
    server = stubFetch([
      route('/api/documents/review-queue', QUEUE, 'GET'),
      route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
      route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
      route(`/api/documents/${DOC}/validation`, {
        status: 200, body: { documentId: DOC, rulesetVersion: 'v1', violations: [] },
      }, 'POST'),
      route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
    ])
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /re-check/i }))
    await waitFor(() => expect(screen.queryByText('Subtotal plus tax does not equal the total.')).not.toBeInTheDocument())
  })

  it('switching back to the full list leaves review mode without a stuck selection', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /all invoices/i }))
    await waitFor(() => expect(server.count('review-queue')).toBe(1))
    expect(screen.queryByText('Subtotal plus tax does not equal the total.')).not.toBeInTheDocument()
  })

  it('keeps the read-only detail when not in review mode', async () => {
    render(<DocumentManager kind="invoice" />)
    await waitFor(() => expect(server.count('/api/documents?kind=invoice')).toBe(1))
    await userEvent.click(await screen.findByText('Acme hosting invoice'))
    await waitFor(() => expect(server.count(`/${DOC}/invoice`)).toBe(1))
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    expect(server.count(`/${DOC}/validation`)).toBe(0)
  })
})
```

The last case is the one that protects the Knowledge tab: read-only detail means no `edit` affordance and no validation request at all. `editable` is false unless review mode is on.

Run: `npx vitest run tests/DocumentManagerReviewMode.test.tsx` from `D:\Code\CRUM\console`
Expected: FAIL, no `Needs review` chip exists yet.

- [ ] **Step 2: State, the chip, and the two list sources**

Add to the component body after :61:

```tsx
  const [reviewMode, setReviewMode] = useState(false)
  const [queue, setQueue] = useState<ReviewQueueItem[]>([])
  const [violations, setViolations] = useState<StoredViolation[]>([])
  const [auditRows, setAuditRows] = useState<AuditRow[]>([])
```

Replace `load` (:76) with a version that reads from whichever source review mode asks for, keeping the same name so the upload and review handlers still call it:

```tsx
  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      if (reviewMode) {
        const data = await getReviewQueue(`?kind=${kind}`)
        setQueue(data.items)
        setDocuments([])
      } else {
        const data = await get<ListResponse>(`/api/documents?kind=${kind}`)
        setDocuments(data.documents ?? [])
        setQueue([])
      }
    } catch (err) {
      setListError(describeError(err))
      setDocuments([])
      setQueue([])
    } finally {
      setLoading(false)
    }
  }, [kind, reviewMode])
```

The `useEffect(() => { void load() }, [load])` at :89 already re-fires when `load` identity changes, so toggling review mode refetches without another effect.

Render the chip beside the upload button, using the same `Button` and `variant` vocabulary the file already uses:

```tsx
  <Button
    variant={reviewMode ? 'default' : 'ghost'}
    size="sm"
    onClick={() => setReviewMode((m) => !m)}
  >
    {reviewMode ? `Needs review (${queue.length})` : 'Needs review'}
  </Button>
  {reviewMode && documents.length === 0 && queue.length > 0 ? (
    <Button variant="ghost" size="sm" onClick={() => setReviewMode(false)}>All {label.toLowerCase()}s</Button>
  ) : null}
```

The second button is what the `switching back` test clicks, and its `all invoices` / `all contracts` name comes free from `label`.

- [ ] **Step 3: One table, two row shapes**

The table header at :292 stays. Replace the body so review rows render the queue's own fields and normal rows keep today's markup:

```tsx
{reviewMode
  ? queue.map((item) => (
      <tr key={item.documentId} className="border-b border-border last:border-0">
        <td className="px-3 py-2">
          <button type="button" className="text-left text-text-primary hover:underline"
            onClick={() => void openDetail(item.documentId, item.title)}>
            {item.title}
          </button>
        </td>
        <td className="px-3 py-2"><Badge variant={statusVariant(item.status as CrmDocument['status'])}>{item.status}</Badge></td>
        <td className="px-3 py-2"><FieldConfidenceChip value={item.lowestFieldConfidence} /></td>
        <td className="px-3 py-2 text-text-muted">{item.reasons.map((r) => <span key={r} className="mr-1">{r}</span>)}</td>
        <td className="px-3 py-2 text-text-muted">{shortTime(item.createdAt)}</td>
      </tr>
    ))
  : documents.map((doc) => ( /* unchanged existing markup, with onClick={() => void openDetail(doc.id, doc.title)} */ ))}
```

Add a fifth column header `Findings` above the reasons cell so the header count matches the cells; the existing four headers plus it make five, which is what the review row renders.

- [ ] **Step 4: `openDetail` takes an id, and the detail pane asks for findings**

Rewrite :196 as:

```tsx
  async function openDetail(documentId: string, title: string) {
    setDetail(null)
    setDetailLoading(true)
    setViolations([])
    setAuditRows([])
    const suffix = isInvoice ? 'invoice' : 'contract'
    try {
      const data = await get<InvoiceDetail | ContractDetail>(
        `/api/documents/${encodeURIComponent(documentId)}/${suffix}`,
      )
      setDetail(data)
      setSelected(data.document)
      if (reviewMode) {
        const [validation, audit] = await Promise.all([
          getValidation(documentId),
          getAuditTrail(documentId),
        ])
        setViolations(validation.violations)
        setAuditRows(audit.audit)
      }
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setDetailLoading(false)
    }
  }
```

`selected` stays as it is, set from `data.document`, because `handleReview` (:213) and the detail header both read it and neither should change in this task. The `title` argument is used only to keep the pane's heading populated while the request is in flight; pass it to `setNotice`-free local state or drop the parameter if the existing header already reads `detail.document.title`. Do not fabricate a `CrmDocument` from a queue item anywhere in this file.

Because `openDetail` now needs a title before the fetch resolves, `setSelected` happens after it, and `DocumentDetail` already renders `detail ? detail.document.title : ''`, so nothing reads a stale selection during the load.

- [ ] **Step 5: Pass `editable` down and paint the findings**

`DocumentDetail` (:338) gains `editable`, `violations`, `onWaive`, `onCorrected` and renders the audit panel:

```tsx
      {editable && detail ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <AuditTrail rows={auditRows} onReload={() => void refreshAudit(detail.document.id)} />
          <Button variant="ghost" size="sm" onClick={() => void recheck(detail.document.id)}>re-check</Button>
        </div>
      ) : null}
```

with the two handlers in the parent:

```tsx
  async function recheck(documentId: string) {
    const data = await revalidateDocument(documentId)
    setViolations(data.violations)
    await load()
  }

  async function refreshAudit(documentId: string) {
    setAuditRows((await getAuditTrail(documentId)).audit)
  }

  async function waive(documentId: string, violationId: string, reason: string) {
    await waiveFinding(documentId, violationId, reason)
    setViolations((await getValidation(documentId)).violations)
    await load()
  }

  function applyCorrection(result: CorrectionResult) {
    setViolations(result.violations)
    if (selected) void refreshAudit(selected.id)
  }
```

`InvoiceView` (:384) and `ContractView` (:417) each gain `editable`, `violations`, `onCorrected` and `onWaive`, and swap their `<Field ... />` lists for the conditional shape below. Per-field confidence is not a prop: it is read from `detail.document.field_confidence`, keyed by the same snake_case column names the findings use. Only the invoice view is written out; the contract view is the identical eight lines with the contract columns, and it has no `lines.amount` block.

```tsx
type InvoiceViewProps = {
  detail: InvoiceDetail
  editable: boolean
  violations: StoredViolation[]
  onCorrected: (result: CorrectionResult) => void
  onWaive: (documentId: string, violationId: string, reason: string) => Promise<void>
}

function InvoiceView({ detail, editable, violations, onCorrected, onWaive }: InvoiceViewProps) {
  const inv = detail.invoice
  const conf = detail.document instanceof Object && 'field_confidence' in detail.document
    ? (detail.document as { field_confidence?: Record<string, number> | null }).field_confidence ?? null
    : null
  const row = (column: keyof InvoiceRecord, label: string, display: React.ReactNode) =>
    editable ? (
      <EditableField
        key={column}
        documentId={detail.document.id}
        tableName="invoices"
        field={String(column)}
        label={label}
        value={inv?.[column] == null ? '' : String(inv[column])}
        confidence={conf?.[String(column)]}
        findings={findingsFor(violations, String(column))}
        requiredReason={findingsFor(violations, String(column)).some((v) => v.severity === 'error' && v.status === 'open')}
        onCorrected={onCorrected}
        onWaive={(id, reason) => onWaive(detail.document.id, id, reason)}
      />
    ) : (
      <Field key={column} name={label} value={display} />
    )

  return (
    <div className="space-y-4">
      <div>
        {row('vendor_name', 'Vendor', inv?.vendor_name ?? '—')}
        {row('invoice_number', 'Invoice number', inv?.invoice_number ?? '—')}
        {row('invoice_date', 'Invoice date', inv?.invoice_date ?? '—')}
        {row('due_date', 'Due date', inv?.due_date ?? '—')}
        {row('currency', 'Currency', inv?.currency ?? '—')}
        {row('subtotal', 'Subtotal', money(inv?.subtotal))}
        {row('tax', 'Tax', money(inv?.tax))}
        {row('total', 'Total', <span className="font-semibold">{money(inv?.total)}</span>)}
      </div>
      {findingsFor(violations, 'lines.amount').length > 0 ? (
        <FindingList violations={findingsFor(violations, 'lines.amount')} onWaive={(id, r) => onWaive(detail.document.id, id, r)} />
      ) : null}
      {/* the existing Line items block stays below, unchanged */}
    </div>
  )
}
```

`documents.field_confidence` is keyed by the snake_case column names, which is what `normalizeAndResolveStep` writes at `src/mastra/workflows/document-intake.ts:475-479`, so the chip lookup and the finding lookup use the same key and need no mapping. `CrmDocument` in `console/lib/types.ts` does not yet declare that column: add `field_confidence?: Record<string, number> | null` to the interface, which is why the guard above reads `in` rather than trusting it.

- [ ] **Step 6: Run the review-mode suite and the existing one**

Run: `npx vitest run tests/DocumentManagerReviewMode.test.tsx tests/DocumentManager.test.tsx`
Expected: both PASS. The second is the regression gate: if an existing Knowledge or upload assertion breaks, `editable` leaked into the default path.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
cd console && npx tsc --noEmit && npx next lint
git add console/components/DocumentManager.tsx console/lib/types.ts console/tests/DocumentManagerReviewMode.test.tsx
git commit -m "feat(console): review mode queues, shows, corrects and waives on the document list"
```

---

### Task 17: Analytics panel and CSV export

**Files:**
- Create: `console/components/ReviewAnalytics.tsx`
- Modify: `console/components/DocumentManager.tsx` (mount the panel behind one toggle)
- Create: `console/tests/ReviewAnalytics.test.tsx`

**Interfaces:**
- Consumes: `getReviewAnalytics`, `ReviewAnalytics` from `console/lib/review.ts` (Task 14); `describeError` from `console/lib/api.ts:154`.
- Produces: the aggregate surface spec success criterion 6 names, and the download button for `GET /audit/export`.

Ruling R24. The panel is tables plus CSS width bars, per spec R7. Each bar is `style={{ width: n + '%' }}` on a div inside a fixed-track container, computed from `value / max(values) * 100`, so a zero maximum renders no bar rather than dividing by zero.

Ruling R25. The export button fetches with `fetch` directly rather than through `request`, because `request` parses JSON and a CSV body is not JSON. It builds an object URL and clicks a temporary anchor. In `console/tests/fetchStub.ts` every reply is `JSON.stringify`'d, so the test asserts the request the button made and that a download was triggered; it cannot assert file bytes. The byte-level assertions live in `tests/api/audit-export.test.ts` (Task 13) where a real Response exists.

- [ ] **Step 1: Write the failing test**

Create `console/tests/ReviewAnalytics.test.tsx`.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewAnalytics } from '../components/ReviewAnalytics'
import { route, stubFetch, type FetchStub } from './fetchStub'

const DATA = {
  window: { from: '2026-08-05', to: '2026-11-03', days: 90 },
  byRule: [
    { ruleId: 'invoice.total.sum', total: 12, open: 5, waived: 7 },
    { ruleId: 'invoice.currency.shape', total: 3, open: 3, waived: 0 },
  ],
  topFields: [{ field: 'total', corrections: 9, violations: 12 }],
  bySource: [{ changeSource: 'manual_correction', count: 20 }],
  correctionRate: { corrected: 4, documents: 10, rate: 0.4 },
  turnaround: { p50Hours: 3, p90Hours: 7.6 },
  confidenceTrend: [{ week: '2026-09-21', avgConfidence: 0.81, correctionRate: 0.5 }],
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET')])
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() }))
})

describe('ReviewAnalytics', () => {
  it('fetches on mount and names the window it used', async () => {
    render(<ReviewAnalytics kind={null} />)
    await waitFor(() => expect(server.count('analytics/review')).toBe(1))
    expect(await screen.findByText(/2026-08-05/)).toBeInTheDocument()
  })

  it('lists rules by volume with the open and waived counts beside them', async () => {
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    expect(screen.getByText('invoice.total.sum').closest('tr')).toHaveTextContent('12')
    expect(screen.getByText('invoice.total.sum').closest('tr')).toHaveTextContent('waived 7')
  })

  it('draws a bar whose width is relative to the largest rule', async () => {
    render(<ReviewAnalytics kind={null} />)
    const bars = await screen.findAllByTestId('bar')
    expect(bars[0]).toHaveStyle({ width: '100%' })
    expect(bars[1]).toHaveStyle({ width: '25%' })
  })

  it('prints the correction rate as a fraction before it prints a percentage', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/4 of 10 corrected/)).toBeInTheDocument()
    expect(screen.getByText(/40[.]0%/)).toBeInTheDocument()
  })

  it('shows a null rate as no data, not as zero', async () => {
    server = stubFetch([route('/api/documents/analytics/review', {
      status: 200, body: { ...DATA, correctionRate: { corrected: 0, documents: 0, rate: null }, turnaround: { p50Hours: null, p90Hours: null } },
    }, 'GET')])
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/no corrections yet/i)).toBeInTheDocument()
  })

  it('renders turnaround in hours with one decimal', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/3[.]0 h/)).toBeInTheDocument()
    expect(screen.getByText(/7[.]6 h/)).toBeInTheDocument()
  })

  it('passes the kind filter through to the query string', async () => {
    render(<ReviewAnalytics kind="contract" />)
    await waitFor(() => expect(server.last('analytics/review')?.url).toContain('kind=contract'))
  })

  it('exports by requesting the csv route for the same window', async () => {
    const clicked = vi.fn()
    const anchor = document.createElement('a')
    anchor.click = clicked
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'a' ? Object.assign(realCreate('a'), { click: clicked }) : realCreate(tag as never),
    )
    server = stubFetch([
      route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET'),
      route('/api/documents/audit/export', { status: 200, body: 'document_id,reason' }, 'GET'),
    ])
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.type(screen.getByRole('textbox', { name: /from/i }), '{select all}2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(server.count('audit/export')).toBe(1))
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
    expect(String(server.last('audit/export')?.url)).toContain('from=2026-10-01')
  })

  it('reports a too-many-rows refusal instead of downloading nothing quietly', async () => {
    server = stubFetch([
      route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET'),
      route('/api/documents/audit/export', { status: 400, body: { error: 'too_many_rows', max: 50000 } }, 'GET'),
    ])
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(await screen.findByText(/too many rows/i)).toBeInTheDocument()
  })

  it('accepts a narrower window from the form', async () => {
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.type(screen.getByRole('textbox', { name: /from/i }), '{select all}2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(server.last('analytics/review')?.url).toContain('from=2026-10-01'))
  })
})
```

Run: `npx vitest run tests/ReviewAnalytics.test.tsx`
Expected: FAIL, the component does not exist.

- [ ] **Step 2: The component**

Create `console/components/ReviewAnalytics.tsx`.

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

import { getReviewAnalytics } from '../lib/review'
import type { ReviewAnalytics as Analytics } from '../lib/review'
import { describeError } from '../lib/api'

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'no data' : (value * 100).toFixed(1) + '%'
}

function hours(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'no corrections yet' : value.toFixed(1) + ' h'
}

function Bar({ value, max }: { value: number; max: number }) {
  const width = max <= 0 ? 0 : Math.round((value / max) * 100)
  return (
    <span className="inline-block h-2 align-middle bg-accent" data-testid="bar"
      style={{ width: width + '%', minWidth: value > 0 ? '2px' : '0' }} />
  )
}

export function ReviewAnalytics({ kind }: { kind: 'invoice' | 'contract' | null }) {
  // Constraint 6's frame rule (R45), browser side: the day the operator means by "today" is their
  // own local day. A `toISOString()` read here would show yesterday for the first 11 hours of every
  // day on this machine, and the default window would silently stop a day short. `defaultFrom` below
  // stays in UTC because it both builds and renders there, which is the pair rule, not a third frame.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const [from, setFrom] = useState(defaultFrom(today))
  const [to, setTo] = useState(today)
  const [data, setData] = useState<Analytics | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      const query = '?from=' + from + '&to=' + to + (kind ? '&kind=' + kind : '')
      setData(await getReviewAnalytics(query))
    } catch (err) {
      setProblem(describeError(err))
      setData(null)
    } finally {
      setBusy(false)
    }
  }, [from, to, kind])

  useEffect(() => { void refresh() }, [refresh])

  const maxRule = data ? Math.max(0, ...data.byRule.map((r) => r.total)) : 0

  async function exportCsv() {
    setProblem(null)
    const query = 'from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + (kind ? '&kind=' + kind : '')
    const res = await fetch('/api/documents/audit/export?' + query, { headers: { Accept: 'text/csv' } })
    if (res.status === 204) { setProblem('Nothing in this window to export.'); return }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; max?: number } | null
      setProblem(body?.error === 'too_many_rows'
        ? 'Too many rows for one file (cap ' + body.max + '). Narrow the window.'
        : 'Export failed: ' + (body?.error ?? res.status))
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'field-audit-' + from + '-to-' + to + '.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-bg-card p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-text-muted">
          From
          <input className="ml-1 rounded border border-border bg-bg-raised px-2 py-1 text-sm"
            value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-text-muted">
          To
          <input className="ml-1 rounded border border-border bg-bg-raised px-2 py-1 text-sm"
            value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="text-xs underline" onClick={() => void refresh()} disabled={busy}>apply</button>
        <button type="button" className="text-xs underline" onClick={() => void exportCsv()}>export csv</button>
        {data ? <span className="text-xs text-text-muted">{data.window.from} to {data.window.to}</span> : null}
      </div>

      {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      {busy && !data ? <p className="text-sm text-text-muted">Loading review stats…</p> : null}

      {data ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <table className="w-full text-sm">
              <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Findings by rule</caption>
              <tbody>
                {data.byRule.map((r) => (
                  <tr key={r.ruleId}>
                    <td className="py-1">{r.ruleId}</td>
                    <td className="w-1/3 py-1"><Bar value={r.total} max={maxRule} /></td>
                    <td className="py-1 text-right tabular-nums">{r.total}</td>
                    <td className="py-1 text-right text-text-muted">open {r.open} · waived {r.waived}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="w-full text-sm">
              <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Most corrected fields</caption>
              <tbody>
                {data.topFields.map((f) => (
                  <tr key={f.field}>
                    <td className="py-1">{f.field}</td>
                    <td className="py-1 text-right tabular-nums">{f.corrections}</td>
                    <td className="py-1 text-right text-text-muted">{f.violations} findings</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="grid gap-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-text-muted">Corrected in window</dt>
              <dd>{data.correctionRate.corrected} of {data.correctionRate.documents} corrected, {pct(data.correctionRate.rate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Created to first correction</dt>
              <dd>{hours(data.turnaround.p50Hours)} median, {hours(data.turnaround.p90Hours)} p90</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Changes by source</dt>
              <dd>{data.bySource.map((s) => s.changeSource + ' ' + s.count).join(' · ') || 'none'}</dd>
            </div>
          </dl>

          <table className="w-full text-sm">
            <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By week</caption>
            <tbody>
              {data.confidenceTrend.map((w) => (
                <tr key={w.week}>
                  <td className="py-1">{w.week}</td>
                  <td className="py-1 text-right tabular-nums">{w.avgConfidence === null ? 'no data' : (w.avgConfidence * 100).toFixed(0) + '%'}</td>
                  <td className="py-1 text-right text-text-muted">corrected (lifetime) {pct(w.correctionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  )
}

function defaultFrom(today: string): string {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 89)
  return d.toISOString().slice(0, 10)
}
```

`defaultFrom` walks back 89 days from `to` because the server counts both ends: `Task 12` returns a 90-day inclusive window, and a client that subtracted 90 would ask for 91 and get `bad_range`.

The `no corrections yet` string appears in both `hours` branches the test exercises, so a tenant with findings but no corrections reads as "nobody has corrected anything", which is the truthful sentence, rather than as `0.0 h`, which is a lie about speed.

- [ ] **Step 3: Mount it**

In `DocumentManager`, add `const [showStats, setShowStats] = useState(false)` and one more ghost button beside the review chip:

```tsx
  <Button variant="ghost" size="sm" onClick={() => setShowStats((s) => !s)}>Review stats</Button>
```

and immediately after the list block:

```tsx
  {showStats ? <ReviewAnalytics kind={kind} /> : null}
```

`kind` is the component's own prop, already `'invoice' | 'contract'`, so the panel opens filtered to the page the reviewer is standing on.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run tests/ReviewAnalytics.test.tsx tests/DocumentManagerReviewMode.test.tsx tests/DocumentManager.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd console && npx tsc --noEmit && npx next lint
git add console/components/ReviewAnalytics.tsx console/components/DocumentManager.tsx console/tests/ReviewAnalytics.test.tsx
git commit -m "feat(console): review analytics with tables, css bars and a csv download"
```

---

### Task 18: Whole-phase verification

**Files:**
- Create: `FIELD_AUDIT_PHASE2_STATUS.md`
- Modify: `docs/superpowers/plans/2026-11-03-field-audit-phase2.md` (tick the checkboxes for the tasks that shipped)

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence the phase is judged on. Nothing else reads it.

- [ ] **Step 1: Full gate, in order, from a clean tree**

```bash
git status --porcelain
npx tsc --noEmit
npx eslint .
npx vitest run
npx vitest run --project integration
```

Expected: every command exits 0 except the one known baseline failure named in Global Constraint 10. Record its exact output rather than paraphrasing it. If `tests/evals/golden-gate.test.ts` is the only failure, that is the documented environmental break in `DOCUMENT_PROCESSING_STATUS.md` section 7 and the status file quotes both.

- [ ] **Step 2: Console gate**

From `D:\Code\CRUM\console`:

```bash
npx tsc --noEmit
npx vitest run
```

Expected: exit 0, and the DocumentManager suites still green, which is the assertion that review mode did not disturb the read-only path.

- [ ] **Step 3: Migration state**

Run:

```bash
npx tsx -e "
import { getDbClient } from './src/db/client.ts'
const c = getDbClient()
const v = await c.query('select version from crum_schema_migrations order by version desc limit 4')
console.log(v.rows)
const t = await c.query(\"select count(*)::int as n from information_schema.tables where table_name = 'document_validation'\")
console.log(t.rows)
"
```

Expected: `0024` present and `n` equals 1.

- [ ] **Step 4: One real document, end to end**

This is the step that decides whether the phase works, and it cannot be satisfied by a green suite. With the server on `:4113` and the console on `:3100`:

1. Upload a text invoice whose subtotal, tax and total do not add up, through the console, and wait for it to leave `processing`.
2. Confirm the row appears in `Needs review` without clicking anything else, and that the reason badges name an open error.
3. Open it, confirm the `total` row shows a chip and the finding text, click edit, try to save with no reason, and confirm the panel refuses before any request goes out (watch the network tab; there must be no `PATCH`).
4. Enter a reason, save, and confirm the finding disappears and the audit panel shows the struck old value with `manual correction` and the reason typed.
5. Re-open a second document that still has the error, waive the finding with a reason, and confirm it reads `waived: <reason>` and that the document leaves the queue.
6. Open `Review stats`, confirm `invoice.total.sum` appears with a nonzero bar, that the correction count moved by one, and that `export csv` downloads a file that Excel or a text editor opens with the reason column intact.
7. `GET /api/documents/:id` for that document and confirm no `invoice_field_confidence` or `contract_field_confidence` key appears anywhere in the body (H3).

If any step cannot be performed, say so in the status file with the reason. Do not describe a step as passing that was only covered by a unit test; the standing rule on this project is that a feature is complete when it has been run, not when it has been written.

- [ ] **Step 5: Write `FIELD_AUDIT_PHASE2_STATUS.md`**

Five sections, no prose padding:

1. **What shipped** — one line per spec section: rules engine with 19 rules, `document_validation`, intake wiring, six routes, review mode, analytics, export, and the five housekeeping fixes H1 to H5.
2. **What was verified how** — the commands from Steps 1 to 4 with their real exit codes, and for step 4 which of the seven sub-steps were seen in a browser.
3. **Known failures** — `tests/evals/golden-gate.test.ts` and its environmental cause, verbatim output, plus anything else that failed and was not fixed.
4. **Rulings with their cost** — R9 through R25 in one line each: the decision and what it costs if wrong. This is the section a future reader needs when a ruling stops holding.
5. **Deferred** — the two Phase 1 candidates this phase declined (retroactive backfill, model per-field confidence), turnaround containing queue wait while the async backlog is live, offset paging in the queue, and no analytics beyond the six keys.

- [ ] **Step 6: Tick the plan and commit**

Set every `- [ ]` in this file to `- [x]` for the tasks that shipped, leave any that did not unticked, and say which in the commit body.

```bash
git add FIELD_AUDIT_PHASE2_STATUS.md docs/superpowers/plans/2026-11-03-field-audit-phase2.md
git commit -m "docs(field-audit): phase 2 status records what shipped and what was only tested"
```

- [ ] **Step 7: Report, do not merge**

Summarise for the human partner: the commits on the branch, the verification evidence, the known failure, and the rulings. Stop there. Pushing, merging and opening a pull request are their decisions, not this plan's.

---







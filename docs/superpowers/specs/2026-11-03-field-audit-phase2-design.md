# Field Audit Phase 2: Validation Rules Engine and Review Surface

**Date:** 2026-11-03
**Status:** Self-reviewed. The user review gate is waived by the standing instruction to decide
autonomously and not ask again during a long run (recorded 2026-11-03).
**Predecessor:** `docs/superpowers/specs/2026-11-03-field-audit-phase1-design.md`

## 1. Summary

Phase 1 stores per-field confidence and a field-level audit trail, and it exposes endpoints to read
the trail and to correct a field. Nothing reads them and nothing corrects through them. Phase 2 adds
the missing piece in both directions: a validation rules engine that decides which extracted values
are wrong or doubtful, and the review surface where a human sees those findings next to the
confidence numbers and fixes them.

The unit of value is the closed loop. Validating without a surface would create a fourth dataset with
no consumer, which is the exact defect Phase 1 shipped.

## 2. Evidence for the scope

Every row below was read from the tree at commit `ff568b0`, not from memory.

| # | Finding | Source |
| --- | --- | --- |
| E1 | No validation logic of any kind runs over extracted invoice or contract values. The only predicates in the tree are email and phone shape checks inside the uncommitted transformation pipeline. | `src/mastra/schemas/documents.ts`, `src/transforms/` |
| E2 | `GET /api/documents/:id/audit` exists and works. No console component calls it. | `src/api/documents.ts:320`, `console/` (zero matches) |
| E3 | `PATCH /:id/invoices/:field` and `PATCH /:id/contracts/:field` exist and work. No console component calls them. | `src/api/documents.ts:425`, `src/api/documents.ts:429` |
| E4 | `InvoiceView` and `ContractView` render read-only text. There is no input anywhere in the review path. | `console/components/DocumentManager.tsx:384`, `:417` |
| E5 | The document list shows document-level confidence only. The stored per-field confidence is never shown. | `console/components/DocumentManager.tsx:309` |
| E6 | `status='needs_review'` is produced by a single document-wide threshold, so a document whose total is garbage and whose prose is confident passes. | `src/mastra/workflows/document-intake.ts:26`, `:504` |
| E7 | Every extracted column on `invoices`, `contracts`, `invoice_lines` and `contract_terms` is nullable. A document that extracted almost nothing still reaches `ready`. | `migrations/0009_crum_documents.sql:54-102` |
| E8 | The audit trail records `changed_by`, `change_source` and `reason`, so correction counts are already computable. Phase 2 reads them instead of building a parallel record. | `migrations/0023_crum_field_audit.sql:5-20` |

## 3. Scope ruling

Phase 1 section "Future Enhancements" listed six candidates. This is the disposition of each.

| Phase 1 item | Phase 2 | Reason |
| --- | --- | --- |
| 6. Validation rules engine | In. Layer 1 and 2. | Phase 1 labels it the Phase 2 feature. It is the only item that produces new findings rather than new views. |
| 1. Audit trail UI | In. Layer 6. | E2 and E3. The data is dead until a person sees it. Driver: reduce manual review overhead. |
| 2. Audit analytics | In, limited to three aggregates with a computable definition. | Section 11. Compliance reporting needs numbers, not charts. |
| 3. Audit export | In as CSV only. | A compliance officer opens a CSV. PDF needs a renderer dependency for no additional authority. |
| 4. Retroactive backfill | Out. | Phase 1 already marks it conditional ("if needed"). Nothing has asked, and a backfill of an audit table would invent provenance. |
| 5. Field-level confidence from model | Out. | No provider in use returns per-field confidence. Phase 1's computed per-field confidence already fills the slot. |

Ruling R1. The console work integrates into the existing document review flow rather than standing up a
separate dashboard. Managing documents and reviewing extracted values are different jobs, but a second
list of the same documents is worse than one page that grows a review mode.
Cost if wrong: `console/components/DocumentManager.tsx` becomes a large component, and a later split is
rework.

## 4. Architecture

Six layers, each independently testable.

```
intake workflow ──> rules engine ──> document_validation rows
                                          │
   REST surface <── reads both tables <───┘
        │
   console review mode <── corrects via Phase 1 PATCH
```

1. Rules engine. Pure TypeScript. No database, no clock, no I/O.
2. Rule catalogue. Data, not control flow. Adding a rule is adding an entry.
3. Persistence. New table `document_validation` plus one write function.
4. Intake wiring. One new workflow step and one new reason to set `needs_review`.
5. REST surface. Validation read, validation re-run, waiver, review queue, analytics, CSV export.
6. Console review mode. Per-field confidence, per-field findings, inline correction, audit trail.

## 5. Layer 1: rules engine

New directory `src/validation/`. Nothing in it imports `pg`, `process.env`, or `Date`.

### 5.1 Types

```ts
// src/validation/types.ts
export type Severity = 'error' | 'warning'

export interface Violation {
  ruleId: string
  field: string
  severity: Severity
  message: string
  details?: Record<string, string | number>
}

export interface ValidationContext {
  /** ISO date, injected so a rule that needs today is testable without a clock. */
  today: string
}

export interface DocumentRecordBundle {
  kind: 'invoice' | 'contract'
  invoice?: Record<string, string | null>
  contract?: Record<string, string | null>
  lines: Array<Record<string, string | null>>
  terms: Array<Record<string, string | null>>
}

export interface ValidationRule {
  id: string
  appliesTo: 'invoice' | 'contract'
  /** Columns the rule reads. The review surface uses this to place a finding on a field. */
  fields: string[]
  run(bundle: DocumentRecordBundle, ctx: ValidationContext): Violation[]
}
```

### 5.2 Entry point

```ts
// src/validation/index.ts
export const RULESET_VERSION = 'v1'
export function evaluate(bundle: DocumentRecordBundle, ctx: ValidationContext): Violation[]
```

`evaluate` runs every rule whose `appliesTo` matches `bundle.kind`, drops rules whose subject row is
absent, sorts by severity then ruleId then field, and removes exact `(ruleId, field)` duplicates. The
sort is total so the same input always yields the same array, which is what makes the stored rows
diffable.

### 5.3 Value handling rules

| Rule | Detail |
| --- | --- |
| Numbers | `pg` returns `numeric` as a string. Parse with `Number(v)`. Treat `''`, `null`, and `NaN` as absent, never as zero. |
| Dates | Compare ISO strings or `Date.parse`. Never compare a locale string. |
| Amount tolerance | Arithmetic rules allow 0.01 absolute. Two rounding errors in a real invoice are normal, and a rule that fires on them trains reviewers to ignore the panel. |
| Absent is not a violation | A rule with a missing subject value stays silent, except a `*.present` rule, whose whole job is to fire on absence. |
| Currency | Shape only: `^[A-Za-z]{3}$`. See ruling R10. |

Ruling R10. The currency check is a shape check, not membership in an ISO 4217 table.
Why: a membership list is either the full 176-code register, which the no-new-dependency rule means
transcribing by hand and which then produces false warnings from the transcription itself, or it is a
curated subset, which warns on a real currency of any tenant outside that subset. Both failure modes
train a reviewer to ignore the panel, the exact harm the 0.01 tolerance above exists to avoid. A code
that is three letters but unknown still shows beside its confidence chip, so the information is not
lost. Cost if wrong: `XYZ` from an OCR slip passes the engine and is caught by eye.

## 6. Layer 2: rule catalogue

19 rules in `src/validation/rules.ts`. `field` is the column the reviewer must fix. A composite finding
is pinned to the field that is arithmetically wrong, which is `total` for the sum rule.

| # | ruleId | Applies | fields | Severity | Fires when |
| --- | --- | --- | --- | --- | --- |
| 1 | `invoice.invoice_number.present` | invoice | invoice_number | error | invoice_number is absent |
| 2 | `invoice.vendor_name.present` | invoice | vendor_name | error | vendor_name is absent |
| 3 | `invoice.total.present` | invoice | total | error | total is absent |
| 4 | `invoice.currency.shape` | invoice | currency | warning | currency is present and is not three ASCII letters |
| 5 | `invoice.total.nonnegative` | invoice | total | error | total parses and is less than 0 |
| 6 | `invoice.total.range` | invoice | total | warning | total parses and is greater than or equal to 100000000 |
| 7 | `invoice.total.sum` | invoice | total | error | subtotal, tax and total all parse and abs(subtotal + tax - total) > 0.01 |
| 8 | `invoice.invoice_date.present` | invoice | invoice_date | error | invoice_date is absent |
| 9 | `invoice.invoice_date.future` | invoice | invoice_date | warning | invoice_date is after ctx.today |
| 10 | `invoice.due_date.order` | invoice | due_date | error | due_date is before invoice_date and both are present |
| 11 | `invoice.vendor_email.format` | invoice | vendor_email | warning | vendor_email is present and is not a valid address |
| 12 | `invoice.lines.amount` | invoice | lines.amount | warning | a line has quantity and unit_price whose product differs from amount by more than 0.01 |
| 13 | `invoice.lines.present` | invoice | lines.amount | warning | kind is invoice, total is present, and lines is empty |
| 14 | `contract.counterparty.present` | contract | counterparty | error | counterparty is absent |
| 15 | `contract.currency.shape` | contract | currency | warning | currency is present and is not three ASCII letters |
| 16 | `contract.value.nonnegative` | contract | contract_value | error | contract_value parses and is less than 0 |
| 17 | `contract.date.order` | contract | expiry_date | error | expiry_date is before effective_date and both are present |
| 18 | `contract.term.range` | contract | term_months | warning | term_months parses and is outside 1 to 600 |
| 19 | `contract.counterparty_email.format` | contract | counterparty_email | warning | counterparty_email is present and is not a valid address |

Two further contract rules are deliberately absent. `contract.value.present` is left out because a
quote or an NDA legitimately carries no money, and an error on every NDA would flood the queue.
`contract.renewal_notice_days.range` is left out because a nil notice period is a real contract, not a
parse failure.

### 6.1 Field naming and which findings are correctable

A `field` is normally an `invoices` or `contracts` column and is therefore correctable through the Phase
1 `PATCH` routes. Rules 12 and 13 use the qualified name `lines.amount`, which points at `invoice_lines`
rather than the header. The review surface renders a qualified finding inside the Line items block, and
it is display only. Phase 2 corrects header fields and does not add a line-level `PATCH`.

Ruling R3. Line findings are advisory.
Why: per-line correction needs a new route, a new field whitelist, and a line identity in the audit
trail, and rule 12 fires on a warning precisely because a wrong line rarely changes the total. Cost if
wrong: a reviewer sees a bad line and can only fix it by re-parsing the whole document.

Ruling R2. Severity is fixed per rule in the catalogue, not configurable per tenant.
Why: a tenant-tunable severity makes `byRule` counts incomparable across tenants, which is the point of
the analytics layer. Cost if wrong: an enterprise tenant that wants `currency.shape` promoted to an
error needs a migration and a redeploy instead of a settings toggle.

## 7. Layer 3: persistence

### 7.1 Migration `migrations/0024_crum_field_validation.sql`

```sql
CREATE TABLE IF NOT EXISTS document_validation (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
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
  CONSTRAINT uq_validation_slot UNIQUE (document_id, rule_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_validation_doc_status ON document_validation (document_id, status);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_rule ON document_validation (tenant_id, rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_field ON document_validation (tenant_id, field_name, created_at DESC);
```

Ruling R4. Rows, not a `jsonb` column on `documents`.
Why: analytics groups by `rule_id` and `field_name` across every document in a tenant, and export
selects a date slice. A `jsonb` column forces `jsonb_array_elements` in every aggregate and a GIN index
that cannot order by `created_at`.
Cost if wrong: an insert-and-delete per validation run costs more writes than one column update. At
19 rules per document this is tens of rows, which is nothing.

`uq_validation_slot` is what makes the replace path idempotent. One live finding per rule per field.

### 7.2 Write path, `src/db/validation.ts`

| Function | Contract |
| --- | --- |
| `replaceValidation(documentId, tenantId, violations, rulesetVersion)` | In one transaction: upsert each violation on `uq_validation_slot` setting severity, message and `created_at`, but only `WHERE document_validation.status = 'open'`, so a waived row is never reopened by a re-run. Then delete open rows whose `(rule_id, field_name)` is absent from the new set. Waived rows for rules that no longer fire are left alone. |
| `listViolations(documentId, tenantId)` | All rows for the document, ordered by severity then rule_id. |
| `waiveViolation(violationId, tenantId, userId, reason)` | Set `status='waived'`, `waived_by`, `waived_at`, `waiver_reason`. Conditional on `status='open'`. Returns the row or null. |
| `countOpenErrors(documentIds, tenantId)` | Map of document id to open error count, for the queue. |

Ruling R5. A waiver is not deleted on re-run and a resolved finding is deleted.
Why: the violation disappearing on its own is indistinguishable from the field being corrected. Keeping
the waived row is what makes an override an auditable act with a name and a reason on it.
Cost if wrong: a waiver for a rule that no longer exists lingers. That is a row nobody reads, which is
cheaper than losing an override.

### 7.3 Read path

`document_validation` carries `tenant_id` directly, so every query takes the tenant predicate, matching
the isolation rule already enforced in `src/db/documents.ts`. The `tenant_id` is written from the
caller's identity, never copied from the document row, so a mismatch is caught at the WHERE clause
rather than silently inherited.

## 8. Layer 4: intake wiring

### 8.1 New workflow step

`src/mastra/workflows/document-intake.ts` gains `validateStep` after persistence and before the status
decision. It reads the persisted bundle through the existing `getInvoice` and `getContract` accessors,
calls `evaluate`, and writes with `replaceValidation`.

The step is additive to the workflow output: `{ validationCount: number }`. Existing consumers
(`src/queue/intake-run.ts`, the processing dashboard) read known keys and ignore an extra one.

### 8.2 New reason to review

| Condition today | Condition after Phase 2 |
| --- | --- |
| `needsReview = inputData.needsReview OR confidence < 0.7` | `needsReview = inputData.needsReview OR confidence < 0.7 OR openErrorCount > 0` |

A document with a total that does not equal subtotal plus tax is now queued even when the model reported
high confidence. Warnings alone do not queue a document, because a currency the tenant does not use is
not a reason to block an otherwise clean invoice.

### 8.3 Re-validation after a correction

The Phase 1 correction handler gains one call: after the `UPDATE` commits its field write, re-run
`evaluate` for that document and replace. This is what drains the queue. The re-run happens inside the
same dedicated `PoolClient` transaction as the correction, so a reviewer who corrects a total and gets
`200 OK` cannot be looking at a stale finding when the panel repaints.

Ruling R6. Re-validation runs inside the correction request, not on a timer or a worker.
Why: a reviewer fixes a field and the panel must clear immediately, or the reviewer assumes the fix did
not land. Cost if wrong: a correction request carries the cost of one evaluation and a handful of row
writes, which is negligible, but it does couple the two. If a ruleset changes, stored findings go stale
and nothing re-runs them. That is the reason for the explicit `POST /:id/validation` route.

## 9. Layer 5: REST surface

All routes mount inside the existing documents app in `src/api/documents.ts`, behind the same `auth(c)`
gate, so `src/api/index.ts` is untouched. That file currently carries uncommitted work from the async
processing roadmap and stays out of this phase.

| Method and path | Purpose | Success shape | Errors |
| --- | --- | --- | --- |
| `GET /:id/validation` | Read stored findings | `{ documentId, rulesetVersion, violations: [...] }` | 400 bad uuid, 404 not found |
| `POST /:id/validation` | Re-run rules now | same shape as above | 400, 404 |
| `POST /:id/validation/:violationId/waive` | Override one finding | `{ violation }` | 400 missing reason, 404, 409 already waived |
| `GET /review-queue` | The work list | `{ items: [...], total }` | 400 bad filter |
| `GET /analytics/review` | Aggregate counts | section 11 shape | 400 bad range |
| `GET /audit/export` | CSV of the audit trail | `text/csv` | 400 bad range, 204 empty |

### 9.1 Review queue

`GET /review-queue` takes `kind`, `severity`, `limit` (default 50, max 200) and `offset` (default 0). An
item is a document whose `status='needs_review'` or which has at least one open finding:

```ts
interface ReviewQueueItem {
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
```

Order is `openErrors DESC, lowestFieldConfidence ASC NULLS LAST, created_at ASC`. Errors first, because
an arithmetic failure is a known defect, whereas low confidence is only a suspicion. Oldest first inside
a tier, because the queue is a work list and a stale document is still stale.

`lowestFieldConfidence` is `min` over the JSONB values of `documents.field_confidence`, computed with
`jsonb_each`. Documents with no per-field confidence sort with `NULLS LAST` in their error tier.

Ruling R9. Offset paging, not keyset. Why: the first sort key is a count that changes whenever anyone
corrects anything, so a keyset cursor over it is not stable in the first place, and a review queue
carries tens of items. Cost if wrong: a document corrected between two page fetches can appear twice.
The panel dedupes on `documentId`, which hides it.

### 9.2 Waiver body

`reason` is required and trimmed to at least 8 characters. A waiver with no reason is the compliance
failure the whole feature exists to prevent, so the API refuses it rather than storing an empty string.

### 9.3 CSV export

`GET /audit/export?from=&to=&change_source=&kind=`. Columns in this fixed order:

```
document_id,document_title,table_name,field_name,action,old_value,new_value,
changed_by,changed_at,change_source,reason
```

RFC 4180 quoting. Fields containing a comma, a quote, or a newline are wrapped in double quotes and
interior quotes are doubled. A UTF-8 BOM leads the body so Excel opens a reason column containing
typographic quotes without mangling it. `Content-Disposition: attachment; filename="field-audit-<from>-<to>.csv"`.
Scope is the caller's tenant and nothing else. Cap is 50000 rows; over the cap the response is 400 with
`{ error: 'too_many_rows', max: 50000 }` rather than a truncated file, because a silently short CSV is
worse than no CSV in a compliance context.

## 10. Layer 6: console review mode

`console/components/DocumentManager.tsx` gains a review mode. It stays the single document surface.

| Change | Detail |
| --- | --- |
| Queue entry | The existing document list gains one filter chip, `Needs review`, which switches its source from `GET /` to `GET /review-queue`. It is the same list, the same selection and the same detail pane, not a second page. |
| Per-field row | Each field shows value, per-field confidence chip, and any finding whose `field` matches that column. Confidence colour follows the existing threshold at `document-intake.ts:26`. A finding on `lines.amount` renders inside the Line items block. |
| Inline correction | Editing a field sends `PATCH /:id/invoices/:field` with a reason. Reason is required when the field carries an open error and optional otherwise. |
| Audit panel | `GET /:id/audit` rendered as a compact diff list: old value struck, new value, who, source, reason, timestamp. |
| Waive | A finding row offers waive, which prompts for the reason and posts it. |
| Re-validate | After a correction the panel calls `POST /:id/validation` and repaints. |

`InvoiceView` and `ContractView` gain one prop, `editable`, and the read-only path stays the default so
the existing Knowledge tab is unchanged in behaviour.

Ruling R7. No chart library. The analytics panel is tables and CSS bars.
Why: `package.json` on this branch carries no chart dependency, and adding a renderer to draw three bar
charts is the kind of dependency this repo has avoided so far. Cost if wrong: a prettier dashboard
later, which is additive.

## 11. Analytics

`GET /analytics/review?from=&to=&kind=`. Every number below has exactly one computable definition. The
window defaults to 90 days and is capped at 365.

| Key | Definition | Source |
| --- | --- | --- |
| `byRule[]` | `{ ruleId, total, open, waived }` grouped over `document_validation` in the window | `document_validation` |
| `topFields[]` | `{ field, corrections, violations }` for the 10 fields with the most corrections | corrections from `document_field_audit`, violations from `document_validation` |
| `bySource[]` | `{ changeSource, count }` grouped over audit rows in the window | `document_field_audit` |
| `correctionRate` | distinct `document_id` in the window having at least one `manual_correction` audit row, divided by documents of the matching kind whose `created_at` falls in the window. A zero denominator yields `null`, not `0` and not a divide error. | both |
| `turnaround` | `percentile_cont(0.5)` and `percentile_cont(0.9)` of `MIN(manual_correction changed_at) - documents.created_at`, in hours, over corrected documents | both |
| `confidenceTrend[]` | per ISO week `{ week, avgConfidence, correctionRate }` | `documents`, `document_field_audit` |

`corrections` counts audit rows with `change_source='manual_correction'`. This is the metric the
compliance story is actually about, and Phase 1 already records it, so nothing new is instrumented.

Ruling R8. Turnaround is measured from `documents.created_at`, not from an intake-complete timestamp.
Why: there is no such column, and inventing one to answer a question answerable with `created_at` is
scope creep. Cost if wrong: turnaround includes queue wait, so it reads high while the async backlog is
large.

## 12. Housekeeping carried from Phase 1

These are defects Phase 1 reviews recorded and did not fix, plus two the Phase 2 read surfaced. Phase 2
fixes all five because the review surface it builds exercises exactly these paths, and because H4
corrupts the numbers in section 11.

| # | Defect | Location | Fix |
| --- | --- | --- | --- |
| H1 | The TS union says `re_parse` while the shipped SQL `CHECK` allows `re-parse`. Any caller that passes the TS value aborts the write, because the trigger raises a constraint violation inside the transaction. | `src/db/audit-context.ts:5`, `tests/db/audit-context.test.ts:49` vs `migrations/0023_crum_field_audit.sql:18` | Change the TS literal to `re-parse`. The committed migration is the authority; widening a shipped `CHECK` costs a migration for a string nobody has ever written. |
| H2 | The reason stamp matches `MAX(changed_at)` for a field, so two corrections in the same instant can stamp the wrong row. | `src/api/documents.ts:410` | Stamp by the row id returned from the update path: capture `id` from the audit insert with a `RETURNING`-based lookup on the same connection. |
| H3 | The list and detail queries leak internal join columns for field confidence. | `src/api/documents.ts:253-290` | Project the response explicitly. |
| H4 | `set_config(name, value, false)` is **session** scoped, not transaction scoped. `handleCorrection` sets `app.current_user_id` and `app.change_source` on a dedicated `PoolClient` and then releases it back to the pool without clearing either. The next borrower of that physical connection runs its writes attributed to the previous requester, so the audit trail records a correction by a user who did not make it. | `src/api/documents.ts:400-401`, `src/db/audit-context.ts:10-14` | Use `set_config(name, value, true)`, which is transaction local and resets at `COMMIT` or `ROLLBACK`. Both call sites already open a transaction. Add a DB test that runs two corrections on one connection and asserts the second is not attributed to the first. |
| H5 | `src/db/audit-context.ts` is imported only by its own test. No production path calls it, because `handleCorrection` inlines the two queries. | `src/db/audit-context.ts` | Make `setAuditContext(client, context)` take the `PoolClient` and use it from `handleCorrection`. That kills H4 at one site instead of two and removes the duplication. |

H4 is not cosmetic for this phase. The analytics layer counts audit rows with
`change_source='manual_correction'`, so a leaked session variable inflates `correctionRate` and
`topFields` with another requester's identity.

## 13. Testing

| Layer | Kind | Coverage target |
| --- | --- | --- |
| Rules engine | Unit, no DB | One case per rule that fires, one that stays silent, plus one compliant invoice and one compliant contract yielding zero violations. `ctx.today` is always injected, so no test reads the wall clock. |
| `replaceValidation` | DB test against real PostgreSQL, matching `tests/db/field-audit.test.ts` | Insert, replace, delete-of-stale, preservation-of-waiver, tenant isolation. |
| Waiver | API test | Reason required, 8 char minimum, 409 on an already waived row, cross-tenant 404. |
| Review queue | API test | Ordering contract, error tier presence, `NULLS LAST` for documents without per-field confidence, offset paging, max limit clamp. |
| Intake wiring | Workflow test | A document with a broken sum reaches `needs_review` with high confidence. A warning-only document does not. |
| Correction re-validation | Integration | Correct the total, and the sum finding clears in the same response cycle. |
| CSV export | Unit on the serialiser plus an API header test | Quoting of comma, quote and newline, BOM, `Content-Disposition`, row cap 400, tenant scoping. |
| Analytics | DB test | Each number computed against a fixture with known answers. `correctionRate` at 0 documents reviewed must not divide by zero. |
| Console | Component tests | Review mode fetches, per-field chip rendering, PATCH payload carries the reason, waive prompt, audit panel renders old and new. |

The gate for every task is the same as Phase 1: root typecheck, root lint, the touched test files, then
the full root suite and the console suite at the end.

## 14. Out of scope

1. Retroactive backfill of findings for documents already at `ready`. The explicit re-validate route
   covers a tenant that wants them.
2. Per-model confidence. No provider in use returns it.
3. Rules authored by tenants. R2 fixes severity per rule.
4. PDF export.
5. A rule editor UI.
6. Suppression lists per customer or per vendor.
7. Any change to the async processing roadmap. Its uncommitted files are preserved untouched, except
   where section 15 says otherwise.

## 15. Risks and integration notes

| # | Risk | Handling |
| --- | --- | --- |
| P1 | The working tree carries a large body of uncommitted work from the async processing roadmap, including `console/components/DocumentManager.tsx`, `src/api/index.ts`, `package.json`, and every file under `src/queue`, `src/temporal`, `src/transforms`, `services/ocr`. | Before Phase 2 Task 1, that work is checkpointed as its own commit on `feat/marketing-slice-5`, with a message naming it as pre-existing work preserved rather than authored here. Without that, every Phase 2 commit sweeps it up. |
| P2 | Phase 2 edits `DocumentManager.tsx`, which is the same file the async roadmap edits. | Unavoidable under R1. The checkpoint at P1 makes the conflict a normal three-way merge instead of an untracked overwrite. |
| P3 | `tests/evals/golden-gate.test.ts` already fails on this machine for an environmental reason recorded in `DOCUMENT_PROCESSING_STATUS.md` section 7. | Recorded as a known baseline failure before Task 1. It is not treated as a Phase 2 regression, and the exception is stated in the final report rather than hidden. |
| P4 | Adding `openErrorCount > 0` to the review decision changes intake outcomes for documents that would previously have reached `ready`. | Intended, and it is the point of E7. Called out in the completion report so the count of newly queued documents is visible rather than surprising. |
| P5 | `numeric(4,3)` caps `documents.confidence` at 9.999, which is irrelevant here but means any new confidence column must use the same type. | The plan reuses the existing column and adds none. |

## 16. Success criteria

1. Every rule in section 6 has a unit test that fires it and a test that keeps it silent.
2. A document with `subtotal + tax != total` reaches `needs_review` even at confidence 0.95, and the
   stored finding names `invoice.total.sum` and `total`.
3. The console shows per-field confidence, findings, the audit trail, and accepts a correction, in one
   surface, against a running API.
4. A waiver stores who, when and why, and survives a re-run of the same rule.
5. `GET /analytics/review` returns all six keys with numbers matching a seeded fixture.
6. `GET /audit/export` produces an RFC 4180 file that Excel opens correctly, scoped to the caller's
   tenant.
7. H1 is fixed, so `changeSource: 're-parse'` no longer aborts a write.
8. H4 is fixed, and a DB test proves two corrections on one pooled connection are attributed to their
   own requesters.
9. Root typecheck, root lint, full root suite, console typecheck, console lint and console suite pass,
   with the P3 baseline failure named in the report.

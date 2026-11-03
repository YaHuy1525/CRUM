# Task 19 report, the slice verification report

## What changed

One file, and no code. `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md`,
461 lines, committed at `1571f8b` with `git add -f` because `docs/` is gitignored but tracked. Nothing
under `src`, `tests`, `console`, `scripts`, `migrations` or `policy` was touched by this task, and the
code at `3a7d573` is byte-identical to `1d85f96` across all six of those directories, which is the
proof that the measurements below describe the tree the slice left rather than a tree this task moved.

## Why the controller wrote it

The brief assumes a dispatched implementer. The dispatch could not start: `C:` was full at the moment
of the attempt, 1.5 GB free of 297 GB, and a subagent needs the system drive for its scratch space
whatever drive the repository lives on. Nothing was deleted to make room. The deliverable lives on
`D:`, so the work continued in the main session and this report says so rather than implying a
hand-off happened. The drive now shows 13 GB free, which is why the independent review in
`task-19-review-1.md` could be dispatched after the fact.

## What ran, and the exact commands

Unit, measured per directory rather than as one big run, so a red in one lane cannot hide a green in
another: `npx vitest run tests/marketing`, `tests/db`, `tests/api`, `tests/config`, `tests/governance`,
`tests/mastra`. The counts are in the verification report's section 5. The five marketing-lane
directories sum to 1091 passed plus 1 todo. Slice 4's baselines for the same directories are in the
report's table.

Root gates: `npm run typecheck` exit 0, `npm run lint` exit 0. Console: `npm run lint` exit 0,
`npx tsc --noEmit` exit 0, and the console suite at 26 files and 223 tests.

Integration, with `export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"`
set in the same shell, every file run alone first and then together. The plan named ten files, all ten
were run, and then the other fourteen in the lane were run as well because a verification report that
stops at a plan's arbitrary list inherits the plan's blind spots.

Not run, and named as not run: `npm run verify`, because it chains `npm run test` and exits non-zero in
this repository by design, and `tests/evals/golden-gate.test.ts`, because it spends roughly twelve
model-minutes of the owner's paid credit and the brief does not ask for it.

## The re-measurement, which is the part that mattered

Every number the report cites was measured at this HEAD with a runner rather than remembered. That
changed several of them. A static `grep -c "it("` gives 55 cases for `tests/marketing/site.test.ts`
against the runner's 88, and 12 for the guard file against 22, so all case counts in the report come
from `--reporter=json` output parsed for `assertionResults`, with the helper kept as scratch and not
committed.

The first combined thirteen-file integration run reported 4 failed files and 8 failed tests. The
sequential run and the repeat run both reported 3 and 6. `document-audit-flow.test.ts` was red once and
green immediately after against the same database, so the report states the interference rather than
picking the friendlier number, and it records the habit that integration files in this repository are
run one at a time before they are run together.

Claims the re-measurement killed: "no approval path reads `gate`" became "nothing which decides whether
a draft may be committed reads `gate`", because `src/api/approvals.ts:72` does read the column into the
queue item and a human can see it. "Thirteen files" became fourteen. `applyDraft` is at
`src/db/pending-writes.ts:402`, not 649, and the decision route is at `src/api/approvals.ts:244`, not
266. `R-01` to `R-45` became `R-1` to `R-45`.

## Findings inherited rather than caused, each attributed by evidence

`tests/integration/migrations.test.ts` carries 2 failed and 5 passed. Its two failures are the ones
slice 4 already named, proven inherited by `git diff --name-only 6ed390d..HEAD` over that file being
empty and by the migration it trips over not being slice 5's.

`marketing-metrics-migration.test.ts` asserts a constraint name that `migrations/0020_crum_marketing_metrics.sql`
never gives, so that case can never pass, and the same diff shows neither file was touched by slice 5.

`tenant-isolation.test.ts` and `user-isolation.test.ts` are red for 5 cases on fixture uuids. The
hypothesis was tested instead of assumed: `z.string().uuid().safeParse('11111111-1111-1111-1111-111111111111')`
returns invalid, so Zod 4 rejects the literals, and the column definitions come from
`src/mastra/tools/customers.ts:41`.

`restart-survival.test.ts` is the Phase 3 restart criterion and it has never run, at
`tests/integration/restart-survival.test.ts:13`, where an unconditional `describe.skip` guards a body
that ends in `expect(true).toBe(true)`.

One cluster read was needed to prove the migrations race, and it was a read-only `SELECT` against
`crum_schema_migrations`, which returned 21 rows from 0002 to 0023. The cluster on 5455 was not
started, stopped or reconfigured, and no test was pointed at any other database.

## The walkthrough

Not done, reported as not done. The eight settings Step 5 needs are absent from the owner's `.env`,
which holds 65 keys. Only key names were read from that file, never a value, and no `CRUM_REPLICATE_API_TOKEN`
value appears in this report, the verification report, any log or any commit. Each of the plan's nine
steps is written up individually as not done, no mock was substituted for a step, and R1 is recorded as
closed by the mechanism and still open as a live-environment fact.

## Deviations from the brief

Step 5 of the plan was not run, which is the plan's own rule applied rather than a delay. The
integration list grew from ten files to all 24 in the lane. The verification report was written by the
controller because of the full drive. `tests/scripts/analyst-cron-config.test.ts` no longer exists as
such, its cases having moved to `tests/marketing/meta-ads-config.test.ts` with 9 cases, so the
directory totals carry cases the plan did not predict. The console totals include 1 file and 6 tests
belonging to the document effort, and they are subtracted rather than counted as slice 5's.

## Checks made on the document itself

All four Markdown tables were validated with a scratch script that requires a separator row and a
uniform cell count per block, escaping-aware, and it reports no problems. Style was grepped: no
semicolons, no em dashes, no divider lines. The forward reference in section 5 to section 9 now has a
target, the Contracts tab gap, which is the one assertion the console suite does not make about the kind
it shares the surface with.

## The review round, and the ten corrections it earned

`task-19-review-1.md` came back **not accepted as written**, with 2 Blocking, 3 Should-fix and 5 Nits.
Every finding was checked against the source before being accepted. Every one held, and all ten are
closed in the tree. That review was only possible because `C:` had freed to 13 GB by then, so a
dispatch that failed before the deliverable could be written succeeded after it.

B1 was the real one and it was mine. The report claimed nothing that decides a commit reads `gate`, and
`src/db/pending-writes.ts:412` reads `draft.gate !== 'auto'` inside `applyDraft`'s email branch, four
lines under the citation I gave. `git log -S` puts that check at `1a9c7a2`, an ancestor of the slice 4
base, so it is precedent rather than this slice's work. Section 9 now says no decision route reads the
column and one branch of the commit path does, scopes the exposure to every object type except email,
and points at the email branch as the shape a marketing rule would copy. Section 7's `refuse` rationale
got the same narrowing.

B2 credited this slice with two golden-dataset items added in Task 10. The plan's Task 10 is the
provider registry, `git log 6ed390d..HEAD -- src/evals tests/evals` is empty, and both commits that
touched the file are ancestors of the base. The report now says this slice added nothing there.

Should-fix 1 and 2 were both in the isolation paragraphs, and both were re-measured here rather than
repaired from the review's word. `user-isolation.test.ts` fails `:88` and `:119` with `expected
undefined to be '55555555-...'` and `:103` with `expected { error: true, …(2) } to be null`, not the
tenant file's `expected false to be true`. Each repeated-digit literal belongs to exactly one file, and
the variant-nibble explanation could not have condemned `aaaaaaaa-...`, whose variant nibble is legal.
All seven fixtures were run through the installed Zod 4.6.7 and all answer INVALID, with
`8f14e45f-ea2f-4b1b-9a1b-1234567890ab` VALID, so the rule is now stated as version and variant.
Should-fix 3 removed a cause I had invented, a neighbouring `beforeAll`, when the file fails identically
alone and the report's own run shape said so.

All five nits were taken: nine missing settings named with their two real env keys, 40 `loadPolicy()`
sites across `src/` with the 38 in `src/mastra/tools` scoped, a directory added to the
`approval-flow.ts` citation, six proofs plus four moved files instead of five plus four, and the
working-tree qualification extended from the two gates to the console total, which contains an untracked
file, and to `tests/mastra`, which ran over another effort's edits.

The pattern across B1 and the two Should-fix items is the same one the report criticises elsewhere: a
universal claim built from the top of a function. The count of what I corrected is not evidence the
report is now right about everything, and the reviewer's own list of what it could not verify is in its
last section.

## What this task leaves for the final step

The report is the deliverable and the review is its cross-check. Task 19 owns one file and no code, so
the inherited reds, the `gate` enforcement hole, the decorative `POLICY_DIR`, the unproven golden gate
and the restart-survival placeholder are all handed to slice 6 through section 9 rather than repaired
here.

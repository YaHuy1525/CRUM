# Task 14 review, round 1

Reviewer: independent subagent (general-purpose, read-only prompt). Dispatch succeeded, so this is a genuine second pair of eyes and not a self-review. Prior rounds in this slice could not dispatch and declared the loss instead.

Subject: commit `24a6da2` "fix(db): a row mapper's timestamps say what the driver actually returns" (6 files: `src/db/timestamps.ts` new, `src/db/reviewer-predictions.ts`, `src/db/pending-writes.ts`, `tests/db/timestamps.test.ts` new, `tests/db/reviewer-predictions.test.ts`, `tests/db/open-stage-draft.test.ts`).

Verdict: **DONE**. 0 Critical, 0 Important, 5 Minor.

## Gates

Run by the reviewer independently, and by the controller before the commit. Same numbers.

```
npx vitest run tests/db/timestamps.test.ts tests/db/reviewer-predictions.test.ts \
  tests/db/open-stage-draft.test.ts tests/db/pending-writes-commit.test.ts \
  tests/api/marketing.test.ts
→ Test Files 5 passed (5), Tests 65 passed (65)
   timestamps 7, reviewer-predictions 7, open-stage-draft 10,
   pending-writes-commit 37, api/marketing 4
npm run typecheck → clean
npm run lint      → clean
```

RED was captured before the helper existed: `Tests 2 failed | 15 passed (17)` with `expected 2026-11-02T04:00:00.000Z to be '2026-11-02T04:00:00.000Z'` at `tests/db/reviewer-predictions.test.ts:95` and the same at `tests/db/open-stage-draft.test.ts:97`, plus the third file failing to resolve the missing `src/db/timestamps` module. The two failures are the driver's `Date` walking straight through the cast, which is the exact fiction the review item was filed for.

## Findings accepted

Minor 1 is a correction to the controller's own preflight, not to the code. R-30 said "all four `rowToPendingWrite` call sites" and checked `:129`, `:727`, `:760`, `:797`. The real count is six: `listPendingWrites` (`:994`) and `listDecidedWrites` (`:1009`) both pass the mapper to `.map()` by name, so a grep for `rowToPendingWrite(` missed them. Verified in the current tree that both read `SELECT * FROM pending_writes` (`:989`, `:1000`), so `created_at`, `expires_at` and `rejected_at` are present and the strict arm cannot fire there. The safety conclusion stands, the evidence line was wrong, and the count is fixed here so the final review does not repeat it.

Minor 2: `tests/db/open-stage-draft.test.ts:102` (a null `rejected_at` stays `null`) was never a red test. The old `row.rejected_at as string | null` already returned `null`. It is a forward guard so that a later edit which routes the nullable column through `toIsoString` instead of `isoOrNull` is caught, which is what the brief asked for. Recorded so nobody counts it as evidence of a bug fixed.

Minor 3: `committedAt` (`src/db/pending-writes.ts:94`) still carries the same type fiction. The brief names it and rules to leave it: `(row.committed_at as string | null | undefined) ?? null` is a nullable-column default, and `commitAutoWrite` writes its own ISO string at `:745`. Left on purpose, and the comment block added above `:86-91` says so in the file. Consumers only do truthiness and JSON on it, so there is no behavior risk either way. Same for `committedRecordId`, which is not a timestamp at all.

Minor 4: `tests/db/timestamps.test.ts` has a fifth case the brief does not list ("crashes on undefined"). Kept because it is the case that separates the new helper from the cast it replaces, and it is the assertion the six-call-site safety check above rests on. No implementation change was made to satisfy it.

Minor 5: `src/mastra/workflows/approval-flow.ts:39` interpolates `draft.expiresAt` into an error message. That string changes from `Sat Nov 01 ... 2026` (a `Date`'s `toString`) to `2026-11-01T00:00:00.000Z`. No test asserts the old form, and an ISO string in a thrown message is the better artifact. Noted as a behavior change, not a break.

## Findings the controller added after the reviewer finished

A third timestamp normaliser exists in this codebase and this task did not touch it: `src/api/message-mapping.ts:69` declares a private `toIso(value: unknown): string` that handles `Date` and `string` the same way `toIsoString` does, then accepts a `number` as epoch milliseconds and, for anything else, returns `new Date(0).toISOString()`. So the house now has a strict normaliser and a lenient one that answers 1970-01-01 for a malformed column. Out of Task 14's scope by a wide margin (API layer, one row mapper, a signature that returns a value where the new one throws), but it is the same class of silent fallback that `getAssetBytes` deleted and that `src/db/timestamps.ts` cites in its own docstring. Parked for the final whole-branch review as a candidate follow-up: route `message-mapping.ts:69` through `toIsoString` or document why the message lane is allowed to be lenient. `src/db/alerts.ts:280`'s `toIsoDate(d: Date)` takes a `Date` and is not a normaliser, so it is not part of this finding.

## Deviations from the brief

Both are the R-30 rulings, already recorded before implementation. The docstring cites `src/db/marketing-assets.ts:112` rather than the brief's `:119`, because the brief's line is a `mime: string` field inside an anonymous type literal and the function it describes starts at `:112`. The two mapper tests call the file's existing row builder rather than hand-writing the full row literal. Both rulings were verified by the reviewer against the tree.

## Post-commit state

`24a6da2` contains only Task 14's six files. The concurrent queue refactor's unstaged edits (`src/api/documents.ts`, `tests/api/documents.test.ts`, the console knowledge files, and its new files) are untouched, so no split-commit pattern was needed for this task. Nothing under `tests/evals` was run. The Postgres 5455 cluster was not needed and is still down, so `tests/integration/marketing-asset-invalidation.test.ts` remains the parked Task 12 blocker that Task 19 must clear.

Carried to Task 15: `stageCampaignStatusChange` writes receipts and reads `expires_at`. If it formats a timestamp, it should call `toIsoString` rather than add a fifth cast, and `pending-writes.ts:94` is now the only remaining cast in the file.

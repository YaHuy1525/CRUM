### Task 19: Prove the slice, walk it once with a real picture, and write it down

**Files**

- Create `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md`

**This task owns no code.** It runs what Tasks 1 to 18 produced, compares the shape against the recorded slice-4 baseline, walks the flow with one real Replicate image on one real page, and writes the report. Per the standing rule, no claim about R1 is made without the walkthrough.

- [ ] **Step 1: The named unit suites**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing tests/db tests/api tests/config tests/governance
npx vitest run tests/mastra
```

Explicit directories, never a bare `npx vitest run` and never `npm run test`: `tests/evals/golden-gate.test.ts` is inside the unit project and spends roughly twelve model-minutes of the owner's paid credit. The golden gate does not run in this slice. Record that choice in the report rather than leaving it as an absence.

Baseline to compare against, from `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md`: `tests/marketing` 206, `tests/governance` 248, `tests/mastra` 496, `tests/db` 149, `tests/api` 282, `tests/config` 34. Report the new counts per directory and name every added case. A count that went down is a deleted test and must be explained.

- [ ] **Step 2: The integration proofs**

```bash
cd D:/Code/CRUM
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/marketing-asset-page.test.ts tests/integration/marketing-asset-invalidation.test.ts tests/integration/marketing-image-spend.test.ts tests/integration/marketing-generate-assets.test.ts tests/integration/marketing-campaign-status.test.ts tests/integration/analyst-cron.test.ts
```

Those six files are the five proofs spec section 13 asks for, mapped as: proof 1 in `marketing-asset-page.test.ts` (Task 7), proof 2 in `marketing-asset-invalidation.test.ts` (Task 12), proofs 3 and 5 in `marketing-image-spend.test.ts` and `marketing-generate-assets.test.ts` (Tasks 8, 9 and 10), proof 4 across `marketing-campaign-status.test.ts` (Task 16) and `analyst-cron.test.ts` (Task 15). Add the existing integration files whose behaviour this slice moved: `tests/integration/marketing-publish.test.ts` (Task 5 changed what its hash is computed over), `tests/integration/reviewer-predictions.test.ts` (Task 14), `tests/integration/pending-writes.test.ts` (Tasks 11 and 16), and `tests/integration/migrations.test.ts` (Task 8 added a migration). Baseline to carry forward: `tests/integration/migrations.test.ts` has two failures that predate this slice. Name them again, unchanged, or explain what changed.

For every file: state whether it ran or skipped. `describe.skipIf(!url)` skips silently, and this slice exists partly because that skip hid a broken insert for two slices.

- [ ] **Step 3: The console**

```bash
cd D:/Code/CRUM/console
npx vitest run
npm run lint
npx tsc --noEmit
```

The console has its own Vitest project and no paid gate inside it, so an unfiltered run is the blessed form here; slice 4 used the same command from the same directory. Baseline: 24 files and 210 tests. Task 13 adds `console/tests/AssetManager.test.tsx` and extends `console/tests/KnowledgePage.test.tsx`, so report the new counts and confirm the invoice and contract tabs still read their own lists.

- [ ] **Step 4: The whole gate, reported honestly**

```bash
cd D:/Code/CRUM
npm run typecheck
npm run lint
```

Run these two, not `npm run verify`. `verify` chains `npm run test`, which reaches the golden gate, and it exits non-zero in this repository by design. The report states that `npm run verify` was not run and why, and states the typecheck and lint results as they came out.

- [ ] **Step 5: The manual walkthrough, one real image on one real page**

Owner-supplied credentials, never written to a file or a commit: `CRUM_REPLICATE_API_TOKEN`, `CRUM_META_ADS_ACCESS_TOKEN`, `CRUM_CLOUDFLARE_ACCOUNT_ID`, `CRUM_CLOUDFLARE_PAGES_PROJECT`, `CRUM_CLOUDFLARE_API_TOKEN`, `CRUM_ANALYST_USER_ID`, `CRUM_IMAGE_PROVIDER=replicate`, and both spend ceilings. If any is missing, stop and report the walkthrough as not done; that is a result, not a delay.

1. Boot the API and the console, and in chat ask the marketing lead for one campaign whose page calls for a picture. Let the designer produce the creative prompt set, save the bundle, and run `marketing.generate_assets` for one image, so the ceiling arithmetic is exercised at its real cost rather than a fixture's.
2. Confirm the PNG is in the Campaign images tab. If the bundle is staged and unpredicted, confirm the thumbnail slot shows the awaiting-review placeholder and that the byte route answered 409, and say which of the two you observed.
3. Review the asset, confirm the tab reloads it as `ready`, and record the `invalidatedBundles` count the review response returned. If the count is non-zero, re-stage and write the prediction, and note that the re-stage is what R2 is for.
4. Stage the bundle, predict, and have a second person approve it, so the reviewer is not the predictor.
5. Publish, then promote, then drain with `npx tsx scripts/publish-drain.ts`.
6. Open the live preview URL in Zen and look at the picture. This is the residual: an image that reaches a published page. Record the URL, the file name the manifest carried (`slug/assets/<uuid>.png`), and whether the HTML held the resolved path rather than the placeholder token.
7. Independently of the console, `curl` the byte route with the identity headers for that document, both before and after the prediction exists, and record the status codes.
8. Ask for one scale and one kill recommendation in chat. Confirm each stages a draft whose review row shows a uuid requester and a derived target, that approval queues exactly one `set_campaign_status` action, and that the drainer reports the campaign id Meta acknowledged. Confirm the owner was told nothing was live until it was.
9. Then run the cron once, with and without `CRUM_ANALYST_USER_ID`, and record that the second reports recommendations and stages nothing while the first stages drafts.

Report each numbered step as done, skipped with the reason, or failed with what was seen. Do not summarise the walkthrough as successful.

- [ ] **Step 6: Write the report**

Create `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md` with these sections, in this order: what the slice changed, per residual what proves it closed (R1 to R6, then RV1 and RV2), what ran with the exact command and the counts, the integration files that ran versus the ones that skipped, the baseline comparison including the two `migrations.test.ts` failures, the walkthrough step by step, the decisions this slice took that a later reader will want recorded (the browse surface inheriting the gate, no automatic provider fallback, the two-layer ceiling, invalidation over re-hash, the derived guard list), the deviations from the plan with the reason for each, and the holes left open for slice 6. Carry the known holes forward: the pixel's post-hash deviation, `reason` living only in chat rather than in the draft, the missing `users` table behind `pending_writes.requested_by`, and `npm run verify` staying red by design.

Style, per the standing rule: plain language, no dashes used as punctuation, no semicolons, no divider lines, no table of contents. Naming a file or a column in backticks is fine; a hyphen between clauses is not.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git status --porcelain -- docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
git add -f docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
git commit -m "docs(marketing): record what slice 5 proved, what it skipped, and what it left open" -- docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
```

`docs/` is gitignored while its files are tracked, so the `-f` is required and the `-m` must precede the `--`.

---

## Self-review notes for the person executing this plan

1. Tasks 15, 16 and 17 touch `stageCampaignStatusChange` in that order, and each leaves the tree green: Task 15 changes its arguments, Task 16 changes what an approval of its draft does, Task 17 changes what it returns and who can call it. Do not merge them, and do not reorder them.
2. The missing-actor refusal is a cron-path guard. `rc.userId` is always present in a chat turn, so Task 17's tool cannot reach it and Task 15 tests it through the function directly. A reviewer asking why the chat tool has no test for `campaign_status_actor_required` should get that sentence rather than a new case.
3. Two tasks add a `calls()` style assertion because a fragment stub answers any parameters. If a step in this plan says "assert the params", read it as load-bearing: Task 4 and Task 5 of S5a hit the same collision, and the ordering note in Task 16 Step 1 is the fix.
4. No task in this plan calls Replicate, a model, or a real domain from an automated test. The only real-provider run is Task 19 Step 5, which the owner drives with their own token.

## Addendum C1. Step 5 cannot be run, and the report says so in those words

The controller read the key names in `.env`, never the values. The file holds 65 keys, and none of `CRUM_REPLICATE_API_TOKEN`, `CRUM_META_ADS_ACCESS_TOKEN`, `CRUM_CLOUDFLARE_ACCOUNT_ID`, `CRUM_CLOUDFLARE_PAGES_PROJECT`, `CRUM_CLOUDFLARE_API_TOKEN`, `CRUM_ANALYST_USER_ID`, `CRUM_IMAGE_PROVIDER` or a spend ceiling is among them. Step 5's own sentence rules this outcome: if any is missing, stop and report the walkthrough as not done, and that is a result rather than a delay.

So the walkthrough is written up as not done, with the missing key names listed and no claim of any provider call anywhere in the report. R1, the image reaching a published page, is then closed by the integration proof in `tests/integration/marketing-asset-page.test.ts` and by the byte route tests, and remains open as a live-environment fact. Say which of the two it is, per the plan's own instruction that no R1 claim stands without the walkthrough. Do not substitute a mock for a step and do not describe a step as partially done when the table says skipped.

Steps 1 to 4 and Step 6 and Step 7 all still run in full, and they are the bulk of the task.

## Addendum C2. Counts already measured at `0dc9a3e`, so you are not guessing the starting point

| Command | Result at the current HEAD |
| --- | --- |
| `npx vitest run tests/marketing tests/db tests/api tests/config tests/governance` | `Test Files 70 passed (70)`, `Tests 1091 passed \| 1 todo (1092)` |
| `npx vitest run` from `console/` | `Test Files 26 passed (26)`, `Tests 223 passed (223)` |

The five-directory sum against the slice 4 baseline is 919 (marketing 206, db 149, api 282, config 34, governance 248), so the run above already carries about 172 more cases than the baseline. Report each directory separately anyway, because a sum hides a directory that lost a test while another gained two, and name every added case the way Step 1 asks. Re-run both commands yourself and quote what you get, since Tasks 17 and 18 will have moved the tree again.

Two things about the console run that belong in the report rather than in a fix. Its total includes `console/tests/DocumentProcessingDashboard.test.tsx`, 6 cases, which is the concurrent document effort's untracked file, not slice 5 work. If you report 26 files and 223 tests as slice 5's, you have claimed someone else's cases, so name the file and its count as belonging to the other lane, and report the slice 5 figures as the remainder. The `act(...)` warnings that the run prints on stderr come from `tests/KnowledgePage.test.tsx` and `tests/CampaignMetricsDashboard.test.tsx` and predate this slice. They are not your defect, do not "fix" them by editing a console component, and the report should record that the run is green with two known warning sources named.

## Addendum C3. What has landed since the plan was written, and must be reflected

The report is a record of this branch, and four commits are newer than the plan's prose. Addendum A1 moved the Meta lane read and registration into `src/marketing/meta-ads-config.ts` and made `scripts/publish-drain.ts` register both lanes through an exported `registerDrainAdapters(env)`, which is what closes R-39, and that fact belongs under the residual it fixes rather than under a task number. Task 16's commit made an approval of a campaign status draft queue the work order. Task 17 grew the registry to 42 keys, changed `stageCampaignStatusChange` to return `{ pendingWriteId, riskScore }`, added `campaignStatusPayload` to `src/marketing/payload.ts`, and added the marketing instruction paragraph. Task 18 derives `MUTATING_TOOL_IDS` and, if it found what the pre-flight predicts, adds the four prospect-lane ids.

Step 1's own file list changed in one place worth naming: the config read moved out of `tests/scripts/analyst-cron-config.test.ts`, which no longer exists, into `tests/marketing/meta-ads-config.test.ts` with 9 cases. The `tests/marketing` directory therefore carries cases the plan did not predict, and the deviation belongs in Step 6's deviations section with the reason, which is that a per-process registry needs a test that can reach the registration.

The four unchecked `requestedBy` sites, the pixel's post-hash deviation, `reason` living only in chat, the missing `users` table behind `pending_writes.requested_by`, and `npm run verify` staying red by design all carry forward into the holes section, and Task 17's report may have added more. Read `task-17-report.md` and `task-18-report.md` before writing Step 6, and put their deferred items in the holes list rather than letting them evaporate.

## Addendum C4. Ownership and shape

This task owns one file, the new report. It owns no code. If a suite is red, the report says which case is red with its assertion text and stops there. Do not edit a test, a source file, or the golden dataset to make a count read better, and do not touch anything belonging to the other two efforts, which is everything in `console/`, `services/ocr/`, `src/api/`, `src/queue/`, `src/temporal/`, `src/transforms/`, `src/mastra/docling.ts`, `src/mastra/identity.ts`, `src/mastra/workflows/ingest.ts`, `package.json`, `package-lock.json`, `docker-compose.yml`, `.env.compose.example`, `tests/mastra/identity.test.ts` and `tests/mastra/prospect-tools.test.ts` that `git status --short` will show you as modified or untracked.

Step 7's `git add -f` and the `-m` before the `--` are both load-bearing, because `docs/` is matched by `.gitignore` while the files inside it are tracked. A plain `git add` on that path exits 1, and a chained `git add ... && git commit ...` then never reaches the commit. Check with `git diff --cached --name-only` that the single path is staged before committing, since another effort on this branch has already swept one worker's staged index.

The report's style is fixed by the standing rule and repeated here because it is easy to break at length: plain language, needed professional terms explained in the sentence that uses them, no dashes as punctuation, no semicolons, no divider lines, no table of contents. Backticks around a file or column name are fine.

## Addendum C5. The two `migrations.test.ts` failures, measured at the current HEAD

The plan asks you to name the two baseline failures again or explain what changed. They are unchanged, and here is the measurement so you can confirm rather than discover. Run as a single file against `crum_slice5` with the URL exported, `tests/integration/migrations.test.ts` collects 7 and gives `2 failed | 5 passed`, and the two are:

- `migrations against a real database > boots through main(), which runs storage.init() and then the spine`, failing at `tests/integration/migrations.test.ts:55` with `AssertionError: expected [] to include '0002_crum_spine.sql'`. The slice 4 report calls this the empty-database race, and the run above is the stronger form of the same cause: the database this cluster holds is already migrated, so `applied` comes back empty however the file is run. Say which of the two conditions your own run produced.
- `migrations against a real database > refuses a second receipt for the same staged draft`, failing with `null value in column "draft_hash" of relation "pending_writes" violates not-null constraint`, because the raw INSERT at about `:99` omits a column `migrations/0003_crum_add_draft_hash.sql` made NOT NULL with no default. `draft_hash` predates slice 5, so this is not this slice's defect and Step 2 wants it named as carried forward.

Do not repair either one. Fixing them means editing an integration file this task does not own, and the honest report of a slice is the one that separates what it broke from what it inherited.

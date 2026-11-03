# Task 19 review 1, independent fact-check of the slice 5 verification report

Subject: `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md`, 461 lines, read in full before judging any part of it.

State I worked in: branch `feat/marketing-slice-5`, HEAD `1571f8b`, working tree exactly as found. I staged nothing, reverted nothing, committed nothing, dispatched nobody, edited no file but this one, ran nothing under `tests/evals`, ran no bare `npx vitest run`, ran no `npm test` and no `npm run verify`, called no provider, and touched the 5455 cluster with `SELECT` only.

**Verdict: not accepted as written.** Two Blocking misstatements and three Should-fix misquotations, and all five err in the same direction, which is toward overstating or misattributing evidence rather than toward hiding it. Every measured number I could re-measure is exactly right: all eleven unit totals, both root gates, both console gates, the migrations row count, the `.env` key count, the ten-file arithmetic, and every walkthrough status. The report needs four sentences corrected, not a rewrite.

## Blocking

### B1. Section 9 (report lines 405, 408 to 410) and section 7 (lines 329 to 330): the commit path does read `gate`

Report text at line 405: "The largest hole is that nothing which decides whether a draft may be committed reads `gate`." At lines 408 to 410: "`applyDraft` at `src/db/pending-writes.ts:402` dispatches on `object_type` alone." Section 7 restates it as a decision rationale at lines 329 to 330: "nothing that decides whether a draft may be committed reads the `gate` column, so a stored `refuse` was an approvable draft wearing a warning label."

Repository evidence, `src/db/pending-writes.ts`, the function the row points at:

```
402: async function applyDraft(
408:   if (draft.objectType === 'email') {
412:     if (draft.gate !== 'auto') {
413:       throw new UnsupportedCommitError(
414:         'mail.send is staged but not deliverable: the Gmail connector has a draft scope only, so approving it would emit a receipt for an email that was never sent',
```

`draft.gate` is that column, populated at `src/db/pending-writes.ts:84` from `row.gate`. So `applyDraft` dispatches on `object_type` and then consults `gate` inside one branch, and a draft whose `gate` is `refuse` is refused at commit time whenever its `object_type` is `email`. The general exposure the report describes is real for the other object types, and the report's own line 412 to 414 conclusion, that the fix "should be its own task rather than a side effect", still stands. What does not stand is the universal form, because it is contradicted four lines below the line the report cites.

Smallest fix: at report line 405 change "nothing which decides whether a draft may be committed" to "no decision route reads it and only one branch of `applyDraft` does", name `src/db/pending-writes.ts:412` as the exception, and at line 413 scope the approvable-`refuse` sentence to object types other than `email`. Then repeat the narrower wording in section 7 lines 329 to 330, which is where a reader would take it as a recorded decision rather than as a hand-off.

### B2. Section 3 (report lines 99 to 101): this slice added nothing to the golden dataset

Report text: "`tests/evals/golden-gate.test.ts` was never run in this slice, so the two marketing items added to the golden dataset in Task 10 are unproven against a live model here."

Repository evidence. The plan's Task 10 is the provider registry, not the dataset, at `docs/superpowers/plans/2026-11-02-marketing-team-slice-5.md:2143`:

```
### Task 10: A named image-provider registry, selected by config, with no fallback
```

and nothing in that task's body mentions the golden dataset. The dataset file is `src/evals/golden-items.ts`, and the whole evals lane is untouched by this slice:

```
$ git log --oneline 6ed390d..HEAD -- src/evals tests/evals
(empty)
$ git diff --name-only 6ed390d..HEAD -- tests/evals src/evals
(empty)
$ git log --oneline --format="%h %ad %s" --date=short -S"marketing.generate_assets" -- src/evals/golden-items.ts | tail -3
2567245 2026-11-02 docs(mastra): tell the designer and the primary agent what the image run costs
$ git merge-base --is-ancestor bcc5026 6ed390d && echo predates
bcc5026 predates base 6ed390d
```

`2567245` and the last commit touching the file, `bcc5026`, both predate the slice 5 base. Marketing items do exist in `src/evals/golden-items.ts`, twelve mentions, but they arrived in an earlier slice's Task 10, and the slice task list confirms that: "Task 10: Two marketing items in the golden dataset" belongs to the slice 2 group, while "S5 Task 10" is the registry.

This is the one place in the report where an absence is described as work this slice did, and it is load-bearing for the section's honesty claim, because the sentence's job is to say what the unrun gate leaves unproven. Smallest fix: replace "added to the golden dataset in Task 10" with "already in the golden dataset from slice 2's Task 10", which keeps the honest conclusion, that the gate never ran here, and drops the false attribution.

## Should-fix

### SF1. Section 4 (report lines 192 to 194): two quoted failure messages are not the failures

Report text: "`tenant-isolation.test.ts:94` and `:115` fail with `expected false to be true` on `Array.isArray(result)`, and `user-isolation.test.ts:103` and `:119` fail the same way".

The tenant-isolation half is exact. The user-isolation half is not. Real output, with `CRUM_INTEGRATION_DATABASE_URL` exported in the same shell against `crum_slice5` on 5455:

```
===== tests/integration/user-isolation.test.ts
   × User Isolation > owner can see their own customer
     → expected undefined to be '55555555-5555-5555-5555-555555555555' // Object.is equality
   × User Isolation > non-owner cannot see the customer
     → expected { error: true, …(2) } to be null
   × User Isolation > admin can see any customer in their tenant
     → expected undefined to be '55555555-5555-5555-5555-555555555555'
 Test Files  1 failed (1)
```

The source at the two cited lines is not an `Array.isArray` check either:

```
103:     expect(result).toBeNull()
119:     expect((result as { id: string })?.id).toBe(CUSTOMER_ID)
```

So the report says three failures and names two, gives one assertion text that fits none of the three, and its count of three is right while its quoted evidence is wrong. Whoever fixes this in slice 6 will be looking for a `toBe(true)` that is not there. Smallest fix: name the real message per line, `expected { error: true, …(2) } to be null` at `:103` and `expected undefined to be '55555555-...'` at `:119`, and add the third failure's line.

### SF2. Section 4 (report lines 194 to 199): the fixtures named are not in the file blamed, and the stated rule does not condemn the example given

Report text: "Those files build fixture ids out of repeated digits, `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` and `11111111-1111-1111-1111-111111111111`. Zod 4.6's `.uuid()` requires the variant nibble to be 8, 9, a or b, and all four of those fixtures fail it."

Two defects. First, those two literals exist only in `tenant-isolation.test.ts`, at `:35` and `:39`, and not in `user-isolation.test.ts`, whose fixtures are a different set entirely:

```
35:const CUSTOMER_ID = '55555555-5555-5555-5555-555555555555'
36:const OWNER_ID = '66666666-6666-6666-6666-666666666666'
37:const OTHER_USER_ID = '77777777-7777-7777-7777-777777777777'
38:const TENANT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
```

Second, "all four of those fixtures" has no four-item referent, and the rule as stated cannot fail `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, because its variant nibble is `a`, which the stated rule accepts. I measured the behaviour rather than reasoning about it:

```
$ node -e "const {z}=require('zod') ..."   # zod 4.6.7, matches package.json:70
aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa INVALID Invalid UUID
11111111-1111-1111-1111-111111111111 INVALID Invalid UUID
55555555-5555-5555-5555-555555555555 INVALID Invalid UUID
22222222-2222-2222-2222-222222222222 INVALID Invalid UUID
8f14e45f-ea2f-4b1b-9a1b-1234567890ab VALID
```

The conclusion, that every repeated-digit fixture in those two files is rejected, is correct and the report's live measurement of `11111111-...` reproduces. The explanation is what is wrong: the version nibble is also in play, which is why `aaaaaaaa-...` with its `a` in the third group fails. Smallest fix: name the four literals actually in each file, and state the rule as version and variant, or simply say the fixtures are not RFC 4122 shaped and Zod 4.6.7 rejects all of them, which is what was measured.

### SF3. Section 4 (report lines 136 to 141): the cause named is inconsistent with the report's own run shape

Report text: "the cluster's `crum_slice5` already holds 21 applied migrations from `0002` to `0023`, which was read out of `crum_schema_migrations` for this report, so `migrate()` returns an empty `applied` list because the neighbouring file's `beforeAll` did the work first."

The count and the range are exactly right, and I read the same table:

```
$ psql "postgres://crum_test@localhost:5455/crum_slice5" -Atc "select count(*), min(migration_name), max(migration_name) ..."
```
which failed on the column name, and then, using the real column `filename`:
```
21 rows, min 0002, max 0023
```

The mechanism, though, is not a neighbour. `migrations.test.ts` was run by itself and still failed at `:55`, so no other file's `beforeAll` was in the process:

```
===== tests/integration/migrations.test.ts        (single-file run)
   × migrations against a real database > boots through main(), which runs storage.init() and then the spine
     → expected [] to include '0002_crum_spine.sql'
 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
```

The report's own section 4 preamble at lines 116 to 119 says each file was run alone and then together with the same totals, so persistent database state, not a same-command neighbour, is what produces this failure in both forms. The second failure's text reproduces word for word:

```
     → null value in column "draft_hash" of relation "pending_writes" violates not-null constraint
```

and the NOT NULL with no default is at `migrations/0003_crum_add_draft_hash.sql:21`, with the comment at `:17` confirming no column default, exactly as claimed. Smallest fix: drop "because the neighbouring file's `beforeAll` did the work first" and keep "the cluster already holds 21 applied migrations, so `applied` comes back empty on a shared database".

## Nits

1. Report lines 254 to 258 say "eight environment settings" and list seven names plus "either spend ceiling". The plan at Task 19 Step 5 names nine, because it says "both spend ceilings". The substantive claim holds: `.env` has 65 keys, which I counted from names only, all seven explicit names are absent, and no key in the file matches `SPEND`, `CEILING` or `BUDGET` at all, so both ceilings are absent too. The real names are `CRUM_IMAGE_SPEND_CEILING_MINOR` and `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE` at `src/config/env.ts:215` and `:231`. Say nine, or say eight with the two ceilings folded.
2. Report line 417 says "38 call sites that ignore it". Measured: `loadPolicy()` appears 38 times across the six files in `src/mastra/tools/`, which is exactly what section 7 line 340 says and it is right, but 40 times across all of `src/`, because `src/api/prospects.ts` and `src/mastra/active-tools.ts` add two. Section 9 generalises a tool-directory number to all call sites.
3. Report line 439 cites "`approval-flow.ts:39`" with no directory. The file is `src/mastra/workflows/approval-flow.ts` and line 39 is the expiry throw, so the citation is right once you find the file. Give the path like every other citation in the section.
4. Report line 153 says "The plan's list is the five proofs plus four files", which counts nine, while line 116 and section 8 line 355 both say ten. The plan resolves this correctly at its own Step 2: six files carry the five proofs, because proof 4 spans `marketing-campaign-status.test.ts` and `analyst-cron.test.ts`, plus four moved files. Say six plus four.
5. Report lines 3 and 103 both anchor the measurement to a commit, and I confirmed `git diff --stat 1d85f96 3a7d573 -- src tests console scripts migrations policy` and the same against `1571f8b` are both empty, so the three commits are code-identical. But the console lane necessarily ran the working tree: `console/tests/DocumentProcessingDashboard.test.tsx` is untracked, `git ls-files --error-unmatch` says "did not match any file(s) known to git", and it is inside the 26 files and 223 tests, and `tests/mastra/identity.test.ts` is modified. The report discloses this only for typecheck and lint at lines 107 to 109, and section 5 does at least name the Dashboard file. Extend the qualification to the console and mastra counts.

## Claims I could not verify and why

- Six of the ten planned integration files' per-file case counts, `marketing-generate-assets` 4, `marketing-campaign-status` 1, `analyst-cron` 12, `marketing-publish` 10, `reviewer-predictions` 4, `pending-writes` 2. Each is a cold vitest boot against the cluster, and measuring the remaining six plus the combined run pushed past the budget I was given. Their arithmetic is consistent, because 2 + 2 + 7 + 4 + 1 + 12 + 10 + 4 + 2 + 7 = 51 collected with 2 failed, which matches the section 3 block.
- The combined ten-file single command at report lines 82 to 95 and the report's claim at lines 117 to 119 that both forms agree. I measured five files alone and did not run the ten together, because a wrong row in the shared lane costs another file's state.
- `document-audit-flow.test.ts` red-then-green at report lines 162 and 205 to 210. Re-measuring it needs two runs of another effort's file against the shared database, and its untracked-worktree neighbour, `src/queue/`, is in the same lane. I did not run it either time, so its flip is recorded as unverified, not as confirmed.
- The remaining nine results in the fourteen-file table at report lines 161 to 174. I re-measured five of the fourteen, `marketing-metrics-migration` 1 failed and 1 passed, `tenant-isolation` 2 failed, `user-isolation` 3 failed, `restart-survival` 1 skipped, all matching, and the two skipped rows' reasons in the source, `tests/integration/restart-survival.test.ts:13` is `describe.skip(` with no condition and its body is eight numbered comments ending at `expect(true).toBe(true)` on line 23, and `tests/integration/semantic-recall.test.ts:38` is `const live = pgUrl !== '' && process.env.CRUM_SEMANTIC_RECALL_LIVE === 'true'`, which is the skip reason the report gives.
- Report line 36 and section 2 line 49, that the derivation "found four mutating tools that had never been guarded". The derived cases exist, `tests/mastra/processors/write-claim-guard.test.ts:70` is `it('names every declared mutating tool the registry is missing'` and `:16` is `const DECLARED_MUTATING = loadPolicy()`, and the file runs 22 green cases, which is the count the report states. The specific four I did not enumerate, because that means diffing policy names against registry keys by hand.
- Report line 226's intermediate path, "496 to 518 at `151722e`, then +4 at `a345ab8`, +2 at `8629be5`, +3 at `1d85f96`". The endpoints are right, 518 + 4 + 2 + 3 = 527 and I measured 527, but the per-commit intermediate counts need a checkout, which I am not permitted to do.
- Report line 42's R1 row against a live host, and report lines 284 to 286, "R1 is closed by the mechanism and remains open as a live-environment fact". No available check reaches a live Pages project without spending, so this is unverifiable by design and the report says so. The mechanism half is well evidenced: `tests/integration/marketing-asset-page.test.ts` runs 2 green alone, and it asserts the manifest carries two keys with the asset path matching `/^physio-picture\/assets\/[0-9a-f-]{36}\.png$/` at `:321`, the bytes as a `Buffer` at `:325` and `:349`, `Content-Type: image/png` at `:350`, the resolved path present and the `{{ASSET:` token absent at `:337` to `:338`, and the approval hash equal to the hash recomputed from the uploaded files at `:300` and `:319`.
- That no automated test in this slice reached a paid provider, report lines 111 to 112. I can only confirm it is structurally plausible, because the harnesses I read inject `fetchImpl` and bind a local `createServer`, and the plan forbids the alternative at its line 19. Proving a negative across nineteen tasks is beyond what I could run.

## Checks that held, with the numbers I actually measured

All of section 3's totals reproduced exactly, and the five-directory sum equals the section 5 per-directory figures:

```
npx vitest run tests/marketing tests/db tests/api tests/config tests/governance
  Test Files  70 passed (70)
  Tests  1091 passed | 1 todo (1092)

npx vitest run tests/mastra
  Test Files  56 passed (56)
  Tests  527 passed (527)

cd console && npx vitest run tests
  Test Files  26 passed (26)
  Tests  223 passed (223)

tests/marketing  16 files  299      tests/db      18 files  201
tests/api        25 files  303      tests/config   1 file    38
tests/governance 10 files  250 passed | 1 todo (251)
299 + 201 + 303 + 38 + 250 = 1091, plus the one todo, so both forms agree as report line 105 claims
```

`npm run typecheck` exited 0 and `npm run lint` exited 0, and in `console` both `npx tsc --noEmit` and `npm run lint` exited 0, which is report lines 72 to 73 and 106 to 107. The per-file counts in section 5 all matched the runner: `tests/marketing/site.test.ts` 88, `image-provider.test.ts` 5, `meta-ads-config.test.ts` 9, `tests/db/timestamps.test.ts` 7, `write-claim-guard.test.ts` 22, `marketing-campaign-status-tool.test.ts` 23, `marketing-write-tools.test.ts` 43, `marketing-agents.test.ts` 29, `boot.test.ts` 40, `console/tests/AssetManager.test.tsx` 4, `console/tests/DocumentProcessingDashboard.test.tsx` 6.

The baseline is not inflated. `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md` records 206 marketing, 248 governance, 496 mastra, 149 db, 282 api, 34 config, and console 24 files and 210 tests, which is exactly what report lines 214 to 215 and 235 quote, and 206 + 248 + 149 + 282 + 34 = 919 as stated.

Every residual row in section 2 that I spot-checked points at a real mechanism. `loadSiteArtifacts` is defined at `src/db/marketing-assets.ts:212` and has exactly four production call sites, `src/db/marketing.ts:325`, `src/marketing/outbox.ts:244`, `src/marketing/page-host.ts:120`, `src/mastra/tools/marketing-writes.ts:444`, which is the report's "all four places that compute a site hash". `SiteFile` at `src/marketing/site.ts:102` to `112` carries `sha256`, `contentType` and `content: Uint8Array`. `invalidateOpenStageDraft` at `src/db/pending-writes.ts:1006` has three call sites, `src/api/documents.ts:313`, `src/mastra/tools/marketing-writes.ts:291` and `:1792`, and `tests/integration/marketing-asset-invalidation.test.ts:207` to `214` asserts the rejection reason, the return to `draft` and the null open draft. The two-layer ceiling is checked in the stated order at `src/mastra/tools/marketing-writes.ts:1571` and `:1588` before `:1576` and `:1602`, with the re-check at `:1618` to `:1625` also bundle-first. The registry at `src/marketing/image-provider.ts:86` to `120` holds a `Map` keyed by name, returns `?? null` for an unanswered name, and `tests/marketing/image-provider.test.ts:50` asserts that null rather than describing it, so "no silent fallback" is measured not claimed, with no `toHaveLength(16)` anywhere in `tests/` or `src/`.

Section 6's honesty holds under reading. All nine walkthrough steps are marked Not done, matching the plan's nine numbered steps at its lines 4347 to 4355, no step is described as partial, no mock is passed off as a step, and the plan's own stop rule is quoted correctly. Section 8's "Step 5 was not run" agrees. `tests/scripts/analyst-cron-config.test.ts` is genuinely gone and the directory still holds three other files. The slice ledger really does carry R-1 through R-45, 45 distinct records. The todo really is `it.todo(...)` at `tests/governance/conformance.test.ts:282`, introduced at `f4c53f6`, which is an ancestor of the slice 5 base, and nothing under `tests/governance/` or `policy/` changed in `6ed390d..HEAD`, exactly as report line 225 says. `3a7d573` really is code-identical to `1d85f96`. Provenance for every inherited red is confirmed: `migrations/0020_crum_marketing_metrics.sql` last changed at `27f11a2`, its test at `aa8788a`, and `git diff --name-only 6ed390d..HEAD` is empty for that migration, that test, both isolation files, `src/mastra/tools/customers.ts` and `package.json`. `src/mastra/index.ts:158`, `src/api/message-mapping.ts:69`, `src/db/pending-writes.ts:97` and `tests/db/open-stage-draft.test.ts:102` all contain what section 9 says they do, and `.env.example:90` is `POLICY_DIR=` with `src/governance/index.ts:6` the only reader that honours it and no `src/` module importing that singleton. The section 9 naming trap is precise: `src/api/approvals.ts:244` is the decision route, `:245` is `const gate = await auth(c)`, `:72` is `gate: draft.gate`, and the route checks identity, a prior decision at `:257`, `committedAt` at `:263` and expiry at `:269`, never the column. `src/evals/custom-scorers.ts:55` does read the same list. The four tables all render, at report lines 41, 122, 160 and 220, with consistent column counts and correctly escaped `\|` cells at lines 132 and 166, and the style rules hold, with zero semicolons, zero em or en dashes and zero divider lines in 461 lines.

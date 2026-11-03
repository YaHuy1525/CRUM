# Marketing team slice 5, what it proved

Date: 2026-11-03. Branch `feat/marketing-slice-5`. Measured at `3a7d573`, whose code is byte-identical
to `1d85f96` across `src`, `tests`, `console`, `scripts`, `migrations` and `policy`. Spec:
`docs/superpowers/specs/2026-11-02-marketing-team-slice-5-design.md`. Plan:
`docs/superpowers/plans/2026-11-02-marketing-team-slice-5.md`.

## 1. What the slice changed

Slice 4 ended with a marketing team that could generate images and a reviewer who had to predict
before approving them. The pictures never reached the published page, because `resolveSite` only
knew the two HTML slots and dropped every asset on the floor. This slice closed the six residuals
that came out of slice 4 and the two whole-branch review items, in nineteen tasks.

The mechanism that closed R1 is a loader. `loadSiteArtifacts` reads the bytes of the assets a page
names, and `resolveSite` rewrites each placeholder to its hosted asset path inside those bytes
before any hash is computed, so the picture the approval signs is the picture the host receives.
`SiteFile` gained bytes, a content type and a true hash. The manifest upload now sends a blob with
the asset's own content type instead of telling a browser to parse an image as markup. All four
places that compute a site hash go through the one loader, because two resolutions of one page is
the drift R2 exists to catch.

R2 became a hard rejection: an asset change invalidates the open stage draft and moves the bundle
back to `draft`, rather than letting a reviewer approve bytes that no longer match what was
staged. R3 added a lifetime ceiling per bundle that is checked before the daily tenant ceiling, so
one bundle cannot eat the tenant's day. R4 replaced a module global with a named image-provider
registry selected by config and no silent fallback. R5 made `marketing_asset` documents browsable
in the document manager, through the same prediction gate that already withheld the bytes.

R6 was deeper than the residual looked. `marketing.set_campaign_status` was declared in the policy,
governed, and present in the object-type list, but nothing could reach it and approving it committed
nothing, because `applyDraft` had no branch for it and the staging call passed non-uuid values into
uuid columns. Tasks 15 to 17 fixed the writes, added the `applyDraft` branch, made the tool callable
from a chat turn, and put it in the registry. RV1 made a `timestamptz` column's declared type tell
the truth through one normaliser. RV2 replaced a hand-written guard list with a derivation, and the
derivation found four mutating tools that had never been guarded.

## 2. Per residual, what proves it closed

| # | What proves it | Where |
| --- | --- | --- |
| R1 | A page with one placeholder, one real document with real bytes, staged, approved and drained to a stub Pages server, asserting the uploaded manifest carries `slug/index.html` beside `slug/assets/<uuid>.png`, that the HTML the stub received holds the resolved path rather than the token, and that the hash the approval signed equals the hash recomputed from the uploaded bytes | `tests/integration/marketing-asset-page.test.ts` (Task 7) |
| R2 | An asset change after staging hard-rejects the open draft, and the bundle returns to `draft` | `tests/integration/marketing-asset-invalidation.test.ts` (Task 12) |
| R3 | The per-bundle lifetime ceiling is refused before the daily tenant ceiling is consulted, at the real cost of one image rather than a fixture's | `tests/integration/marketing-image-spend.test.ts`, `tests/integration/marketing-generate-assets.test.ts` (Tasks 8, 9, 10) |
| R4 | A named registry selected by config, with the absence of fallback asserted rather than described | Task 10 unit cases in `tests/marketing` |
| R5 | The documents surface admits `marketing_asset` through the same gate, and the tab lists it with a thumbnail that comes from the gated byte route | Task 13, `console/tests/AssetManager.test.tsx` and `console/tests/KnowledgePage.test.tsx` |
| R6 | The chat tool stages a draft whose review row shows a uuid requester and a derived target, approval enqueues exactly one `set_campaign_status` action, and the drainer reports the campaign id the provider acknowledged | `tests/mastra/marketing-campaign-status-tool.test.ts`, `tests/integration/marketing-campaign-status.test.ts`, `tests/integration/analyst-cron.test.ts` (Tasks 15, 16, 17) |
| RV1 | The row mapper normalises through `toIsoString`, and a value that is neither a `Date` nor a string throws rather than becoming `[object Object]` in a receipt | Task 14, `src/db/timestamps.ts` |
| RV2 | `toHaveLength(16)` is gone, no case states the guard list's size, and the list is cross-checked against the loaded policy and the real registry | `tests/mastra/processors/write-claim-guard.test.ts` (Task 18) |

R1 is the only residual that needs a live environment to be fully believed, and this slice did not
have one. Section 6 says what that means for the claim.

## 3. What ran

Unit, by explicit directory. The commands are the plan's, and a bare run is forbidden in this
repository because `tests/evals/golden-gate.test.ts` spends the owner's paid live-model credit.

```
npx vitest run tests/marketing tests/db tests/api tests/config tests/governance
Test Files  70 passed (70)
Tests  1091 passed | 1 todo (1092)

npx vitest run tests/mastra
Test Files  56 passed (56)
Tests  527 passed (527)

cd console && npx vitest run
Test Files  26 passed (26)
Tests  223 passed (223)

npm run typecheck    exit 0
npm run lint         exit 0
```

The one `todo` is `tests/governance/conformance.test.ts` and predates this slice at `f4c53f6`.

Integration, with `CRUM_INTEGRATION_DATABASE_URL` exported in the same shell against the Postgres
17 cluster on port 5455 and the `crum_slice5` database:

```
npx vitest run --project integration \
  tests/integration/marketing-asset-page.test.ts \
  tests/integration/marketing-asset-invalidation.test.ts \
  tests/integration/marketing-image-spend.test.ts \
  tests/integration/marketing-generate-assets.test.ts \
  tests/integration/marketing-campaign-status.test.ts \
  tests/integration/analyst-cron.test.ts \
  tests/integration/marketing-publish.test.ts \
  tests/integration/reviewer-predictions.test.ts \
  tests/integration/pending-writes.test.ts \
  tests/integration/migrations.test.ts
Test Files  1 failed | 9 passed (10)
Tests  2 failed | 49 passed (51)
```

The whole gate, reported honestly. `npm run verify` was **not** run. It chains `npm run test`,
which reaches the golden gate, and it exits non-zero in this repository by design.
`tests/evals/golden-gate.test.ts` was never run in this slice. This slice added nothing to the golden
dataset either, because `git log 6ed390d..HEAD -- src/evals tests/evals` is empty and the plan's Task
10 is the image-provider registry, so what the unrun gate leaves unproven here is the marketing eval
items that earlier slices put in `src/evals/golden-items.ts`, at commits `2567245` and `bcc5026`, both
of which are ancestors of this slice's base. That is a choice made to protect the owner's credit,
recorded rather than left as an absence.

Everything in this section was re-measured by hand at the commit this report was written into, whose
code is byte-identical to `1d85f96`. The per-directory figures in section 5 come from running each
directory alone rather than as a five-directory sum, and both forms agree. `npm run typecheck` exits
0 and `npm run lint` exits 0 at that same commit, and the console's own `npm run lint` and
`npx tsc --noEmit` both exit 0. One qualification, and it reaches further than the two gates. Every
number in this report was taken from the working tree, and this branch's working tree also holds the
concurrent document effort's uncommitted files, so a clean typecheck is a statement about the combined
tree rather than about slice 5 alone. Two counts are specifically affected. The console's 26 files and
223 tests include `console/tests/DocumentProcessingDashboard.test.tsx`, which is a file git has never
seen, so an untracked file sits inside that total, and the 527 in
`tests/mastra` ran while `tests/mastra/identity.test.ts` carried uncommitted edits. Section 5
subtracts the Dashboard file from what slice 5 claims, and states the arithmetic so a reader can
subtract it again.

No automated test in this slice called Replicate, a model, a real domain or Cloudflare. Every
network edge in the suites above is an injected `fetchImpl` or a local stub server.

## 4. Integration, file by file

The plan names ten files. Each was run alone against the Postgres 17 cluster on port 5455 with
`CRUM_INTEGRATION_DATABASE_URL` exported in the same shell, and then run together in one command.
The two forms give the same totals, which matters here because these files share one database and a
file that passes alone can fail beside a neighbour.

| File | Alone | What it holds |
| --- | --- | --- |
| `marketing-asset-page.test.ts` | 2 passed (2) | R1. The picture the approval signs is the picture the stub host received |
| `marketing-asset-invalidation.test.ts` | 2 passed (2) | R2. An asset move kills the open stage draft and returns the bundle to `draft` |
| `marketing-image-spend.test.ts` | 7 passed (7) | R3. The per-bundle lifetime ceiling is consulted before the tenant's day |
| `marketing-generate-assets.test.ts` | 4 passed (4) | R3 and R4. The tool's real cost lands in the ledger beside the bundle |
| `marketing-campaign-status.test.ts` | 1 passed (1) | R6. Approving the draft queues exactly one `set_campaign_status` action |
| `analyst-cron.test.ts` | 12 passed (12) | R6. The cron lane stages drafts with a uuid requester and no run id collision |
| `marketing-publish.test.ts` | 10 passed (10) | Task 5. The hash is computed over loaded bytes, not over the placeholder |
| `reviewer-predictions.test.ts` | 4 passed (4) | Task 14. The prediction row's timestamps reach the receipt as text |
| `pending-writes.test.ts` | 2 passed (2) | Tasks 11 and 16. `getOrCreateDraft` and the new approval branch |
| `migrations.test.ts` | 2 failed \| 5 passed (7) | The inherited pair, named just below |

The two failures in `migrations.test.ts` are the pair slice 4 already carried forward, and they are
unchanged. `migrations against a real database > boots through main(), which runs storage.init() and
then the spine` fails at `:55` with `expected [] to include '0002_crum_spine.sql'`, and the condition
this run produced is the second of the two causes slice 4 described: the cluster's `crum_slice5`
already holds 21 applied migrations from `0002` to `0023`, which was read out of
`crum_schema_migrations` for this report, so `migrate()` has nothing left to apply and returns an empty
`applied` list. This is persistent database state rather than one file crowding another, because the
file fails identically when run alone. `> refuses a second receipt for the same staged
draft` fails at `:98` with `null value in column "draft_hash" of relation "pending_writes" violates
not-null constraint`, because its raw INSERT predates `migrations/0003_crum_add_draft_hash.sql` making
that column NOT NULL with no default, and `migrations/0003_crum_add_draft_hash.sql:21` carries the
constraint while `:17` records that no column default was added. `draft_hash` is older than slice 5, so
both are named and neither is repaired here.

Ten files, 51 cases collected, 49 passed, 2 failed, none skipped. `describe.skipIf(!url)` skips
silently and this slice exists partly because that silence hid a broken insert for two slices, so
the check that matters is the collected count: every one of the ten reports a non-zero number of
cases, which is the evidence that it ran rather than evaporated.

### The fourteen files the plan did not name

The plan's list is six files carrying its five proofs, because proof 4 spans
`marketing-campaign-status.test.ts` and `analyst-cron.test.ts`, plus four files whose behaviour this
slice moved. That is a
reasonable list and it is not the whole directory, and a verification report that stops at a plan's
arbitrary list inherits the plan's blind spots. So the other fourteen files under
`tests/integration/`, which is every remaining file including the one in its `api/` subdirectory, were
also run, one at a time, against the same database.

| File | Result | Read |
| --- | --- | --- |
| `approval-expiry.test.ts` | 1 passed (1) | green |
| `document-audit-flow.test.ts` | 2 failed (2), then 2 passed (2) on a repeat | the concurrent document effort's file, and it is not stable in the first run |
| `marketing-assets-migration.test.ts` | 8 passed (8) | green |
| `marketing-bundle.test.ts` | 4 passed (4) | green |
| `marketing-leads.test.ts` | 8 passed (8) | green |
| `marketing-metrics-migration.test.ts` | 1 failed \| 1 passed (2) | red, stable across two runs, inherited |
| `marketing-publish-migration.test.ts` | 5 passed (5) | green |
| `om-client-history.test.ts` | 2 passed (2) | green |
| `restart-survival.test.ts` | 1 skipped (1) | skipped by its own unconditional `describe.skip` at `:13`, not by a missing URL |
| `semantic-recall.test.ts` | 1 skipped (1) | skipped, not passed. It needs `CRUM_SEMANTIC_RECALL_LIVE=true` and a live embedder |
| `tenant-isolation.test.ts` | 2 failed (2) | red, stable, inherited |
| `user-isolation.test.ts` | 3 failed (3) | red, stable, inherited |
| `wave1b-queries.test.ts` | 2 passed (2) | green |
| `api/video-api.test.ts` | 33 passed (33) | green. Its DB layer is mocked, so no URL is needed |

Eight green, three stable red, one that was red once and green the next time, and two skipped. Adding
the ten gives all 24 files in the lane a recorded status. The six stable red cases are named below with
their assertion text, and this task owns no code, so it reports them and stops.

`restart-survival.test.ts` deserves the extra sentence because its skip looks like the other kind in a
summary line. It does not need a URL, and its body is eight numbered comments ending in
`expect(true).toBe(true)`, so un-skipping it would prove nothing either. The restart criterion its
comment names is still unimplemented, and that goes to section 9.

`marketing-metrics-migration.test.ts` fails at `:59` with `expected 'marketing_metrics_snapshots_pkey'
to match /^pk_marketing_metrics_snapshots/`. `migrations/0020_crum_marketing_metrics.sql:7` creates the
column as `id uuid PRIMARY KEY` and names no constraint, so Postgres gives it the default `_pkey`
suffix and the test's regular expression can never match it. Both the migration and the test come
from slice 3, at `27f11a2` and `aa8788a`, and neither file is touched anywhere in `6ed390d..HEAD`.
The case has therefore never passed, and this slice is the first time anybody ran it.

`tenant-isolation.test.ts:94` and `:115` are the same line twice, `expect(Array.isArray(result)).toBe(true)`,
and both answer `expected false to be true`. `user-isolation.test.ts` fails three cases, and its
messages are not the ones the tenant file gives, so they are named here as the runner names them.
`owner can see their own customer` fails at `:88` with `expected undefined to be
'55555555-5555-5555-5555-555555555555'`, `non-owner cannot see the customer` fails at `:103`, where
`expect(result).toBeNull()` answers `expected { error: true, …(2) } to be null`, and `admin can see any
customer in their tenant` fails at `:119` with the same undefined against the same id. The read came
back as an error object rather than as rows or as null, and the error is the schema refusing the
fixture.

The fixtures are per file, and a reader going to look should know which file holds which.
`tenant-isolation.test.ts` uses `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` at `:35`,
`22222222-2222-2222-2222-222222222222` at `:37` and `11111111-1111-1111-1111-111111111111` at `:39`,
while `user-isolation.test.ts` uses `55555555-5555-5555-5555-555555555555`, `66666666-6666-6666-6666-666666666666`,
`77777777-7777-7777-7777-777777777777` and `cccccccc-cccc-cccc-cccc-cccccccccccc` across `:35` to `:38`.
None of the seven is RFC 4122 shaped, because a repeated digit always lands in the version nibble or
the variant nibble, and Zod 4.6.7 rejects all seven. This was measured rather than reasoned about:
`z.string().uuid().safeParse` answers INVALID for each of them and VALID for
`8f14e45f-ea2f-4b1b-9a1b-1234567890ab`. `src/mastra/tools/customers.ts:41`, which is where the schema
sits, is not in this slice's diff, the two test files are not in it either, and `package.json` is not
in it, so the dependency did not move. The failures are inherited, they were invisible only because
nobody ran those two files, and they are the same strictness Task 15 had to satisfy when it stopped
writing prose into `pending_writes.requested_by`.

`document-audit-flow.test.ts` is the concurrent document effort's file, added at `96448af`. It was
red on its first run in this session (`manual correction creates audit row with change_source=manual_correction`
and `uploads document, processes it, and populates audit trail`) and green when run again with no
change to any file. A test that is red once and green after is a test that depends on database state
another file left behind, and it belongs to that effort rather than to this slice. It is recorded
here because the run produced it, and it is not claimed as fixed.

## 5. Against the slice 4 baseline

Slice 4 recorded 206 in `tests/marketing`, 248 in `tests/governance`, 496 in `tests/mastra`, 149 in
`tests/db`, 282 in `tests/api` and 34 in `tests/config`, for 919 across the five directories. Today
the same five directories hold 1091 passed and 1 todo. No directory went down, so no test was
deleted.

| Directory | Slice 4 | Today | Read |
| --- | --- | --- | --- |
| `tests/marketing` | 206 | 299 | `site.test.ts` now holds 88 cases on its own, Tasks 1 to 5 grew it. New files `image-provider.test.ts` (5) and `meta-ads-config.test.ts` (9). Grew: `generate-assets-tool`, `image-spend`, `outbox`, `page-host`, `pixel-injection`, `publish-drain` |
| `tests/db` | 149 | 201 | New `timestamps.test.ts` (7) from Task 14. Grew: `marketing-assets`, `marketing-commit`, `open-stage-draft`, `reviewer-predictions`. Also carries the document lane's three new files, `audit-context`, `documents-field-confidence` and `field-audit` |
| `tests/api` | 282 | 303 | Slice 5 owns `documents.test.ts`'s asset exclusion. The lane added `document-audit.test.ts` and `document-correction.test.ts` |
| `tests/config` | 34 | 38 | `env.test.ts` grew for the image-provider settings and the spend ceilings |
| `tests/governance` | 248 | 250 passed, 1 todo | Not claimed. No file under `tests/governance/` changed in this slice and `policy/tools.yaml` did not either, so the two-case gap sits in the recorded baseline rather than in slice 5 work. The todo is `it.todo` in `conformance.test.ts`, introduced at `f4c53f6` |
| `tests/mastra` | 496 | 527 | Today's counts in the files this slice owns: `marketing-campaign-status-tool.test.ts` 23, `marketing-write-tools.test.ts` 43, `processors/write-claim-guard.test.ts` 22, `marketing-agents.test.ts` 29, `boot.test.ts` 40. The path is 496 to 518 at `151722e`, then +4 at `a345ab8`, +2 at `8629be5`, +3 at `1d85f96` |

The per-directory totals above are what the runner reports, which is the number this section uses.
Individual file counts were also taken from the runner rather than from a text search of the files,
because `it.each` and nested describes make a line count a different number from a case count.
`tests/mastra/agent.test.ts`, `marketing-boot.test.ts`, `prospect-merge-tools.test.ts` and
`prospect-tools.test.ts` changed their assertions in this slice without changing how many cases they
hold, which is why `prospect-merge-tools.test.ts` appears in the deviations list instead of here.

Console: 26 files and 223 tests today against slice 4's 24 files and 210 tests. One of those files
and six of those tests are `console/tests/DocumentProcessingDashboard.test.tsx`, which belongs to the
document effort, so they are not reported as slice 5's. Slice 5's own console movement is
`AssetManager.test.tsx`, new with 4 cases, and `KnowledgePage.test.tsx`, which Task 13 extended. The
run is green and it prints `act(...)` warnings from `tests/KnowledgePage.test.tsx` and
`tests/CampaignMetricsDashboard.test.tsx`, both of which predate this slice.

Step 3 also asked whether the invoice and contract tabs still read their own lists now that a third
kind shares the surface. Partially provable, and the difference matters.
`console/tests/KnowledgePage.test.tsx:36` switches to Invoices and waits on
`/api/documents?kind=invoice`, and the case at `:49` switches to Campaign images, waits on
`kind=marketing_asset` and then asserts at `:59` that the invoice route was requested zero times, so
a tab that had started reading the union instead of its own kind would fail. The Contracts tab is only
asserted to exist, at `:30`, and no case clicks it or reads `kind=contract`, so its own list is
unproven in this repository. That is a gap in the test file rather than a defect this slice introduced,
and it goes to section 9.

## 6. The walkthrough, step by step

**Not done.** The plan lists the credentials Step 5 needs and says that if any is missing, stop and
report the walkthrough as not done, and that this is a result rather than a delay. The owner's `.env`
holds 65 keys and none of these nine is among them: `CRUM_REPLICATE_API_TOKEN`,
`CRUM_META_ADS_ACCESS_TOKEN`, `CRUM_CLOUDFLARE_ACCOUNT_ID`, `CRUM_CLOUDFLARE_PAGES_PROJECT`,
`CRUM_CLOUDFLARE_API_TOKEN`, `CRUM_ANALYST_USER_ID`, `CRUM_IMAGE_PROVIDER`, and both image spend
ceilings, which the plan leaves unnamed and `src/config/env.ts:215` and `:231` name as
`CRUM_IMAGE_SPEND_CEILING_MINOR` and `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`. No key in the file
matches `SPEND`, `CEILING` or `BUDGET` at all, so neither ceiling is set by omission rather than by a
blank value.
Only the key names were read, never a value, and nothing in this report came out of that file.

Each of the plan's nine numbered steps, reported as itself rather than summarised:

1. Not done. It needs `CRUM_REPLICATE_API_TOKEN`, `CRUM_IMAGE_PROVIDER` and both ceilings, so the
   designer run and `marketing.generate_assets` could not be started and the ceiling arithmetic was
   never exercised at its real cost.
2. Not done. It needs step 1 to have produced a PNG, so neither the Campaign images tab nor the
   awaiting-review placeholder nor the 409 from the byte route was observed in a running system.
3. Not done. It needs a reviewed asset, so the `invalidatedBundles` count the review response
   returns was never read from a real response.
4. Not done. It needs a second person and a staged bundle.
5. Not done. It needs `CRUM_CLOUDFLARE_*` to publish and promote and drain.
6. Not done. There is no live preview URL to open, so no file name and no resolved path were
   recorded from a page on the host.
7. Not done. It needs a running API and the identity headers for a real document.
8. Not done. It needs `CRUM_META_ADS_ACCESS_TOKEN` for the scale and kill recommendations to reach a
   campaign.
9. Not done. It needs `CRUM_ANALYST_USER_ID` for the second half, and a running system for both
   halves.

No mock was substituted for a step and no step is described as partial. What R1 then rests on is the
integration proof in `tests/integration/marketing-asset-page.test.ts`, which drives the real drainer
against a local stub Pages server and asserts the uploaded manifest path, the bytes the stub
received, and that the hash signed at approval equals the hash recomputed from what was uploaded.
That is a real proof of the mechanism and it is not a live-environment fact. R1 is closed by the
mechanism and remains open as a live-environment fact, and the difference is the honest answer to the
plan's instruction that no R1 claim stands without the walkthrough.

To run the walkthrough later, the owner needs the nine settings above in the environment the API and
the console read, a Cloudflare Pages project the drainer may write to, and one campaign whose page
asks for a picture. Steps 1 to 7 need Replicate and Cloudflare. Steps 8 and 9 additionally need the
Meta token and the analyst user id.

## 7. Decisions a later reader will want recorded

The plan's five first.

The browse surface inherits the gate rather than opening its own door. Task 13 made
`marketing_asset` documents listable in the document manager, and the bytes still come from the same
route that withholds them until a prediction exists. A second route that could read the bytes
without a prediction would have made the review gate decorative.

No automatic provider fallback. R4 replaced a module global with a named registry selected by
config, and the absence of fallback is asserted rather than described. A silent fallback means a
spend ceiling on one provider is enforced while the bill arrives from another.

The ceiling is two-layer and the bundle layer is checked first. R3's per-bundle lifetime ceiling runs
before the tenant's daily ceiling, because the daily ceiling alone lets one bundle spend the whole
day and leaves the tenant's other bundles with nothing.

Invalidation rather than re-hash. R2 kills the open stage draft when an asset changes and moves the
bundle back to `draft`, rather than quietly recomputing the hash so the approval can survive. An
approval is a person's yes about specific bytes, and re-hashing under it changes what the yes is
about.

The guard list is bound by derivation. RV2 deleted `toHaveLength(16)` and no case states the list's
size now. The test derives the expected set from the loaded policy and the real registry and compares,
which is the only shape that can disagree with the source.

Six more that this slice earned while it was being reviewed.

A draft names the lane that staged it, and the field is required rather than defaulted.
`stageCampaignStatusChange` takes `origin: 'cron' | 'chat'` and the two lanes get different `run_id`
values. The review round found that a chat-staged draft was carrying the cron's `run_id`, which made
it unmatchable in the queue. A defaulted field would have let the lane that forgot to say inherit the
other lane's label.

A policy answer of `refuse` stores no draft. Round 2 shipped a clamp that stored the draft and
reported `refuse` as its gate. The rejected alternative was to keep storing, and the reason it was
rejected is the finding itself: no marketing commit path reads the `gate` column, so a stored `refuse`
was an approvable draft wearing a warning label. The one exception in the whole codebase is the email
branch at `src/db/pending-writes.ts:412`, which predates this slice and refuses a non-auto email
because the Gmail connector has a draft scope only, not because policy said so. Round 3 throws
`campaign_status_refused` before the insert.

The guard list stays hand-written in the source and derived in the test, because
`src/mastra/agent.ts:8` imports `./processors`, which imports `write-claim-guard`, so a guard that
imported the registry to build its own list would close a cycle through the module that owns the
registry. That is a layering constraint rather than a preference.

`POLICY_DIR` is documented at `.env.example:90` and is decorative in production. The only reader that
honours it is `src/governance/index.ts:6`, no `src/` module imports that singleton, and 38 direct
`loadPolicy()` calls across the tool files ignore it. Slice 5 found this while reviewing Task 18 and
does not own it.

`campaignExternalId` is free text up to 64 characters with no shape validation, which is how a
prose-bearing id could reach a `refuse` score in the first place. It is parked. The refuse branch
removes the consequence, not the cause.

Integration files in this repository are run one at a time before they are run together, because they
share one database and the second form can turn a green file red. The combined ten-file run and the
ten single-file runs were both recorded, and the `document-audit-flow` flip is why that habit exists.

## 8. Deviations from the plan, each with its reason

Step 5 was not run, for the credential reason in section 6. This is the plan's own rule, applied.

The integration list grew from ten files to all 24 in the lane. The plan named ten, and the other
fourteen were run by the controller after the ten came back green, because a verification report that
stops at a plan's arbitrary list inherits the plan's blind spots. That is how the six inherited red
cases in section 4 were found, and how one file that has never run in three slices was found to be a
placeholder.

`tests/mastra/prospect-merge-tools.test.ts` was edited at `151722e` to close a red this slice caused.
Task 14's timestamp normaliser refuses a `created_at` that is neither a `Date` nor a string, and that
file's stub of `INSERT ... RETURNING *` answered with only an id, which is a row no driver can return.
Three cases in the prospect lane went red and were fixed in the prospect lane's test, with the source
left alone.

`tests/integration/marketing-campaign-status.test.ts:118` was changed by one line, owned by Addendum
A7, so the tree could typecheck.

`tests/scripts/analyst-cron-config.test.ts` no longer exists. Its cases moved to
`tests/marketing/meta-ads-config.test.ts` with 9 cases, because a per-process registry needs a test
that can reach the registration, and that file was the one place it was reachable. The directory
totals therefore carry cases the plan did not predict.

Task 17's first review round produced two reviewers writing the same file, and one review's body was
lost. It was reconstructed from the reviewer's returned summary and the provenance is stated inside
that file rather than hidden. From that point every reviewer was given its own path, named before the
review existed.

The Task 17 round-2 implementer reached the harness turn limit after writing the code and before
running its gate or its report. Its work was kept, and the gate, the four mutations and the report
were performed by the controller and labelled as controller-authored. The round-3 and Task 18
dispatches carried explicit tool-call budgets and the instruction to commit before writing the report.

The clamp round 2 shipped was replaced by a throw in round 3, because the review measured that the
clamp's stated justification was false. A reviewer's claim was re-measured rather than absorbed, and
the measurement is what changed the design.

Nineteen tasks were briefed against a plan whose line numbers were read off an older commit. Forty-five
drifts and rulings are recorded as `R-1` to `R-45` in the slice ledger at
`.superpowers/sdd/2026-11-02-marketing-team-slice-5/progress.md`, and every one was resolved against
the quoted code rather than the number.

`tests/evals/golden-gate.test.ts` was never run, so the golden gate is unproven in this slice by
choice, and `npm run verify` was never run because it chains `npm run test` and exits non-zero in this
repository by design.

This report was written by the controller rather than by a dispatched implementer. The dispatch could
not start because the system drive was full at the moment of the attempt, with 1.5 GB free of 297 GB
on `C:`, and nothing was deleted to make room. The deliverable lives on `D:`, so the work continued
here.

## 9. What slice 5 left open for slice 6

The largest hole is that no decision route reads `gate`, and only one branch of the commit path does.
The decision route at `src/api/approvals.ts:244` checks identity, a prior decision, `committedAt` and
expiry, and never the column. `applyDraft` at `src/db/pending-writes.ts:402` dispatches on
`object_type`, and its single reader of the column is the email branch at `:412`, which refuses a
non-auto email because the Gmail connector has a draft scope only. That check arrived at `1a9c7a2`, an
ancestor of this slice's base, so it is precedent rather than this slice's work, and it is the shape a
marketing rule would copy. The value is read into the queue item at `src/api/approvals.ts:72`, so a
human can see it, and seeing it is not enforcement. One naming trap for whoever fixes this: line `:245`
binds `const gate = await auth(c)`, which is the authentication gate rather than the policy gate, and
the two will read as one thing in a diff. Slice 5 closed the consequence for one tool by refusing to
store a refused draft, and the exposure remains for every object type except email: a marketing bundle
or campaign-status draft stored with `gate` equal to `refuse` would still be approvable. That is a
governance change with its own blast radius, and it should be its own task rather than a side effect.

`POLICY_DIR` is decorative in production, described in section 7. A deployment that sets it gets 40
`loadPolicy()` call sites under `src/` that ignore it, 38 of them inside `src/mastra/tools`.

The guard list has a stale window. The next registered mutating tool must land in the same commit as
its guard id, and the derived case in `tests/mastra/processors/write-claim-guard.test.ts` is the thing
that says so out loud when it does not. `src/evals/custom-scorers.ts:55` reads the same list and
inherits the same window.

`campaignExternalId` has no shape validation, parked with the reason in section 7.
`marketing.set_campaign_status` instructions name an admin-only tool to every role that reads the
marketing instructions.

The pixel is injected after the hash is computed, carried forward unchanged from slice 4. `reason`
lives only in the chat turn rather than in the draft, also carried forward. There is no `users` table
behind `pending_writes.requested_by`, so a requester id has nothing to join to.
`npm run verify` stays red by design.

Deferred items that came out of Tasks 16 and 17 and are recorded here so they do not evaporate:
boot's duplicated Meta parse at `src/mastra/index.ts:158`, the `marketing_stage` and
`marketing_promote` wording that promises the drainer will back-fill a field, `commitWithReceipt`
approval-race hardening, payload-hygiene coverage for the campaign-status payload, the four unchecked
`requestedBy` sites, the golden dataset's seven defects that made the gate red at baseline,
`src/api/message-mapping.ts:69`, `pending-writes.ts:97`, `tests/db/open-stage-draft.test.ts:102`,
`src/mastra/workflows/approval-flow.ts:39`, the analyst cron's untested `main()`, and the analyst's own
invisibility in the
queue it feeds.

New in this report, from the wider integration sweep: `tests/integration/migrations.test.ts` holds the
two inherited failures slice 4 already named, and three more integration files are red for reasons that
predate this slice. `marketing-metrics-migration.test.ts` asserts a constraint name migration 0020
never gives, and `tenant-isolation.test.ts` and `user-isolation.test.ts` use fixture uuids that Zod 4
rejects. Five red cases in two files, plus one case that can never pass, are the cheapest slice 6
work in this list, and none of it belongs to slice 5.

`tests/integration/restart-survival.test.ts` is the Phase 3 restart criterion and it has never run. It
carries an unconditional `describe.skip`, its body is a comment list ending in `expect(true).toBe(true)`,
and so the claim that an approval still resolves from `pending_writes` after the process dies is not
tested anywhere in this repository. Task 16's `applyDraft` branch makes that claim more load-bearing
than it was, because a work order now hangs off the same row.

The Contracts tab has no read of its own kind. `console/tests/KnowledgePage.test.tsx:30` asserts the
tab is on screen and nothing else, while Invoices and Campaign images each have a case that waits on
their own `kind=` route, and the Campaign images case additionally asserts the invoice route stays at
zero requests. So a Contracts tab that read the union of all three kinds, or read nothing at all, would
stay green today. Slice 5 put the third kind on that surface and did not touch the first, which makes
this the natural moment to close it: one case, clicking Contracts and waiting on `kind=contract`, would
put all three tabs under the same rule.

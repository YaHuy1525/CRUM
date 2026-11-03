# Task 15 review round 2 — `45a0f75` fix(marketing): the analyst cron registers the status action it stages

Independent review of the fix wave answering `task-15-review-1.md`. The reviewer did not write this
code, edited nothing, staged nothing and committed nothing. Every command below was read-only, a test
run, or a database read/write against `crum_slice5` on port 5455 through the project's own suites.
`tests/evals` was not run. No cluster was started, stopped or reconfigured; `netstat -ano | grep 5455`
showed PID 8096 listening on `127.0.0.1:5455` and `[::1]:5455` before and during the run. No provider
was called: no Replicate, no Meta domain, no Cloudflare. Every credential used in a probe was a dummy
literal (`dummy-token-not-real`); `.env` was inspected for key **names** only, never values.

**Verdict: DONE WITH FINDINGS — the Critical (C-1) is genuinely closed, and proven closed in a real
process.** A cron run in the shape the script's own header documents (`npx tsx scripts/analyst-cron.ts`)
now has `isExecutable('set_campaign_status') === true` when both Meta settings are present, and the real
`stageCampaignStatusChange` gets past the executability guard in that same process. Six of the seven
contract items are closed as described; one (M-2) is reported as closed and is **not** closed — the
rewritten sentence makes the same false claim review 1 flagged, in new words. All five gates are green,
and the repo-wide typecheck/lint lanes are clean right now with zero diagnostics in this commit's files.

**Counts: 0 Critical, 1 Important, 5 Minor.**

Reviewed against: `task-15-review-1.md` (fix list C-1, I-1, I-2, M-1…M-6), `task-15-brief.md`,
spec `docs/superpowers/specs/2026-11-02-marketing-team-slice-5-design.md` §9.1–9.3, and the ledger,
which grew `R-33`…`R-39` **during this review** (it was 787 lines when I opened it and 888 when I
finished; I read the whole of §788 onward).

## 0. Commands run

```bash
git show --stat 45a0f75
git diff --stat 45a0f75 -- <the seven owned files>          # empty: worktree == commit for the owned set
npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/config/env.test.ts \
               tests/scripts/analyst-cron-config.test.ts    # run twice
npx vitest run tests/db/pending-writes-commit.test.ts tests/db/open-stage-draft.test.ts \
               tests/api/marketing.test.ts tests/governance/marketing-payload.test.ts \
               tests/mastra/marketing-boot.test.ts
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/analyst-cron.test.ts        # run twice
npx vitest run --project integration tests/integration/analyst-cron.test.ts \
     -t "cannot stage because this process cannot run the action"                  # order check
npm run typecheck        ; npm run lint        # run twice each, both clean
npx eslint scripts/analyst-cron.ts src/config/env.ts src/mastra/tools/marketing-writes.ts \
         tests/integration/analyst-cron.test.ts tests/mastra/marketing-campaign-status-tool.test.ts \
         tests/scripts/analyst-cron-config.test.ts
npx vitest run tests/mastra tests/scripts tests/config tests/db tests/governance tests/marketing tests/api
npx tsx -e …            # Probe A (import only), Probe B+D (main() via spoofed argv), Probe C,
                        # PROBE_M4 (guard against a real Postgres), GOLDEN (uuidFromSeed × 2 processes),
                        # MUTANT (mutated config read against the unit case's inputs),
                        # ID_SHAPE strictness, loadEnvFile precedence
npx tsx scripts/analyst-cron.ts --tenant 9c1f0a3d-…       # the documented entry point, twice:
                        # once with token+accounts, once with accounts blank
git show HEAD:src/db/pending-writes.ts | grep …            # status branch absent at HEAD
grep -rn "INSERT INTO marketing_actions" src/ ; grep -rn "requested_by" migrations/*.sql
git log -S … ; git status --short
```

## 1. Gates — exact output, re-run at the end of the session

Named unit files (twice, identical):

```
 ✓  unit  tests/config/env.test.ts (38 tests) 26ms
 ✓  unit  tests/mastra/marketing-campaign-status-tool.test.ts (12 tests) 14ms
 ✓  unit  tests/scripts/analyst-cron-config.test.ts (5 tests) 5ms
 Test Files  3 passed (3)
      Tests  55 passed (55)
```

12 (was 10: the malformed-actor case and the golden-literal case), 38, 5. Adjacent set:

```
 Test Files  5 passed (5)
      Tests  75 passed (75)
```

Integration, URL exported in the same shell:

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

**12 collected, 12 passed, and `grep -c skipped` over the same run's output returns `0`** — the word does
not appear, so `describe.skipIf(!url)` did not fire. The log shows both staging cases writing real rows
(`staged ACTIVE draft 66f9eefc-… for camp-ext-20-a`, `staged PAUSED draft dcc7c52a-… for camp-ext-20-b`)
and the new refusal case running. The new case also passes in isolation under `-t`
(`1 passed | 11 skipped` — skipped by the name filter, not by the URL guard), so it is order-independent.

`npm run typecheck` → `tsc --noEmit`, **no diagnostics, exit 0**, on both runs. `npm run lint` →
`eslint .`, **no diagnostics, exit 0**, on both runs. `npx eslint` over the six owned `.ts` files exits 0.

**Attribution of diagnostics.** The briefing said the last known state was one typecheck error in the
untracked `tests/helpers/test-server.ts` and four lint errors in `tests/helpers/test-server.ts` and
`tests/api/document-audit.test.ts`. **I saw neither.** Both lanes were clean at 15:22 and again at 15:44,
so at my timestamps there are 0 repo-wide diagnostics and therefore 0 in this commit's 7 files; the
documents/queue effort fixed its own untracked files inside my window (both files are still `??` in
`git status`). `tsconfig.json` includes `tests/**/*.ts`, so `tests/helpers/` really was in the lane, and
the clean result is a real change of state, not a scope artefact. The ledger's `:834` records the red
state I did not see; both statements are true of their own moment.

Wider unit neighbourhood (7 directories, deliberately avoiding `tests/evals`):
`Test Files 4 failed | 124/125 passed`, `Tests 12 failed` on one run and `8 failed` on two others. All
of it is attributed away from this commit:

- 6 failures are the committed-red Task 14 fallout review 1 already named: `tests/mastra/prospect-tools.test.ts`
  (3) and `tests/mastra/prospect-merge-tools.test.ts` (3), `pending_writes.created_at is neither a Date
  nor a string: undefined` at `src/db/timestamps.ts:27` via `rowToPendingWrite` (`src/db/pending-writes.ts:97`).
- 2 are `tests/mastra/workflows/ingest-asset-guard.test.ts`, from the uncommitted documents/queue edits.
- 4 appeared once in `tests/db/marketing-commit.test.ts > approving a campaign status draft`, under a
  7-directory parallel run only. At the moment they failed they were **not committed code**: `git status`
  showed `tests/db/marketing-commit.test.ts` modified (`+152`) and `src/db/pending-writes.ts` modified
  (`+85`, one hunk `@@ -635,6 +635,91 @@ async function applyDraft`), i.e. Task 16 being written in this tree
  while I reviewed. That work has since landed on the branch as `19fdcee` (3 files:
  `src/db/pending-writes.ts`, `tests/db/marketing-commit.test.ts`,
  `tests/integration/marketing-campaign-status.test.ts`; **none of the owned seven**), and the file now
  passes cleanly (`12 tests`). Not this commit's, and a second instance of review 1's "run the whole
  project, not named files" point.

**Moving-tree caveat, stated because it bit me:** my first `grep -rn "INSERT INTO marketing_actions" src/`
returned 3 hits and the identical command minutes later returned 4, including
`src/db/pending-writes.ts:712`. The concurrent effort saved the file between my two calls. Everything in
§2–§5 was re-checked after that; the owned seven files are byte-identical to `45a0f75`
(`git diff --stat 45a0f75 -- <seven>` prints nothing), which is what makes the gate results attributable.
**The branch also moved under the review: `45a0f75` was `HEAD` when I started and is five commits behind
it now** (`git rev-list --count 45a0f75..HEAD` → 5: `00b0033` audit endpoint, `721b268` the ledger round,
`c56c123` correction endpoints, `19fdcee` Task 16, `0d909b3` a correction-endpoint connection fix). Every
claim below is therefore anchored to an explicit hash, not to `HEAD`: the §3 check that `applyDraft` has
no status branch was re-run as
`git show 45a0f75:src/db/pending-writes.ts | grep -c "draft.objectType === 'marketing_set_campaign_status'"
→ 0`, which is what the reviewed commit contains. None of those five commits touches the owned seven.

## 2. C-1 is closed in a real process, not just in a comment

Review 1 disproved `0a21d8a` with import-only probes. Reproducing that shape first, then the fix:

**Probe A — import alone still registers nothing (as the implementer says):**

```
PROBE_A isExecutable after cron module import = false | statusAdapterConfigFromEnv type = function
```

Registration is in `main()` (`scripts/analyst-cron.ts:442-449`) behind the run guard at `:477-483`, so
an import-only probe is the wrong instrument. `main()` is not exported (`:411 async function main()`),
so the only ways to drive it are a child process or the argv-based guard.

**Probe B/D — spoofed argv, test database, dummy token + accounts, an empty tenant:**

```
[analyst-cron] no active campaigns; nothing to analyse
[analyst-cron] done: 0 campaign(s), 0 snapshot(s) collected, 0 draft(s) staged, 0 error(s)
PROBE_B isExecutable(set_campaign_status) after main() ran = true | isExecutable(create_campaign) = false
PROBE_D refusal = campaign_not_found: no succeeded create_campaign action for external id 23842653876 on bun
```

`main()` really ran (env loaded, test DB connected, `listActiveCampaigns` answered), the registry it
populated is the same `Map` the staging guard reads (`src/marketing/outbox.ts:70`, one module instance),
and the production `stageCampaignStatusChange` then fails **one step later than before**: on the DB
existence read rather than on `isExecutable`. That is the exact thing review 1's Critical said was
missing. The tenant was chosen to have zero active campaigns so no Meta readback and no model call could
occur (`scripts/analyst-cron.ts:259-262` returns before both).

**Probe C — the else-branch, token present and accounts blank:**

```
[analyst-cron] no set_campaign_status adapter in this process; a scale or kill recommendation will refuse to stage rather than queue work nothing can run
PROBE_C isExecutable after main() with accounts blank = false
PROBE_C refusal = provider_not_configured: this process has no set_campaign_st
```

**The documented entry point, as an operator runs it** (`npx tsx scripts/analyst-cron.ts --tenant …`,
twice, dummy values): with token+accounts the run prints no adapter warning at all; with accounts blank
it prints the `:446-448` warning and exits 0 having staged nothing. So the warning is a real operator
signal, not dead text.

**Precedence check, because `main()` loads `.env`:** with `DATABASE_URL=SENTINEL-VALUE` set on the
command line, `process.loadEnvFile('.env')` left `process.env.DATABASE_URL` and
`parseEnv().DATABASE_URL` at the sentinel. My probes could not touch the developer database.

**Judgement on the copy of boot's parse.** The parse at `scripts/analyst-cron.ts:210-228` and
`src/mastra/index.ts:158-179` agree on every decision: both-or-nothing (`!accessToken || !raw` vs
`if (metaToken && metaAccountsRaw)`), warn-and-refuse on unparsable, null for `[]`. `CRUM_META_AD_ACCOUNTS`
is `optionalString` (`src/config/env.ts:192`), i.e. still a raw string in the parsed env, so the copy is
not double-parsing an already-parsed array — the failure mode I looked for hardest and did not find.
Acceptable for one commit: the duplication is disclosed in the docstring at `:201-204`, and `R-39` item 1
and item 3 (ledger `:855`, `:857`) schedule the extraction into `src/marketing/meta-ads-config.ts` and the
migration of these five tests. **I disagree with the stated reason, not the conclusion.** The pin is on
boot's *warning string* (`tests/mastra/marketing-boot.test.ts:54-57`, `expect.stringContaining('Failed to
parse CRUM_META_AD_ACCOUNTS')`) and on its `isExecutable` outcomes (`:52-53`); a shared
`metaAdsConfigFromEnv(env, label)` preserves both byte-for-byte, which is precisely what R-39 then rules.
"boot's version is pinned" justified not touching boot; it did not justify a second parser.

## 3. The other six claims, checked against the tree

**M-4 (uuid shape) — closed, and proven against a real Postgres.** `marketing-writes.ts:873`
`if (!args.userId || !ID_SHAPE.safeParse(args.userId).success)`; `ID_SHAPE` is `:631`
(`z.string().uuid()`), so the comment's "borrows it rather than writing a second one" is true. Runtime
probe with the adapter registered and the test DB reachable:

```
PROBE_M4 userId="analyst-cron"                     -> campaign_status_actor_required: the status change on 23842653876 needs a uuid
PROBE_M4 userId="not-a-uuid"                      -> campaign_status_actor_required: …
PROBE_M4 userId=""                                -> campaign_status_actor_required: …
PROBE_M4 userId="55555555-5555-4555-8555-555555555555" -> campaign_not_found: no succeeded create_campaign action …
```

The refusal happens before any query reaches Postgres, and a well-shaped uuid proceeds — i.e. the guard
closes the 22P02 class rather than the empty case, exactly as asked. I also checked the thing that could
have made this a false-refusal machine: `zod 4.6.7`'s `uuid()` accepts version-6/7 shapes, the nil uuid
and upper case, so `ID_SHAPE` is no stricter than the `uuid` column. (zod 3's regex would have rejected a
UUIDv7 actor; it does not apply here.)

**I-2 (asymmetry + forward guard) — closed, and the factual claim is true of this commit.** The comment
(`marketing-writes.ts:913-932`) claims nothing in `src/` writes a `set_campaign_status` row. Verified
independently: at `45a0f75` (`git show 45a0f75:src/db/pending-writes.ts`) there is no
`if (draft.objectType === 'marketing_set_campaign_status')`, and `COMMIT_TARGETS` has no such key
(`:277` region holds `marketing_bundle` only), so approval falls to `requireTarget` (`:296-304`) and raises
`UnsupportedCommitError`. The only three inserts of `marketing_actions` in that tree are
`src/db/pending-writes.ts:566` (`'promote_page'` literal), `:631` (`row.action`, cloned from a *failed*
action that could only exist if a status row already existed) and `src/marketing/outbox.ts:312`
(`action.action` from `deriveActions`, which emits only `publish_page` at `:132` and `create_campaign` at
`:141`). The "same two filters / the data lane's rule" claim also holds: `src/db/marketing.ts:499-508` is
byte-identical in predicate shape (`tenant_id`, `action`, `payload ->> 'campaignId'`, no bundle).
So `campaign_already_active` is a forward guard in the reviewed commit, as stated — and `19fdcee`, five
commits later, is the branch that stops that being true.

**M-2 (`target_id` comment) — claimed fixed, NOT fixed. See Important I-A below.** The dedupe attribution
is now right (`ON CONFLICT (tenant_id, draft_hash)` at `src/db/pending-writes.ts:111`, cited correctly),
but the second half-sentence is false in the same way review 1's original was.

**M-3 (`env.ts` / `.env.example` wording) — closed.** No migration adds a foreign key on `requested_by`
(`grep -rn requested_by migrations/*.sql` returns three bare column definitions: `0002:158`, `0002:199`,
`0015:148`), so `env.ts:240-244` and `.env.example:273-275` now say shape is enforced and identity is the
operator's judgement, and the schema message (`:247-249`) no longer claims "a real user". The env test's
assertion is on the issue path and the variable name (`tests/config/env.test.ts:279-280`), not the old
sentence, so the retarget did not weaken it — 38 cases still pass.

**M-1 (golden literal) — closed and the value is right.** `npx tsx -e` in two fresh processes both
printed `ff96fb60-5cb9-8d7d-b265-918605379b58` for `uuidFromSeed('campaign:23842653876')`, matching
`tests/mastra/marketing-campaign-status-tool.test.ts:330`.

**M-5 / I-1 (integration disclosure + pinned refusal) — closed as disclosure, honestly worded.**
`tests/integration/analyst-cron.test.ts:96-104` now says the passing aggregation case is evidence about
totals and not about the lookback, and cites `analyst-cron.ts:251` (window start = `end − 7d`) and `:283`
(the `insertSnapshot` call) — both citations land on the lines they name, and the filter they cannot
clear is `src/db/marketing-metrics.ts:124`. `:138-147` says the `beforeAll` stub stands in for `main()`'s
registration, which this file does not run, and cites `scripts/analyst-cron.ts:206` — correct, that is the
`export function statusAdapterConfigFromEnv` line. The new case at `:346-384` is load-bearing: with the
`isExecutable` guard deleted, the fixture's succeeded `create_campaign` for `BUNDLE_B`/`CAMPAIGN_B` would
let the call reach `getOrCreateDraft`, so `stagedDrafts`, the `provider_not_configured` count and
`countPendingWrites(...)=0` all fail three ways; Probe C and Probe D show the two real outcomes the case
separates. It restores its own registration in `finally` (`:378-381`), and `afterAll` (`:126`) unregisters
the current handle, so no leak into later cases.

**M-6 — correctly absent from the commit.** `git show --stat 45a0f75` has no `progress.md`. The ledger
now carries it: `R-34` (`:800-804`) records the `CRUM_IMAGE_PROVIDER` carry-in, verifies it against the
parent, and rules it "accepted as substance, recorded as a hygiene miss". That is what review 1 asked for,
delivered by the controller rather than the commit.

## 4. Fix list

Ordered by severity; each item is one small, independently landable edit. I made none of them.

1. **I-A — the `target_id` comment still says something false about where the raw Meta id lives.**
   `src/mastra/tools/marketing-writes.ts:979-980`: "The real id stays in `payload.campaignId`, **the one
   field of the row that carries it in the clear**". It is not the one. `getOrCreateDraft` binds
   `params.idempotencyKey` **verbatim** into `draft_hash` (`src/db/pending-writes.ts:124`, with the
   `ON CONFLICT (tenant_id, draft_hash)` at `:111`), and this call passes
   `idempotencyKey: campaign_status:${args.campaignExternalId}:${args.status}`
   (`src/mastra/tools/marketing-writes.ts:986`), so the row's `draft_hash` is
   `campaign_status:23842653876:PAUSED` — the id, in the clear, in a second field. The column is `text`
   (`migrations/0003_crum_add_draft_hash.sql:10`). Review 1's M-2 flagged exactly this ("the raw Meta id
   survives in the row twice"); the commit dropped the phrase "the only copy" and replaced it with a
   synonym of the same claim, so the item is not closed while the commit message says it is. The ledger
   inherits the error in the opposite direction at `:828` — "since `draft_hash` **digests** a key that
   embeds it" — which is true of migration 0003's one-off backfill (`encode(sha256(payload…))`, `:13-14`)
   and of callers that pass a hash (`idempotencyKey: inputData.draftHash`, e.g.
   `src/mastra/tools/approval-writes.ts:75`), but false of this insert path, which supplies prose.
   Why this is Important and not Minor despite being a comment: it is a false factual claim, in the file
   the task exists to make truthful, that the next reader will trust — and it is being copied into the
   ledger as the reason. Landable fix: one clause — "the only field of the row that carries the id *as a
   field*; `draft_hash` also contains it inside the idempotency key (`:986`), and unlike other callers
   this one passes that key in the clear rather than as a digest".
2. **M-a — the line that closes C-1 is not covered by any test.** `scripts/analyst-cron.ts:442-449` is
   the fix; `statusAdapterConfigFromEnv` is only the read. Deleting `registerActionAdapter(…)` (or the
   `if (statusConfig)` around it) leaves all five gates green: `main()` is not exported (`:411`), no test
   references it (`grep -rn "makeSetCampaignStatusAdapter" tests/` answers only
   `tests/marketing/meta-ads.test.ts:168-170`, which builds the adapter itself), and the integration file
   registers its own stub in `beforeAll` (`tests/integration/analyst-cron.test.ts:148`). Probe A is the
   mechanical proof that nothing else in the module graph registers. So today the guard against
   re-introducing C-1 is a comment plus my ad-hoc probe. The sibling script has the same shape
   (`scripts/publish-drain.ts:309-317`, also an unexported `main()`), so this is convention rather than
   sloppiness — but the convention is the thing that let C-1 ship. Landable: have `main()` call an
   exported `registerStatusAdapterFromEnv(env): boolean` that does read-then-register and warns, and give
   `tests/scripts/analyst-cron-config.test.ts` one case asserting `isExecutable('set_campaign_status')`
   flips to true and back (unregistering via the handle `registerActionAdapter` returns,
   `src/marketing/outbox.ts:74-79`). Best done inside R-39's move (ledger `:857`), which touches the same
   lines.
3. **M-b — the new unit file does not actually pin the "both-or-nothing" half its comment claims.**
   `tests/scripts/analyst-cron-config.test.ts:39-44` asserts `null` for accounts-missing, token-missing
   and accounts-blank. A mutant that drops `!raw` from `scripts/analyst-cron.ts:212` — i.e. registers
   whenever a token exists — returns `null` for all three anyway, because `JSON.parse(undefined)` and
   `JSON.parse('')` throw into the same warn-and-null path. Measured:
   `MUTANT … input 0 -> null = true; input 1 -> null = true; input 2 -> null = true`. So the case catches
   the *dangerous* mutant (defaulting the missing list, e.g. `['*']`, which would return a config) but not
   the one its own comment names ("`src/mastra/index.ts:158` requires both"). Landable: add a
   `console.warn` spy to that case and assert `0` calls for the two accounts-missing inputs — the
   *absence* of a warning is what distinguishes the guard from a parse failure. Related nit in the same
   file: case 5 (`:59-62`) has no spy either, so `[analyst-cron] Failed to parse CRUM_META_AD_ACCOUNTS: …`
   leaks to stderr twice in an otherwise silent unit run.
4. **M-c — "the way boot reads it" is true of the parse and not of the registration.** The docstring at
   `scripts/analyst-cron.ts:188-205` cites `src/mastra/index.ts:155-176`, but boot registers two adapters
   there (`:174-175`) and the cron registers one (`:444`). Probe B measured the difference:
   `isExecutable(set_campaign_status) = true | isExecutable(create_campaign) = false`. Nothing in the
   cron's path asks about `create_campaign` — the existence check at `:890` is a DB read — so there is no
   behaviour change today, and R-39 item 2 (`:856`) is going to make the *drainer* register both, which
   would leave this file the only one-registering-one. Landable either way: one sentence in the docstring
   saying status-only on purpose, or register both and let the extra map entry cost nothing.
5. **M-d — the I-2 comment states a present-tense fact about the repository that the next task
   invalidates.** `marketing-writes.ts:926-932`: "nothing in `src/` writes a `set_campaign_status` row
   yet … Until that lands this query returns zero rows in production". True of `45a0f75` (§3 above), and
   **already false on this branch**: `19fdcee`, committed during this review, adds the `applyDraft` branch
   whose insert writes exactly that row (`src/db/pending-writes.ts:712-716`), and it did not touch the
   sentence — its own file list is three paths, none of them `marketing-writes.ts`. That is the rot this
   item predicts, observed within one hour rather than hypothetically. Landable: point at the ruling rather
   than the tree — "see R-35; Task 16's branch makes this read live, and that task's review should re-check
   this paragraph" — which is what `:810` already promises the ledger to do.
6. **M-e — the guard's new wording is untested in the one place it is new.** `marketing-writes.ts:874-877`
   now distinguishes "received a value that is not one" from "received nothing", but both the old empty
   case (`tests/mastra/marketing-campaign-status-tool.test.ts:239-258`) and the new malformed case
   (`:302-325`) assert the same `/campaign_status_actor_required/`. A mutant that collapsed the two
   messages would stay green. Low value but free: one `toThrow` with the tail of the message per case.
   (The message deliberately does not echo the offending value, which is right — no user id in a log.)

## 5. Parked for the final review

- **Who drains the Meta lane — now owned, so verify rather than re-raise.** `R-39` (ledger `:847-860`)
  rules the drainer registration into Task 16, and the reading behind it checks out: `grep -rn
  "drainOnce|claimNextQueued" src/` finds no in-process drainer, so `scripts/publish-drain.ts` is the only
  executor and at `:309-317` it registers page adapters only. Consequence of this commit, stated plainly:
  the failure locus moved. Before `45a0f75` a correctly configured cron staged nothing; now it stages a
  draft that, in that commit's own tree, dies at approval on `requireTarget`/`UnsupportedCommitError`
  (`src/db/pending-writes.ts:296-304` at `45a0f75`). Fails closed either way, and the cron's own comment
  (`:439-441`) admits the adapter "is only a map entry until a drainer executes it".
  **Still open, on purpose:** `19fdcee` landed Task 16's branch but its message records that the drainer
  registration, the shared `meta-ads-config` module and the analyst-cron move "deliberately did not land in
  this commit, because another review is in flight over exactly those files… until then a queued Meta
  action is only executable in a process that registers the adapter itself". So R-39 items 1–3 remain owed,
  this review is the reason they are parked, and the final review must confirm they landed. The last clause
  of that quote is the honest summary of the lane after `45a0f75`: the cron is now such a process, and the
  drainer is not.
- **`listRecentSnapshots` self-invisibility.** Unchanged by this commit, and now disclosed in the file
  that could otherwise hide it (`tests/integration/analyst-cron.test.ts:96-104`), which is what `R-38`
  ruled. Still a product decision about the 7-day window at `scripts/analyst-cron.ts:250-251` versus
  `src/db/marketing-metrics.ts:124`.
- **The shared Meta config read.** `R-39` item 1/3 owns it (`metaAdsConfigFromEnv(env, label)` in
  `src/marketing/meta-ads-config.ts`, cron switches to it, its five tests move). My §2 disagreement is
  about the *reason* recorded for the copy, not the plan; the plan already lands on my conclusion.
- **`requested_by` audit truth.** `R-37` refuses the users-row resolution in `main()`; the operator's
  judgement is the documented answer. If it stays the answer, the four other unchecked `requestedBy`
  write sites (`marketing-writes.ts:236`, `:556`, `:724`, `:833`, plus the same shape across
  `approval-writes.ts`, `auto-writes.ts`, `customer-writes.ts`) need one answer in Task 18, as `R-36`
  (`:816`) says. One guard in one function does not make the convention safe.
- **Re-run the whole unit project, not named files.** Two of the three red sets I found live in files no
  task's five-file gate list contains: the six committed prospect failures review 1 already reported, and
  the four load-dependent `marketing-commit` cases that only failed in a 7-directory run and belong to the
  uncommitted Task 16 hunk. Task 19 needs one full-lane run on a tree that is not being written under it.
- **Concurrency hygiene, from the inside.** The ledger's own note (`:838`) forbids the round-2 reviewer
  and the controller from running the integration lane at the same time on the same `TENANT`; during this
  review the source file under both lanes was edited mid-session (my `INSERT INTO marketing_actions` grep
  changed result between two calls), and `progress.md` grew by 100 lines while I read it. Worth one rule
  for the final review: pin a `git stash`-free read-only snapshot, or accept that anything outside the
  owned file set is evidence about a moving target.
- **The cron's run guard.** `scripts/analyst-cron.ts:477-483` matches
  `argv[1].endsWith('analyst-cron')`, so *any* path ending in that string boots `main()` at import;
  `scripts/publish-drain.ts:349-353` uses the strict `import.meta.url === pathToFileURL(resolve(entry)).href`
  identity check and explains why. Pre-existing (`0bf70bc`), not this commit's, and it is the mechanism I
  used to drive Probe B — worth aligning when R-39 item 3 edits this file anyway.

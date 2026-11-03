# Task 16 review round 2 — `a573a1f` "fix(marketing): the publisher registers the Meta lane it is asked to drain"

Reviewer: independent (did not write the code). Controller-authored commit, reviewed to the same bar as an implementer's. Branch `feat/marketing-slice-5`. Read-only except this file; temporary mutation confined to `scripts/publish-drain.ts` and proven restored.

## Verdict

**Approve with nits.** The commit genuinely closes R-39: `scripts/publish-drain.ts` `registerDrainAdapters()` now calls `registerMetaLane(env, 'publish-drain')` (`scripts/publish-drain.ts:336`), which registers both Meta adapters into the per-process map (`src/marketing/meta-ads-config.ts:90-91`), and I proved the drain path runs a `create_campaign` row only because of that call. The config move is faithful, the test set is network-free, the page lane is unchanged, and the design choices (the record return, the `Array<() => void>` instead of a boolean) are all load-bearing, not over-built. Typecheck is exit 0, the six owned files lint clean, and both unit lanes and the integration file run green.

There is **1 Important** finding and **3 Minor**. None is a shipping-behavior defect. The Important one matters because it falsifies the verification the controller recorded for itself: the mutation cited as "proves the new block" does not do what the ledger and the commit message say it does, and the real guard is a different line. Severity counts: **Critical 0, Important 1, Minor 3.**

Two deferred items from the earlier round are both resolved (see "Deferred items" below).

---

## Findings

### Important 1 — the recorded mutation does not prove what it claims (`scripts/publish-drain.ts:336-337`, `tests/marketing/publish-drain.test.ts:269`, ledger `progress.md:1036`)

**What is wrong.** `progress.md:1036` states that "Deleting `handles.push(...metaLane)` gives `Tests 3 failed | 5 passed (8)`, naming `maps all four queued actions`, `drains a campaign row rather than recording no_adapter`, and `reports the page lane as missing when only Meta is configured`." I ran that exact single-line deletion twice and got `3 failed | 5 passed (8)` — but the `drains a campaign row` case **PASSES**, and the third failure is `says which lane a half-configured host is missing` instead. The commit message's framing ("the drain file gains the wiring proof that fails if the Meta push is deleted") and the `describe` header at `tests/marketing/publish-drain.test.ts:208-217` inherit the same misstatement.

**Why it happens.** R-39's actual closure is `registerMetaLane`'s side effect on the module map (`src/marketing/meta-ads-config.ts:90-91`), which runs whether or not the handles are collected into the returned array. `handles.push(...metaLane)` at `:337` only governs the **undo closures** in the returned record. `metaConfigured` at `:341` is `metaLane.length > 0`, still true with the push deleted, so `drains a campaign row`'s `expect(registration.metaConfigured).toBe(true)` (line 272) holds and the row drains to `succeeded`. The two other cases that fail under the push deletion are leakage artifacts: `maps all four` throws at line 256 (`toHaveLength(4)` → 2) *before* its in-case cleanup runs, so `create_campaign`/`set_campaign_status` stay in the map and the next case (`half-configured`) fails `isExecutable('create_campaign') === false` for the wrong reason.

**Concrete consequence.** The controller is relying on a stated proof that is not what the test does. If a future change makes `registerDrainAdapters` collect handles sloppily but still call `registerMetaLane`, the push-deletion signal is partly cross-case noise, not a clean per-line guard. R-39 itself stays closed (verified), so this is a proof-hygiene and claim-accuracy issue, not a runtime one.

**Specific fix.** Re-cite the mutation against the registration call, not the push. I verified that neutralising the call itself — replacing `scripts/publish-drain.ts:336` with a non-registering `const metaLane: Array<() => void> = []` — gives `3 failed | 5 passed` and **does** fail `drains a campaign row` (`expected false to be true` at line 272). Update `progress.md:1036`, the commit-message sentence, and the `describe` header to say the drain case guards "the `registerMetaLane` call", and note that `handles.push` is guarded by `maps all four`'s `toHaveLength(4)` only.

### Minor 1 — wrong map anchor in the moved test header (`tests/marketing/meta-ads-config.test.ts:5`)

The header says "The adapter map is per process (src/marketing/outbox.ts:74, and `isExecutable` at :81 reads exactly that map)". The map declaration is `src/marketing/outbox.ts:70`; `:74` is `registerActionAdapter`. This same file cites `:74` correctly for `registerActionAdapter` at line 116, so the number is right in one place and wrong in the other. **Fix:** change the header's `:74` to `:70` (matching the correct anchors used in `src/marketing/meta-ads-config.ts:8` and `tests/marketing/publish-drain.test.ts:213`).

### Minor 2 — off-by-one anchor for the drainer's lookup (`src/marketing/meta-ads-config.ts:9`)

The header says the map is read "by the drainer's own lookup at `:90`". The drainer's lookup is `actionAdapter` (called at `scripts/publish-drain.ts:162`), declared at `src/marketing/outbox.ts:91`; `:90` is the closing ` */` of its docblock. The sibling citation in the same sentence (`isExecutable at :81`) is a function line, so consistency wants `:91`. **Fix:** `:90` → `:91`.

### Minor 3 — the boot-warning anchor points at the input, not the assertion (`src/marketing/meta-ads-config.ts:16`, repeated at `progress.md:1054`)

"`tests/mastra/marketing-boot.test.ts:50` pins the warning" — line 50 of that file is the `CRUM_META_AD_ACCOUNTS: 'not-json'` input; the assertion that actually pins the warning string is at `:54-55` (`expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse CRUM_META_AD_ACCOUNTS'), …)`). This is an inherited anchor (the deleted cron docblock and the R-39 ruling both used `:50`), but the commit re-states it in a new file. **Fix (low priority):** re-anchor to `:54`.

---

## Deferred items from the prior round — both resolved

- **"The cron's new registration had no test."** Resolved at the unit level: `tests/marketing/meta-ads-config.test.ts:98-136` adds `describe('registerMetaLane')` with three cases (registers nothing + `isExecutable` stays false on an unconfigured lane; registers **both** actions and the returned closures undo exactly them; warns once on an unreadable list). The cron's `main()` call site is still untested, but the ledger already records that honestly (`progress.md:1056`) and it was never the deferred item.
- **"The accounts half of 'both-or-nothing' was unpinned by a mutant."** Resolved: `tests/marketing/meta-ads-config.test.ts:59-69` (`says nothing when the accounts half is merely absent`) asserts a token-without-accounts returns null **and** emits no warning, and its comment names the mutant directly — deleting `!raw` from `src/marketing/meta-ads-config.ts:51` makes the empty-string reach `JSON.parse` and warn, so silence is the only observable that separates "not configured" from "configured badly". That is exactly the pin the prior round asked for.

---

## What I ran (real counts)

- `npx vitest run tests/marketing/publish-drain.test.ts tests/marketing/meta-ads-config.test.ts tests/mastra/marketing-boot.test.ts tests/marketing/outbox.test.ts` → **4 files / 59 passed** (drain 8, config 9, boot 8, outbox 34).
- Ledger lane `npx vitest run tests/marketing/meta-ads-config.test.ts tests/marketing/publish-drain.test.ts tests/marketing/meta-ads.test.ts tests/marketing/outbox.test.ts tests/marketing/page-host.test.ts tests/mastra/marketing-boot.test.ts` → **6 files / 83 passed** (confirms `progress.md:1044`).
- **Mutation A (Q1, as instructed):** deleted only `handles.push(...metaLane)` → **3 failed | 5 passed (8)**; failing = `maps all four queued actions…`, `says which lane a half-configured host is missing…`, `reports the page lane as missing when only Meta is configured`; **`drains a campaign row…` PASSED**. Restored → 8 passed, `git diff` empty.
- **Mutation B (the honest R-39 proof):** replaced the `registerMetaLane` call so the lane is never registered → **3 failed | 5 passed (8)**; failing = `maps all four…`, **`drains a campaign row…` (`expected false to be true`, line 272)**, `only Meta…`. Restored.
- `npm run typecheck` → exit **0**, clean.
- `npx eslint` over the six owned files → exit **0**, clean. Repo-wide `eslint .` → exit **1**, single error `tests/mastra/marketing-campaign-status-tool.test.ts:27` (`setCampaignStatusTool` unused), last touched by `253ce21`, not a file this commit touches → **foreign, not a finding against `a573a1f`**.
- `export CRUM_INTEGRATION_DATABASE_URL=…5455… && npx vitest run --project integration tests/integration/analyst-cron.test.ts` → **12 passed, 0 skipped** (file ran; commit edits here are comment-only, so green is expected and confirms the comments did not break collection).

**Restoration proof.** `git diff` is empty for all six files except `scripts/analyst-cron.ts`, which carries a **foreign concurrent edit by another implementer** (the Task 17 `stageStatus` return-shape change at lines ~325-344) that I did not make and did not touch. My mutations were confined to `scripts/publish-drain.ts`, whose `git diff` is empty. The foreign edit sits below my verified anchors (`:207`, `:239`), so those still hold.

---

## Claims I checked that held

- **Q2 — faithful move.** `metaAdsConfigFromEnv` (`src/marketing/meta-ads-config.ts:48-69`) is byte-for-byte the deleted `statusAdapterConfigFromEnv` from `501a2a1:scripts/analyst-cron.ts` (`:206-229`) except the signature and the warning prefix, which is now `` `[${label}] Failed to parse CRUM_META_AD_ACCOUNTS:` `` instead of the literal `'[analyst-cron] …'`. Both-or-nothing guard (`:51`), validation (`:55-59`), empty-array → null (`:68`), catch → null, and the greppable substring `Failed to parse CRUM_META_AD_ACCOUNTS` are all preserved. The cron passes `label = 'analyst-cron'`, so its operator-visible line is unchanged (`progress.md:1024` holds). No reference to `statusAdapterConfigFromEnv` or `analyst-cron-config.test.ts` remains anywhere (`grep` → zero hits).
- **Q3 — no test reaches the network.** `makeCreateCampaignAdapter` binds `config.fetchImpl ?? fetch` at construction (`src/marketing/meta-ads.ts:59`); `metaAdsConfigFromEnv` returns `{accessToken, adAccounts}` with no `fetchImpl`, so the global is captured. In `drains a campaign row`, `vi.stubGlobal('fetch', …)` installs in `beforeEach` **before** `registerDrainAdapters` runs in the case body, so the captured `fetchImpl` **is** the stub; the stub records every call in `requested` and the case asserts a single URL, so an escaping call fails visibly rather than dialing out. The other `registerDrainAdapters` cases never call `execute`, and no case runs `main()` or the cron, so nothing else issues a request.
- **Q4 — the cron's `create_campaign` entry is inert.** Production `isExecutable` callers are `blockedActions`→`commitBundleApproval` (API server process), `stagePromotion` (`marketing-writes.ts:674`, `promote_page`), `stageRetry` (`:789`, `failed.action`), `stageCampaignStatusChange` (`:885`, `set_campaign_status`), and `drainOnce` (`scripts/publish-drain.ts:204`). None queries `create_campaign` inside the cron process, and the cron never drains or approves bundles, so registering `create_campaign` there changes no outcome — a harmless map entry, agreeing with `progress.md:1056`.
- **Q5 — the page lane is unchanged.** `registerDrainAdapters` registers `publish_page` then `promote_page` in the same order as `501a2a1:scripts/publish-drain.ts`'s inline pair; the Pages warning text and condition (`pageHost === null` ⇔ `!pageHostConfigured`) are identical; `main()` destructures only the two booleans and discards `handles` by design. Only-Pages-configured and neither-configured now additionally emit the new Meta warning — the intended addition — with no change to page behaviour or ordering.
- **Q6 — the record is not over-built.** `pageHostConfigured` and `metaConfigured` are both consumed by `main()`'s two warnings and by the tests; `handles` is consumed by the drain test's `afterEach` for cleanup. `registerMetaLane` returning `Array<() => void>` (vs the brief's boolean) is load-bearing: `registerDrainAdapters` must collect the Meta undo closures into `handles` so the test can put the map back; a boolean could not carry them. Both are justified, not gold-plating.
- **Q7 — hygiene holds in green runs.** Each `registerDrainAdapters` case captures all its handles and the `afterEach` (`tests/marketing/publish-drain.test.ts:247-251`) undoes them, so the map is empty at each case start and assertions like `isExecutable('create_campaign') === false` in the half-configured case are honest; the first case's `handles = []` reset (`:266`) is safe because it undoes all four before resetting. Cross-file, `vitest.config.ts` sets no `isolate: false`, so Vitest gives each file its own module registry and publish-drain's state cannot reach the other five unit files. The one caveat (folded into Important 1) is that a mid-case assertion failure skips the in-case cleanup and leaks into the **next same-file** case — that leak, not the push deletion itself, is what turned `half-configured` red under Mutation A.
- **Q8/Q9 — anchors verified correct:** `outbox.ts:70` (map), `:81` (`isExecutable`), `:74-79` (`registerActionAdapter` body); `index.ts:158` (inline parse start) and `:174-175` (the Meta pair registration); the `registerDrainAdapters` self-references `:204` (`isExecutable`) and `:162` (`actionAdapter`); `meta-ads-config.ts:86` (`registerMetaLane`); and the integration-file comment anchors `analyst-cron.ts:207` (computes `start = end - 7d`) and `:239` (`insertSnapshot`). The wrong ones are the three Minor findings above.

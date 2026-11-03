# Task 18 report — the write-claim guard is derived, and finds four missing tools

## What changed

1. `tests/mastra/processors/write-claim-guard.test.ts` — deleted the hand-written case
   `MUTATING_TOOL_IDS lists every write tool by registry id` (sixteen `toContain` calls plus `toHaveLength(16)`),
   and replaced it with module-scope derivation read through the runtime's own loader: `REGISTERED` is
   `Object.keys(crumToolRegistry)`, `DECLARED_MUTATING` is `loadPolicy().tools.tools` filtered on
   `class !== 'read-only'` and mapped to `name`, and the named backlog is
   `DECLARED_BUT_NOT_CALLABLE = ['crm.bulk_import', 'run.side-effect']`. Three derived cases take its place: the guard
   list equals declared-mutating-and-registered; every guarded id is in the registry (the R6 catcher); the
   declared-but-unregistered set equals the backlog. One behavioural case added: a true report of a send with
   `crm.send_outreach` in `toolCalls` is left alone.
2. `src/mastra/processors/write-claim-guard.ts` — four prospect-lane ids after `'crm.transfer_owner'`, before
   `'mail.send'`: `crm.draft_outreach`, `crm.send_outreach`, `crm.save_prospect_snapshot`,
   `crm.resolve_merge_candidate`, with the why comment. `MUTATING_TOOLS` (`:27`) derives from the array, so it
   needed no edit, as the brief predicted.
3. `src/mastra/agent.ts` — one word: `export const crumToolRegistry = {` at `:55`. Nothing else touched.

## RED (B4 sequencing: three derived cases + behavioural case, before the four ids)

`npx vitest run tests/mastra/processors/write-claim-guard.test.ts`
```
 FAIL   unit  tests/mastra/processors/write-claim-guard.test.ts > WriteClaimGuardProcessor > guards exactly the mutating tools the agent can actually call
AssertionError: expected [ 'crm.create_contact', …(15) ] to deeply equal [ 'crm.create_contact', …(19) ]

- Expected
+ Received

@@ -2,15 +2,11 @@
    "crm.create_contact",
    "crm.create_customer",
    "crm.create_schedule",
    "crm.create_task",
    "crm.delete_customer",
-   "crm.draft_outreach",
    "crm.log_followup",
-   "crm.resolve_merge_candidate",
-   "crm.save_prospect_snapshot",
-   "crm.send_outreach",
    "crm.transfer_owner",
    "crm.update_customer",
    "mail.draft",
    "mail.send",
    "marketing.generate_assets",

 FAIL   unit  tests/mastra/processors/write-claim-guard.test.ts > claimsWrite > leaves a true report of a send alone now that crm.send_outreach is guarded
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "You described a data change but called no mutating tool, so nothing was written. Either call the correct tool now, or tell the user plainly that no change was made.",
+ ]

 Test Files  1 failed (1)
      Tests  2 failed | 20 passed (22)
```
The two halves B4 predicted, in one run: the derived list names the four prospect ids, and a send that genuinely
happened is aborted with the retry whose metadata reason is `write-claim-without-tool`. The second and third derived
cases passed at RED, which also confirms Task 17's registry edit landed.

## Assertion liveness (dispatch-common: every assertion must be able to fail)

Temporarily added `'crm.tool_that_does_not_exist'` to `MUTATING_TOOL_IDS`, re-ran, then restored (after the restore
`git diff --stat` shows only the intended 7-line insertion, so the mutation is gone):
```
   × WriteClaimGuardProcessor > guards exactly the mutating tools the agent can actually call
     → expected [ 'crm.create_contact', …(20) ] to deeply equal [ 'crm.create_contact', …(19) ]
   × WriteClaimGuardProcessor > guards nothing the registry does not hold
     → expected [ 'crm.list_customers', …(41) ] to include 'crm.tool_that_does_not_exist'
   ✓ WriteClaimGuardProcessor > names every declared mutating tool the registry is missing
      Tests  2 failed | 20 passed (22)
```

## GREEN

- Guard file alone: 1 file, 22 tests passed (22).
- Gate `npx vitest run tests/mastra/processors/write-claim-guard.test.ts tests/mastra/agent.test.ts
  tests/mastra/processors tests/governance tests/mastra/active-tools.test.ts` →
  **17 files passed (17), 315 passed | 1 todo (316)**. The todo is the pre-existing skipped case in
  `tests/governance/conformance.test.ts`, untouched here. `npm run typecheck` and `npm run lint` both came out
  clean, re-run after the mutation was restored.

## Derived-set numbers, measured through `loadPolicy()`

Declared mutating `tools:` entries 22 of 44 (7 auto, 14 approval, 1 refuse); registered 42; intersection 20;
declared-and-unregistered exactly `run.side-effect` + `crm.bulk_import`; `MUTATING_TOOL_IDS` 16 before, 20 after;
guarded-but-not-declared none. All match Addendum B2, and the `connectors:` block at `policy/tools.yaml:302`
(`class: approval`, no `name:`) stays invisible because the derivation is a loader read, not a file scan.

## Files changed and commit

Branch `feat/marketing-slice-5`, base HEAD `e3404f2`. The three named paths, 60 insertions / 24 deletions, in commit
`1d85f96` `fix(governance): the write-claim guard is derived from policy and registry`, named paths only; `git status
--porcelain` on them is empty afterwards and the document effort's work stays unstaged. Report not committed.

## Self-review findings

- No case states a size of the guard list any more; `toHaveLength(16)` is gone. The one surviving fixed count is the
  pre-existing `expect(calls).toHaveLength(1)` in the abort-with-retry case, which counts one turn's abort callbacks
  (aborts once, not twice): behavioural, not a set size that can silently go stale, and its case is outside this
  task's delete list, so I left it.
- Importing `src/mastra/agent` loads the guard module twice in one process (directly and via `./processors`); B3
  rules that not a cycle and the run shows no env, mock or setup cost. Style checked: single quotes, no semicolons,
  two-space indent, no `any`, comments say why the shape exists.

## Anchor disagreements and decisions

- B1/R-43/R-44 held (`agent.ts:55`, deleted case `:36-59`). The behavioural case is pinned by the quoted line
  `expect(calls[0]?.opts).toEqual({ retry: true, metadata: { reason: 'write-claim-without-tool' } })` and sits beside
  the sibling "leaves a read-only answer alone" case, whose `string[]` abort shape the brief's snippet uses.
- Deliberate deviation: the one-word `export` went in **before** the RED run, not with Step 3's ids, because
  `REGISTERED` is computed at module scope and without it the file dies at import, making the two-part RED B4 asks
  for unobservable. The export is not what the RED proves; the four absent ids are, and that is what it shows.
- No unexpected names appeared in the derivation, so nothing in the policy or registry was moved to make a test pass.

# Task 17 review: `marketing.set_campaign_status` joins the registry

APPROVED. The commit is functionally correct: the new tool only ever stages a draft, the return-shape change is adapted at every consumer, the Addendum A7 line is byte-exact, and all four gates are green on my own run. Two test-coverage gaps should be closed and two nits are noted. No blocker.

## Commands I ran and their real output

All four gates first, then the mutation experiments, then re-confirm. The shell resets between commands, so every line is prefixed with `cd D:/Code/CRUM &&`.

1. First named unit gate. `tests/mastra/marketing-writes.test.ts` does not exist, so vitest matched no file for that path and ran the rest.

   `cd D:/Code/CRUM && npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts tests/mastra/instructions.test.ts tests/mastra/marketing-writes.test.ts tests/governance`

   Real output: `Test Files  13 passed (13)`, `Tests  292 passed | 1 todo (293)`. Per file: `marketing-campaign-status-tool.test.ts` 17, `agent.test.ts` 11, `instructions.test.ts` 14, `tests/governance/conformance.test.ts` 129 (1 todo), plus the other eight governance files. The conformance file carries the pre-existing todo and was not edited by this commit.

2. I substituted the real marketing-writes tool tests, since the named path above does not exist:

   `cd D:/Code/CRUM && npx vitest run tests/mastra/marketing-publish-tools.test.ts tests/mastra/active-tools.test.ts tests/mastra/marketing-boot.test.ts`

   Real output: `Test Files  3 passed (3)`, `Tests  33 passed (33)`.

3. Integration, URL exported in the same shell, then re-exported for each run:

   `cd D:/Code/CRUM && export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5" && npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts`

   Real output: `Test Files  1 passed (1)`, `Tests  1 passed (1)`. It ran, it did not skip.

   `cd D:/Code/CRUM && export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5" && npx vitest run --project integration tests/integration/analyst-cron.test.ts`

   Real output: `Test Files  1 passed (1)`, `Tests  12 passed (12)`. I ran this one myself (not in the required list) because the cron's return-shape adaptation is load-bearing for question 4.

4. `cd D:/Code/CRUM && npm run typecheck` -> exit 0, no output beyond the `tsc --noEmit` banner. Clean across the whole repo including the other effort's unstaged files.

5. `cd D:/Code/CRUM && npm run lint` -> `eslint .`, exit 0. Clean.

`git show --stat 667384e` reports 8 files changed, 298 insertions(+), 20 deletions(-), matching report 2 exactly. The commit is an ancestor of HEAD (`d493b7d`).

## Blockers

None.

## Should fix

### 1. The `provider_not_configured` prose entry has no test

`src/mastra/tools/marketing-writes.ts:1024` adds `provider_not_configured: 'this process has no campaign status adapter, so the change could not be run'` to `REFUSAL_PROSE`. That entry only matters because `setCampaignStatusTool` renders it through `readableReason(tokenOf(why))` when a chat turn reaches a process with no Meta adapter (`marketing.set_campaign_status` is refused at boot when Meta is unwired, per `src/mastra/index.ts:123` and the boot tests). So the sentence is reachable in production.

But no test asserts it. The unit file tests `provider_not_configured` only at the function level (`tests/mastra/marketing-campaign-status-tool.test.ts:317`, `rejects.toThrow(/provider_not_configured/)`), which checks the raw token, not the prose the owner reads. The tool-level describe block never unregisters the adapter, so it never drives the tool into that branch.

Evidence (mutation, then restored): I replaced the entry's text with `ZZZ MUTATED PROSE should not be asserted ZZZ` and ran `npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts`. Output was `Tests  17 passed (17)`. A sentence a human is meant to act on can be retyped wrong or deleted and the suite stays green. The sibling entry `campaign_not_found` does not have this hole, see the verified section. Restoring is confirmed below.

### 2. The new instructions paragraph is untested

`src/mastra/instructions.ts:100-105` adds the paragraph telling the primary agent to call `marketing.set_campaign_status` when the evidence supports a pause or activation, and that the change only exists after a human approves and the publisher drains. This is the "when to use it and approval is a separate human step" requirement from question 6. The prose is correct.

Nothing pins it. `tests/mastra/instructions.test.ts` has no `campaign_status`, `scale`, `kill` or `approve` assertion (grep returned nothing), so deleting the whole paragraph leaves the suite green. The file's own convention is to pin marketing guidance, compare `:51` (`marketing.generate_assets`) and `:71-73` (the staging refusal sentence). I could not fault the words, but there is no test capable of failing if they move.

## Nits

### 3. The success return hardcodes `gate: 'approval'` while the staged draft gate is computed

`src/mastra/tools/marketing-writes.ts:974` computes `gate` from `policy.gateFor(...)` on the real payload and `:998` stores that value, but `:1164` returns the constant `gate: 'approval' as const`. These agree for every real Meta id. They can disagree for a crafted one: `campaignExternalId` is a free string up to 64 chars (`:1119`), and `scoreRisk` (`src/governance/risk.ts:59`) hashes it, so an id carrying both an irreversible term and a high-blast term scores 90 (`policy/risk.yaml:17`), which `gateFor` raises to `refuse` (refuse_at 80). The staged draft would then carry `gate: 'refuse'` while the tool reports `approval`. Not a security issue (a refuse draft is more locked, and nothing commits without a human), and unreachable with numeric Meta ids, but the reported gate is not the stored gate. The plan's Step 3 block dictated this shape, so I am noting it, not demanding a change.

### 4. `requireApproval` is tested on `PAUSED` only

`tests/mastra/marketing-campaign-status-tool.test.ts:379` calls the gate with `{ status: 'PAUSED' }` and nothing exercises the `ACTIVE` placeholder branch at `src/mastra/tools/marketing-writes.ts:1138`. The two payloads differ only in the enum value and both score benign, so the ACTIVE case is not meaningfully at risk, but the second half of the placeholder is unexercised.

## Questions this review had to answer

1. Approval boundary. Confirmed sound. The tool's `execute` path is `setCampaignStatusTool -> stageCampaignStatusChange -> getOrCreateDraft`, and `getOrCreateDraft` is a single `INSERT INTO pending_writes` (`src/db/pending-writes.ts:102-129`). `commitAutoWrite` is imported (`src/mastra/tools/marketing-writes.ts:7`) but the only call in the file is at `:259`, inside the save-bundle tool, never on this path. No Meta adapter is invoked here. The real queue into `marketing_actions` happens only in the approval-time commit branch (`src/db/pending-writes.ts:649-719`), which a chat turn cannot reach. `requireApproval` (`:1131`) returns `gateFor(...) === 'approval'`, and because `declaredGate('approval')` is `approval` and `gateFor` only raises (`src/governance/policy.ts:118-125`, `raise`/`declaredGate` at `:34-43`), the hook cannot lower to auto. A chat turn therefore cannot commit its own change.

2. Actor identity. Confirmed, and the controller's ruling holds. The tool forwards `rc.userId` (`src/mastra/tools/marketing-writes.ts:1154`) and `requestContextSchema: TenantRequestContextSchema` (`:1116`) declares `userId: z.string().uuid(...)` (`src/mastra/tenant-context.ts:5`), so a non-uuid or absent actor is rejected by the framework before `execute` runs. The missing-actor branch at `:885` is the backstop for direct callers like the cron, which is exactly what the cron guards at `scripts/analyst-cron.ts:320`. The tool file has no `campaign_status_actor_required` case and should not per the ruling. That token is still pinned at the function level in two cases (`tests/mastra/marketing-campaign-status-tool.test.ts:277` and `:341`). I did not ask for a new case.

3. Payload hygiene. Confirmed. `campaignStatusPayload` (`src/marketing/payload.ts:106-111`) returns only `{ campaignId, status }`. Both build sites go through it: the scoring path (`src/mastra/tools/marketing-writes.ts:971`) and the placeholder in `requireApproval` (`:1138`). The cron never builds a payload itself, it calls `stageCampaignStatusChange`. The reason prose stays out of the scored object and out of the idempotency key (`:1000`, `campaign_status:${id}:${status}`), so the draft hash is stable across phrasings. Grep for `campaignStatusPayload` returns exactly the three sites; there is no parallel builder.

4. Return shape. Confirmed for every consumer. The function returns `{ pendingWriteId, riskScore }` at `src/mastra/tools/marketing-writes.ts:1002`. Consumers: tool `execute` reads `staged.pendingWriteId` and `staged.riskScore` (`:1162-1163`), cron reads `staged.pendingWriteId` and keeps the element type `{ campaignId, status, draftId }` unchanged (`scripts/analyst-cron.ts:328-341`), integration destructures (`tests/integration/marketing-campaign-status.test.ts:118`), unit reads `result.pendingWriteId` / `result.riskScore`. No caller treats the return as a bare id, and no test injects a fake `stageStatus` returning a string (grep found only the two `stageStatus` lines in the cron itself).

5. Refusals. `campaign_not_found` (`:1023`) and `tokenOf` (`:1033-1036`) are reachable and each has a failing-if-broken test, see verified section. `provider_not_configured` (`:1024`) is reachable but its prose has no test, which is Should fix 1. `campaign_status_actor_required` and `campaign_already_active` correctly have no map entry and render through the underscore replacement, consistent with A3.

6. Registry and instructions. `marketing.set_campaign_status` is the 42nd registry key (`src/mastra/agent.ts:97`), the import is present (`:42`), `agent.test.ts:50-53` was updated to `42 ... (22 read + 7 auto + 13 approval)`, the governance side was already consistent (`policy/tools.yaml:281` `class: approval`, `tests/governance/conformance.test.ts:56`, `tests/mastra/active-tools.test.ts:62`, and `src/mastra/processors/write-claim-guard.ts:24` already lists it in `MUTATING_TOOL_IDS`). The instructions paragraph exists and reads correctly but is untested, which is Should fix 2.

7. Tests that can fail. I ran five mutations, all restored. See the next section for the gate and this section's two should-fix findings for the mutation outputs.

8. Addendum A7 line. Verified byte-exact. `git show 667384e:tests/integration/marketing-campaign-status.test.ts` line 118 is `const { pendingWriteId: draftId } = await stageCampaignStatusChange({`. No risk-score assertion was added there, `:128`'s `getPendingWrite(draftId, TENANT)` still takes the renamed binding, and the variable was not renamed.

## Mutation experiments (each reverted, file restored)

- `tokenOf(why)` to `why` at `src/mastra/tools/marketing-writes.ts:1191`. Result: `Tests  2 failed | 15 passed`. Both `campaign_not_found` prose regex (`:420`) and `campaign_already_active` closing-parenthesis proof (`:453`) failed. `tokenOf` is load-bearing.
- `riskScore: draft.riskScore` to `riskScore: 0` at `:1002`. Result: `Tests  2 failed | 15 passed`. The function-level (`:127`) and tool-level (`:398`) carry-out assertions both failed. The carry-out is pinned, not assumed.
- Delete the `campaign_not_found` prose entry. Result: `Tests  1 failed | 16 passed`. Fell through to `campaign not found`, proving the map entry is the thing under test.
- Flip `gateFor(...) === 'approval'` to `=== 'auto'` at `:1144`. Result: `Tests  1 failed | 16 passed`. The `requireApproval` gate case (`:379`) is load-bearing.
- Mutate the `provider_not_configured` prose to a marker string. Result: `Tests  17 passed (17)`. This is the Should fix 1 evidence.

After all five I re-ran `git status --porcelain` on all eight touched paths and it printed nothing, and `git diff --stat HEAD -- src/mastra/tools/marketing-writes.ts` was empty. The tree is byte-identical to what I found.

## What I verified and could not fault

- The tool cannot commit or reach Meta from a chat turn. Traced end to end.
- The single payload builder holds at both scoring and placeholder sites, prose-free, stable hash.
- Every return-shape consumer destructures correctly, including the cron which keeps the report element type.
- The A7 integration line is exactly the required text, verified from the committed object.
- The governance, registry, conformance and active-tools sides are consistent, and conformance was not edited and stays green.
- `tokenOf`, `campaign_not_found` prose, the `riskScore` carry-out, and the `requireApproval` gate all have assertions that genuinely fail when the source is wrong.
- `readableReason(tokenOf(why))` never leaks a bare token into a chat turn for the two reachable tokens I exercised.

## What I could not check

- Whether Mastra's `requestContextSchema` really rejects a bad-uuid `userId` before `execute` in a live agent turn. I relied on the schema at `src/mastra/tenant-context.ts:5` and the report's captured observation, not on running a full agent turn (running one needs a live model, which is out of bounds). It does not change the verdict: the ruling says the chat tool needs no `campaign_status_actor_required` test, and the tool forwards `rc.userId` regardless.
- The console approval screen's rendering of a `marketing_set_campaign_status` draft. That is Task 16 territory and not in this commit.
- Any live-model / `tests/evals` behaviour, and the other effort's unstaged work in `src/api`, `src/mastra/identity.ts`, `src/mastra/docling.ts`, `console/**`, `package.json`, `src/queue`, `src/temporal`, `services/ocr`. I did not run the golden gate or anything under `tests/evals`, and typecheck/lint being clean means none of that foreign work is red at HEAD right now.

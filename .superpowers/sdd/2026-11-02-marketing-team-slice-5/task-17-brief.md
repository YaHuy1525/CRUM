# Task 17 brief: `marketing.set_campaign_status` joins the registry

## Read this first

The specification for this task is `docs/superpowers/plans/2026-11-02-marketing-team-slice-5.md`, lines **3948 to 4155**, section "### Task 17: `marketing.set_campaign_status` joins the registry". Read that whole section before writing any code, including the code blocks in Steps 1, 3 and 5. They are the shape to implement, and this file does not reproduce them.

Then read the addenda below. They correct six anchors that have moved, add one ruling about the return shape, name one plan sentence that is not true, and fence the gates.

## Why this task exists

The registry holds 41 tools and the admin's active list holds 42, because `resolveActiveTools` is derived from `policy/tools.yaml` and never asks the registry whether the tool exists. Since slice 3 the agent has been told every turn that it may call `marketing.set_campaign_status` and there has been no tool behind the call. The policy edge already exists and is already recorded in the conformance test, so this task needs no governance change, and the fact that `tests/governance/conformance.test.ts` stays unchanged and green is part of the evidence.

## Files you own

- `src/marketing/payload.ts` (new `campaignStatusPayload`)
- `src/mastra/tools/marketing-writes.ts` (the new tool, the two payload sites, the return type, `REFUSAL_PROSE`, `tokenOf`)
- `src/mastra/agent.ts` (import at `:36`, registry key after `:89`)
- `src/mastra/instructions.ts` (the marketing section, before the closing `</section>` at `:100`)
- `scripts/analyst-cron.ts` (the stage call site only, `:328` and `:337`)
- `tests/mastra/marketing-campaign-status-tool.test.ts`
- `tests/mastra/agent.test.ts`
- `tests/mastra/marketing-publish-tools.test.ts` only if the return-shape change reaches it

## Files you must not touch

- `src/db/pending-writes.ts`, `tests/db/marketing-commit.test.ts`, `tests/integration/marketing-campaign-status.test.ts`. They belong to Task 16, and an independent review is reading them right now. If you think the branch Task 16 landed needs a change, report it and stop.
- `scripts/publish-drain.ts`, `src/marketing/meta-ads-config.ts`, `tests/marketing/publish-drain.test.ts` and `tests/marketing/meta-ads-config.test.ts`. They belong to Task 16's addendum A1 round, landed at `a573a1f`, and an independent review is reading them now. The last two are the moved config test: it was `tests/scripts/analyst-cron-config.test.ts` when this brief was drafted and the rename is in history.
- Anything belonging to the other effort working in this tree: `src/api/documents.ts`, `src/api/index.ts`, `src/api/serve.ts`, `src/mastra/docling.ts`, `src/mastra/identity.ts`, `src/mastra/workflows/ingest.ts`, `console/**`, `services/ocr/**`, `src/queue/**`, `src/temporal/**`, `src/transforms/**`, and their tests. Never stage them, never "fix" them.

## Addendum A1. Anchor corrections

The plan's `marketing-writes.ts` line numbers are stale because Task 15 grew that file. Use these.

| Plan says | Tree says |
| --- | --- |
| `StageOutputSchema` at `:305-312` | `:314`, with `riskScore: z.number().int().min(0).max(100)` at `:316` |
| `stageCampaignStatusChange` return type at `:818` | function opens at `:852`, signature is `Promise<string>` today |
| the inline payload literal at `:866` | `:957`, `const payload = { campaignId: args.campaignExternalId, status: args.status }` |
| the last line of the function | `:988`, `return draft.id` |
| `REFUSAL_PROSE` at `:899-905` | `:1000` to `:1005`, four entries today |
| `readableReason` at `:906` | `:1007` |
| `promoteBundleTool` at `:910-978` | `:1011` onward |
| its `requireApproval` payload site at `:927-936` | `:1031`, `promotePayload({ bundleId: input.bundleId, pageActionId: '', siteHash: '' })` |

Anchors that are exact and need no re-finding: `src/mastra/agent.ts:36` and `:89`, 41 keys in `crumToolRegistry`, `tests/mastra/agent.test.ts:50-53` whose title reads `has 41 tools configured (22 read + 7 auto + 12 approval)`, `tests/mastra/active-tools.test.ts:12` `:38` `:49` `:72` with `ADMIN_EXPECTED // 42`, `policy/tools.yaml:281` with `class: approval` `scope: marketing:status` `idempotency_key: draftHash`, `tests/governance/conformance.test.ts:56` with `['marketing.set_campaign_status', 'approval', 'draftHash']`, and `tests/mastra/marketing-publish-tools.test.ts:33` for the `context` object Step 5 copies.

`scripts/analyst-cron.ts` has drifted twice: once when Task 15 grew it, and once when A1 deleted its private Meta config read, which took 43 lines out of the middle of the file. Re-measured at `a573a1f`: the plan's `:314` call site is `const draftId = await stageStatus({ ... })` at `:328` and `stagedDrafts.push({ campaignId: rec.campaignId, status, draftId })` at `:337`, and the element type `Array<{ campaignId: string; status: string; draftId: string }>` is declared twice, at `:202` (the return type) and at `:306` (the local). Keep the element type as it is, per the plan. The registration block at `:408` is now `registerMetaLane(env, 'analyst-cron')`; it belongs to A1, is under review, and is not yours to change.

## Addendum A2. R-40, the return shape is a third convention and it stays

`stagePromotion` and `stageRetry` return discriminated envelopes: `StagePromotionResult` at `:621-626` and `StageRetryResult` at `:748-751`, each `| { ok: true; pendingWriteId: string; riskScore: number } | { ok: false; reason: ...; message?: string }`, because their refusals are values the tool renders. `stageCampaignStatusChange` refuses by **throwing**, and its four throws are `campaign_status_actor_required` at `:874`, `provider_not_configured` at `:886`, `campaign_not_found` at `:907` and `campaign_already_active` at `:948`. Step 2 asks for a bare `Promise<{ pendingWriteId: string; riskScore: number }>`, which is neither the envelope nor today's bare string.

Ruled: implement the plan's shape exactly. Do not convert the throws to an envelope. Converting them would rewrite four throw sites, Task 15's twelve unit cases and the cron's error handling, to move a value that is already travelling honestly as an exception. A reviewer will notice three shapes in one file, so write a comment at the function's docblock that says which two shapes exist, which one this is, and why the throw path stays.

## Addendum A3. One plan sentence that is not true

Step 3 says `campaign_status_actor_required` "cannot reach a chat turn". It can, through the tool this task is adding. `execute` reads `rc.userId` from `context.requestContext.all` and hands it to `stageCampaignStatusChange`, which validates it against `z.string().uuid()` and throws the token. The tool's `catch` then turns it into a refusal human task and `readableReason(tokenOf(why))` falls through `REFUSAL_PROSE` to the underscore replacement, which reads "campaign status actor required". That sentence is fine, so do not add a map entry for it, but do not write a comment claiming the path is unreachable either. If you want to pin the fallthrough, add a unit case for a non-uuid `userId` in the request context, and if you add one, make it assert that the refusal still creates exactly one human task and stages nothing.

## Addendum A4. Things you should not have to discover

`draft.riskScore` exists on the row `getOrCreateDraft` gives back, and two sibling call sites already carry it out: `:584` and `:731` and `:836` all read `riskScore: draft.riskScore`. So Step 2's return is a read of an existing field, not a new computation.

`createHumanTask` is already imported in `marketing-writes.ts` at `:7`, next to `commitAutoWrite`, `getOrCreateDraft` and `invalidateOpenStageDraft`. `tokenOf` does not exist anywhere in the file and is yours to add, next to `readableReason`.

The new tool's `requireApproval` scores a payload whose `campaignId` is the empty string, because the hook is synchronous and cannot read a database. That is deliberate, and the reason it still gates correctly is that the declared class in `policy/tools.yaml` is `approval`. Write the comment the plan gives you, and do not "improve" it by reaching for a read.

`tests/mastra/marketing-campaign-status-tool.test.ts` already has three `expect(draftId).toBe(DRAFT_ID)` assertions at `:110`, `:138` and `:156`. Step 2 turns those into `expect(result.pendingWriteId).toBe(DRAFT_ID)`, and the file's partial mocks of `../../src/db/pending-writes` start at `:11`; Step 5 needs `createHumanTask` added to that partial mock, and the file already mocks `../../src/db/client` at `:7` and `../../src/governance/policy` at `:16`.

Task 15 pinned `uuidFromSeed('campaign:23842653876')` to the literal `ff96fb60-5cb9-8d7d-b265-918605379b58` in that test file. Leave that case alone, it is the only assertion that nails the seed format itself.

`src/mastra/instructions.ts`: the marketing section runs from `:80` to the closing `</section>` at `:100`, and it already names `marketing.save_bundle` at `:86` and `marketing.generate_assets` at `:89`. Step 4's paragraph goes immediately before that closing tag, inside the section, after the `needs_review` paragraph.

## Addendum A5. Gates, in this order, with the RED captured first

Work test-first. The plan's Step 5 cases and the count change in `tests/mastra/agent.test.ts` go in before the tool, and you must capture the failing run and quote it in your report: which cases failed, and the assertion text that proves the tool was absent rather than wrong.

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts tests/mastra/active-tools.test.ts tests/mastra/marketing-publish-tools.test.ts tests/governance/conformance.test.ts
npx vitest run tests/marketing/meta-ads-config.test.ts tests/mastra/marketing-boot.test.ts
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/analyst-cron.test.ts tests/integration/marketing-campaign-status.test.ts
npm run typecheck
npm run lint
```

Report collected and passed counts per integration file and say in words whether anything was skipped. A skipped test is never a pass, and if the URL was not exported the file skips silently.

`npm run typecheck` was clean at `a573a1f`, including the other effort's `src/api/documents.ts`: the error this brief used to predict there was fixed by their `f283490` while Task 16 was in review. If typecheck goes red while you work, attribute it by file (`git log -1 -- <path>`, `git blame -L`) before you act on it, report a foreign red by name, and do not touch another effort's file. `npm run lint` must be clean for your files.

One more thing about the two repo-wide gates: a reviewer for A1 is running them in this same window, and a third effort is committing to this branch. A red you cannot reproduce after re-running is a sign of a concurrent edit, not of your own defect; say so in the report rather than chasing it.

Never run `npm run test`, `npm run verify`, a bare `npx vitest run`, `npx vitest run --project unit` without file paths, or anything under `tests/evals`. Do not start, stop or reconfigure the Postgres cluster on 5455. No test may call Replicate, a model, a real ad account or a real domain, and `CRUM_REPLICATE_API_TOKEN` must never appear in a file, log or report.

## Addendum A6. Commit shape

Name every path, and never use `git add -A`, `git add .` or `git commit -a`.

```bash
cd D:/Code/CRUM
git add src/marketing/payload.ts src/mastra/tools/marketing-writes.ts src/mastra/agent.ts src/mastra/instructions.ts scripts/analyst-cron.ts tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts
git commit -m "feat(marketing): the campaign status decision becomes callable, and reachable"
```

`tests/mastra/marketing-publish-tools.test.ts` joins that list only if you had to change it, and say so in the report. Stage nothing else, and confirm with `git status --short` immediately before committing that the other effort's paths are still unstaged. Do not amend any commit. Do not dispatch subagents, and do not spawn a reviewer; the controller does that.

## Addendum A7. Round 2 ruling on the blocker you reported

Your report is accepted in full: seven files done, RED captured, every unit gate green, one typecheck error, one integration failure, and both traced to the same line in a file this brief had put off limits. Stopping rather than editing it was the right call, and the ruling is that the fix travels in your commit. A change to a return type owns the adaptation of its consumers, because a commit that leaves HEAD failing typecheck is a commit the next reader has to debug.

`tests/integration/marketing-campaign-status.test.ts` is therefore yours for exactly one line, and nothing else in it.

`:118` currently reads `const draftId = await stageCampaignStatusChange({`. Replace the binding with a destructuring rename so the rest of the case, including `:128`'s `getPendingWrite(draftId, TENANT)`, is untouched:

```ts
const { pendingWriteId: draftId } = await stageCampaignStatusChange({
```

Do not add an assertion about `riskScore` there, do not restructure the case, and do not rename the variable. The unit file already pins the pair, and an integration test that re-pins a unit's job is a second place for the same fact to go stale.

The eighth path joins the A6 `git add` list, and the subject line stays as written. Add a body line naming the integration file and saying why it is in the commit, so the ownership question cannot be asked again by a reader of `git log`.

Then re-run, in this order, with the URL exported in the same shell for the integration step:

```bash
cd D:/Code/CRUM
npm run typecheck
npx vitest run --project integration tests/integration/analyst-cron.test.ts tests/integration/marketing-campaign-status.test.ts
```

Typecheck must be clean across the whole repo, and the integration run must be `Test Files 2 passed (2)` with `Tests 13 passed (13)`, 12 plus 1, and no skip line. Quote both. The five unit files and the two repo gates you already ran do not need re-running unless this one line somehow changes them; if you do re-run them, report the counts.

One hazard, because the tree has moved since you started. The controller has landed `b817df7`, which reorders the assertions in `tests/marketing/publish-drain.test.ts`'s campaign drain case and corrects three comment anchors. That file is still not yours. Verify with `git diff --stat` before staging that your diff is still the eight paths you expect, and report anything else you find modified rather than staging it.

## Report back

Return the commit hash, the file count and the insert count, the RED you captured, every gate with its per-file counts, any deviation from the plan with the reason, and anything you found that belongs to Task 18 or Task 19 rather than here.

---

## Addendum A8: the round 1 review fixes, controller ruled

Source: `task-17-review-1.md` (0 critical, 2 important, 7 minor) and `task-17-review-2.md`
(APPROVED, 2 should-fix, 2 nits). The controller re-measured both important findings against
the source and both hold. This round fixes five and parks two. It is a new commit, never an
amend.

**A8.1, the origin of a campaign-status draft becomes explicit (I2).** `stageCampaignStatusChange`
hardcodes `runId: 'analyst-cron'` at `src/mastra/tools/marketing-writes.ts:982`, and the chat tool
calls that same function at `:1152`, so a draft a person staged in conversation is stored with the
cron's label. It reaches a human verbatim at `src/api/approvals.ts:74` and goes into
`matchSuspension` at `:172`. Add a required `origin: 'cron' | 'chat'` field to the argument
object and use it to pick the run id: `'analyst-cron'` for the cron, `'pending'` for chat.
`'pending'` is the label every other marketing staging tool already uses for a draft with no
resumable run (`:549`, `:717`, `:826`) and it is a member of `UNMATCHABLE_RUN_IDS` at
`src/api/approvals.ts:95`, so the approval queue reads honestly for both origins. Do not default
the field and do not make it optional. The type error is the mechanism that finds every call
site, and there are eleven of them: `scripts/analyst-cron.ts:328`, the tool at `:1152`,
`tests/mastra/marketing-campaign-status-tool.test.ts` at nine sites, and
`tests/integration/marketing-campaign-status.test.ts:118`. Give each call site the origin that
case is actually exercising, and add one case that asserts the stored `run_id` differs between
the two origins.

**A8.2, the `requireApproval` case must be able to fail (I1).** `gateFor: () => 'approval'` at
`tests/mastra/marketing-campaign-status-tool.test.ts:89` decides the hook's return value by
stub rather than by computation, so a mutant that puts prose into the payload the hook scores
survives 17 of 17, and so does `&& input.status === 'PAUSED'` appended to the return at
`src/mastra/tools/marketing-writes.ts:1144`. Change the stub to record what it is handed, the
way this plan's own self-review notes say to do when a fragment stub answers any parameters:
capture the tool name, the score and the payload into an array the test can read. Keep returning
whatever the real policy would return for that input only if it does not need a second parser; if
it does, return `true` and stop asserting on the boolean. Then assert three things on the hook
for both `ACTIVE` and `PAUSED`: it returns true for both, the payload it scored is exactly
`campaignStatusPayload({ campaignId: '', status: input.status })`, and no string in that payload
came from the tool input. Show the RED for both mutants before fixing, then GREEN after.

**A8.3, the gate the tool reports is the gate that was stored.** `:1164` and `:1190` return
`gate: 'approval' as const` while the value persisted at `:974` is computed by `gateFor`. Return
the computed gate out of `stageCampaignStatusChange` alongside `pendingWriteId` and `riskScore`,
and have the success path report it. Add the field to the function's declared return type, not
inferred, so a later reader sees the shape. Leave the refusal path's `gate` alone if the schema
forces a literal there, and say which it is.

**A8.4, `tokenOf` must not invent a token.** `:1032` takes everything before the first colon, so
a thrown message containing a Windows path yields `D:`. Accept the leading segment only when it
matches `/^[a-z][a-z0-9_]*$/`, otherwise return the whole message unchanged. One case per arm.

**A8.5, two sentences that are not always true.** Read every raise site of `campaign_not_found`
in `stageCampaignStatusChange` before touching it: the reviewer's finding is that the prose at
`:1024` states the publish condition in a case where a different condition failed. Make the
sentence true for every site that raises it, splitting the token if the sites genuinely mean
different things. Then fix the comment at `:1136`, which claims the declared class decides the
gate "whatever the placeholder holds": that is true of the hook, whose campaign id is the empty
literal, and misleading about `execute`, which scores the real id and can reach 90 and `refuse`
for prose. Say which one the sentence covers.

**Parked, do not attempt here.** `campaignExternalId` carries no shape validation at all, and the
instructions paragraph at `src/mastra/instructions.ts:100-105` names an admin-only tool to roles
that cannot reach it. Both are wider than a nit round and both go to the slice-end register.

**Files this round may touch, and nothing else:** `src/mastra/tools/marketing-writes.ts`,
`scripts/analyst-cron.ts`, `tests/mastra/marketing-campaign-status-tool.test.ts`,
`tests/integration/marketing-campaign-status.test.ts`, and only the exact lines of any other file
TypeScript names because of the new required field. If you find yourself wanting
`src/mastra/agent.ts`, `src/mastra/instructions.ts`, `policy/tools.yaml` or
`src/marketing/payload.ts`, stop and report instead.

**Gate for this round:**

```
cd D:/Code/CRUM && npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts tests/mastra/instructions.test.ts tests/db/marketing-commit.test.ts tests/governance
cd D:/Code/CRUM && export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5" && npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts tests/integration/analyst-cron.test.ts tests/integration/pending-writes.test.ts
cd D:/Code/CRUM && npm run typecheck && npm run lint
```

**Commit, one new commit, named paths only:**

```
git commit -m "fix(marketing): a campaign status draft says which lane staged it"
```

Say in the body which of A8.1 to A8.5 landed. Do not stage or revert anything outside your paths;
the working tree carries another effort's unstaged work in `src/api`, `src/mastra/identity.ts`,
`src/mastra/docling.ts`, `console/**`, `package.json` and untracked `src/queue/`, `src/temporal/`,
`services/ocr/`.

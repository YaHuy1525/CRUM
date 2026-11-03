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

## Report back

Return the commit hash, the file count and the insert count, the RED you captured, every gate with its per-file counts, any deviation from the plan with the reason, and anything you found that belongs to Task 18 or Task 19 rather than here.

# Task 17 review round 1: Request changes, 0 critical and 2 important

Verdict: **Request changes**. Critical 0, Important 2, Minor 7.

## A note on this file's provenance, recorded honestly

This review ran as a background agent for roughly 23 minutes. While it ran, the
controller, unaware that it was still alive after a context compaction, dispatched a second
reviewer of the same commit and pointed it at the same output path. The second reviewer
finished first and wrote its file, and the first reviewer's write landed on top of it, so the
detailed body of this review was lost and only the summary it returned to the controller
survives. That summary is what is reproduced here. The second reviewer's full text is intact
in `task-17-review-2.md`, and it is a legitimate independent review of the same commit, not a
duplicate to be discarded. Where the two disagree, the controller rules, and both are cited.

The collision is a process mistake and it is written down for the same reason the rest of this
ledger is: two reviewers of one commit is not a defect, but two reviewers writing one file is.
Later dispatches give each reviewer its own path.

## Important

**I1, the `requireApproval` case cannot fail in the ways it exists to catch.**
`tests/mastra/marketing-campaign-status-tool.test.ts:89` builds its policy stub as
`gateFor: () => 'approval' as const`, so the hook's return value is decided by the stub and not
by anything the hook computes. The single `requireApproval` case at `:367` then drives it only
with `{ status: 'PAUSED' }`. Two source mutants survived the full 17-case file: prose added to
the payload the hook scores, and `&& input.status === 'PAUSED'` appended to the hook's return.
Both leave every test green. The first is the one that matters, because the hook's whole claim
is that it scores an identifiers-only payload, and a stub that answers `approval` to everything
cannot see that claim break.

**I2, a chat-staged draft is written with the cron's origin label.**
`src/mastra/tools/marketing-writes.ts:982` passes `runId: 'analyst-cron'` to `getOrCreateDraft`
inside `stageCampaignStatusChange`. The new chat tool calls that same function at `:1152`, so a
draft staged by a person in conversation is stored as though the cron staged it. The value
reaches a human verbatim: `src/api/approvals.ts:74` exposes it as `run_id` on the approval
queue, and `:172` feeds it to `matchSuspension`. What is lost is the conversation link and the
honest origin, not the mechanics. Approval, the queue entry and the drain still work, so this
is attribution rather than a broken gate.

## Minor

- The `campaign_not_found` prose omits the bundle condition, so a refusal can state something
  that is not true of the campaign the owner is looking at.
- The comment "the declared class decides the gate whatever the placeholder holds" is false for
  a model-written `campaignExternalId`. Measured: `''` and `23842653876` both give score 10 and
  `approval`, while `"delete all 2026"` gives score 90 and `refuse`.
- The "score carried out, not recomputed" assertions are not capable of failing. A mutant that
  recomputes the score at the tool boundary survived.
- `tokenOf` truncates errors that are not tokens. A Windows path is cut at the drive-letter
  colon, so `D:` becomes the token.
- The instructions paragraph names an admin-only tool to every role rather than only the roles
  that can reach it.
- `requireApproval` is exercised on `PAUSED` only, which is the same defect as I1 seen from the
  other side.
- The success path hardcodes `gate: 'approval' as const` at `:1164` while the gate that is
  actually stored is computed at `:974`.

## What the reviewer held, and did not fault

Reachability for the admin role was traced end to end and is denied only at
`src/mastra/active-tools.ts:6` for `user`, which is the intended shape. The prose-free
persisted payload is genuinely killable, one mutant died on three assertions. `campaign_status_actor_required`
is truly unreachable from a chat turn, confirmed against Mastra's own request-context
validation, which upholds the controller's standing ruling that the chat tool needs no case for
it and does not warrant a new test. `tests/governance/conformance.test.ts` was not touched and
its one todo predates this slice, at `f4c53f6`. No stale count appears anywhere in the file. The
cron's two comment claims are both true, and its provider injection is `typeof`-typed. The
ownership boundaries of the commit are clean: nothing outside Task 17's named files moved.

## What was run, and what was not

Focused file: `Tests 17 passed (17)`. The named five-file set plus `instructions.test.ts` and
`write-claim-guard.test.ts`: `Test Files 7 passed (7)`, `Tests 214 passed | 1 todo (215)`. Six
mutation runs, each reverted and re-checked. One `npx tsx` probe of the loaded policy. No
integration test was run and no typecheck or lint was run, so those are the controller's
numbers in this ledger, not this reviewer's. Nothing that did run could have skipped silently.
After every experiment, `git diff` and `git status --porcelain` are empty across all eight
paths, nothing was staged, and the other effort's unstaged work was untouched.

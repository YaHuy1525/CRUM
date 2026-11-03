# Task 17 round 2 report: Addendum A8, landed at `a345ab8`

## Provenance, because the shape of this round is unusual

The dispatched implementer did the code and then hit the harness turn limit at 150 turns while
it was starting the full gate. It had written no report and made no commit. Its working tree was
complete and coherent: four files, 269 insertions, no leftover mutant, no edit outside the A8
file list. I did not restart it and did not rewrite its work. I ran the gate myself, read every
line of its diff, performed the four mutation experiments it never got to demonstrate, and
committed. So this report is the controller's account of an implementer's landed work, and the
review round that follows should be given the same freedom to fault it as any other.

## What landed, per ruling

**A8.1, the staging origin.** `stageCampaignStatusChange` now declares
`origin: 'cron' | 'chat'` as a required field at `src/mastra/tools/marketing-writes.ts:875`, and
the draft's run id is chosen from it at `:991`: `runId: args.origin === 'cron' ? 'analyst-cron' : 'pending'`.
The field is required rather than defaulted, and the comment at `:872-875` says why: the lane
that forgot to say would otherwise inherit the label of the lane that did, which is the exact bug.
TypeScript enumerated the call sites, and all of them were updated: `scripts/analyst-cron.ts:336`
passes `'cron'`, `setCampaignStatusTool.execute` at `:1194` passes `'chat'`,
`tests/mastra/marketing-campaign-status-tool.test.ts` passes `'cron'` at its thirteen cron-lane
sites and `'chat'` at the one site that exercises a malformed actor arriving through a turn, and
`tests/integration/marketing-campaign-status.test.ts:126` passes `'cron'` because that proof
stages from the analyst lane. A new case, `labels the draft with the lane that staged it, because
an approver reads that label`, calls the function twice with identical arguments except the
origin and asserts `runIds` equals `['analyst-cron', 'pending']`.

**A8.2, a `requireApproval` case that can fail.** The stub at
`tests/mastra/marketing-campaign-status-tool.test.ts:89` no longer decides the outcome alone. Two
recorders were added at module scope: `scoredPayloads`, fed by a `vi.mock` of
`src/governance/risk` that delegates to the original `scoreRisk` and records the payload and tool
name on the way through, and `gateCalls`, fed by the policy stub's `gateFor`, which records the
tool name, score and sensitive flag and then answers from a `fakeGate` variable set in
`beforeEach`. The rewritten case drives both `ACTIVE` and `PAUSED`, passes a `bundleId`, a
prose-bearing `campaignExternalId` and a `reason` in the input, and asserts on what was handed in
rather than only on the boolean that came out. The comment at `:130-136` records the deliberate
choice not to re-derive the gate from the recorded score inside the stub, because that would put a
second copy of `gateFor`'s arithmetic in the test file.

**A8.3, the gate that is reported is the gate that is stored.** `stageCampaignStatusChange`
returns `{ pendingWriteId, riskScore, gate }`, with the type written out as
`Promise<{ pendingWriteId: string; riskScore: number; gate: Gate }>` at `:878` rather than
inferred, and `Gate` imported as a type from `src/governance/schema`. The success path at `:1200`
reports `staged.gate`, with one narrowing: `staged.gate === 'refuse' ? ('approval' as const) : staged.gate`.
That narrowing is the implementer's own decision and it is the right one. `StageOutputSchema`
names only `auto | approval`, so a stored `refuse` cannot be expressed in the tool's declared
output, and the comment at `:1196-1200` states the direction of the error: a draft stored as
`refuse` is more locked than the answer claims, never less, because nothing commits it without a
human and no human can approve it. The refusal path keeps its literal, which the schema permits.
Two cases cover both halves, one asserting the stored gate and the returned gate agree when the
stub answers `auto`, and one asserting that a `refuse` draft is stored as `refuse` while the
answer is clamped to `approval`.

**A8.4, `tokenOf`.** `:1057` now defines `const TOKEN_SHAPE = /^[a-z][a-z0-9_]*$/` and `tokenOf`
returns the whole message unless the segment before the first colon matches. The new case feeds a
driver-shaped error, `D:\Code\CRUM\src\db\client.ts: pool exhausted`, and asserts the full message
survives into the refusal and that `refused (D)` does not appear.

**A8.5, two sentences.** `campaign_not_found` at `:1044` now reads "no campaign with that id was
created by a completed publish on the bundle named in the request", because the one raise site
tests four conditions and a campaign created under a different bundle is the common half of the
failure. The comment at `:1163-1169` is rewritten so the claim "the declared class decides the
gate" is explicitly about the hook, whose campaign id is the empty literal, and explicitly not a
claim about `execute`, which scores the model's string and can reach 90 and `refuse`.

**Parked, as ruled.** `campaignExternalId` still has no shape validation, and
`src/mastra/instructions.ts:100-105` still names an admin-only tool to roles that cannot reach
it. Neither was attempted. Both belong to the slice-end register.

## Gates, run by the controller after the crash

Focused file: `npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts` gives
`Test Files 1 passed (1)`, `Tests 21 passed (21)`, up from 17 cases, with four added.

Named set: `npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts tests/mastra/instructions.test.ts tests/db/marketing-commit.test.ts tests/governance` gives
`Test Files 14 passed (14)`, `Tests 309 passed | 1 todo (310)`. The one todo is the pre-existing
`tests/governance/conformance.test.ts` case.

Wider regression sweep, run because a required argument touches eleven call sites:
`npx vitest run tests/mastra tests/db tests/api` gives `Test Files 99 passed (99)`,
`Tests 1026 passed (1026)`, nothing failed and nothing skipped.

Integration, with `CRUM_INTEGRATION_DATABASE_URL` exported in the same shell:
`npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts tests/integration/analyst-cron.test.ts tests/integration/pending-writes.test.ts`
gives `Test Files 3 passed (3)`, `Tests 15 passed (15)`. All three files ran; none skipped.

`npm run typecheck` exits 0. `npm run lint` exits 0.

## Mutation evidence, measured by the controller

Each mutant was applied, run against the focused file, reverted, and the file confirmed back to
`60 insertions, 17 deletions` against `667384e` afterwards.

| Mutant | Result | Cases that died |
| `campaignId: 'delete everything now'` in the payload the hook scores | `Tests 1 failed \| 20 passed (21)` | `requireApproval scores the identifier-only placeholder for both statuses` |
| `&& input.status === 'PAUSED'` appended to the hook's return | `Tests 1 failed \| 20 passed (21)` | the same case, which now drives both statuses |
| `runId: 'analyst-cron'` for every origin | `Tests 1 failed \| 20 passed (21)` | `labels the draft with the lane that staged it...` |
| `gate: 'approval' as Gate` returned instead of the computed gate | `Tests 2 failed \| 19 passed (21)` | `carries the gate it stored out to its caller` and `reports the gate the draft was stored with, within what the schema can name` |

Both I1 mutants from review 1, which survived 17 of 17 before this round, now die on the case that
exists to catch them. A345ab8 is the commit.

## What the controller did not do

I did not review this round independently. That is the next step, and the reviewer gets its own
output path, `task-17-review-3.md`, which is the correction to the collision described at the top
of `task-17-review-1.md`.

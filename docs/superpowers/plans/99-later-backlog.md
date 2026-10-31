# CRUM Later Backlog: capabilities modelled on Cedar, a production GTM workspace

**Ideas attributed to Cedar (cedarcopilot.com).** See provenance per item below and re-verify the
source observation before implementing anything from this file.

**Status: deferred, and unverified as to size.** Nothing here is in scope for Phases 0 through 7. No
day estimates appear in this file on purpose: they would be guesses, and §"Verify against the
artifact" in the roadmap forbids guessing in a document the phases inherit. Size each item when it is
promoted into a real phase plan, against the shipped `.d.ts` files, the way Phase 0 sized itself.

**Source of the ideas, and what an implementer must re-verify.** Every capability in this file is
inferred from **Cedar (cedarcopilot.com)**, a Y Combinator backed go-to-market agent workspace. No
code, prompt, schema, wording or UI was taken from them. The ideas are attributed so that whoever
implements one can go back to the original observation instead of trusting this document.

**The inference is weak by construction.** It was drawn from public marketing pages on 2026-10-23,
using a rendered accessibility snapshot of a JavaScript single-page app, over two pages only:

| Page | Read | What it supported |
|------|------|-------------------|
| `https://cedarcopilot.com/` | Yes | The positioning claim, the three-part agent doctrine, the KPI selector and its "one to three KPIs" scoping note, customer quotations grouped by capability |
| `https://cedarcopilot.com/agent-library` | Yes | A one-sentence description of what an agent page contains, and roughly thirty agent names with one-line summaries |
| `/platform/workspace`, `/personas/*`, `/pricing`, `/blog`, `/wall-of-love` | **No** | Not read. These are where a real design answer would live |
| Their docs, API, security page, changelog | **No** | Not found or not read |

Consequences to carry forward. The per-agent field list behind B1 comes from a single sentence about
what their agent pages show, which is a claim about their UI, not evidence of a schema. The behaviour
behind B3, B6, B7 and B9 comes from one-line feature summaries, which routinely describe a roadmap as
though it were shipped. Anything here that sounds like a fact about their internals should be treated
as an unverified hypothesis.

**Re-verification protocol before promoting any item.** Fetch the specific page named in the
provenance table below, confirm the behaviour is real rather than advertised, and then decide whether
CRUM's version is actually the same problem. If the marketing claim does not survive being opened, the
item loses its justification and should be cut, because none of these items stand on their own merit
alone, they stand on "a funded team shipping to real sales teams decided this was worth building".

**Attribution obligation.** If an item here is implemented, its commit message and its spec change-log
entry name Cedar and the page the idea came from. This is both honesty about the idea's origin and the
reason the licence gate exists in the roadmap's global constraints: concepts are not protected, wording
and code are, and the distinction has to stay documented rather than assumed.

**Method note.** Every item below carries a spec status, checked against `docs/TECHNICAL_PLAN.md`
v0.3.0 before the item was written. Line numbers are given because the spec is 5,527 lines and a
section number alone was not always findable. Two items were demoted to policy gaps and one was
corrected after this check, which is the reason the field exists.

**Why CRUM is positioned for these.** Receipts, draft hashes, committed payloads and the audit store
from Phases 0 through 3 are the substrate most of this consumes. CRUM records what an agent proposed,
whether a human approved it and what actually landed. That pairing is the input for the strongest
items here, and a bolt-on approval dialog does not produce it.

## Inherited constraints

Every item obeys the roadmap's global constraints, and three bind hardest:

- Every new write path needs a `policy/tools.yaml` entry with a class and idempotency key, a
  denial-path line in `docs/verification/denial-paths.md`, and a risk term in `policy/risk.yaml` if it
  can be irreversible. §12.2.
- Every new table carries a non-nullable `tenant_id` and is reachable only through `tenantScope`
  inside tool `execute`. §9.2.
- Governance is policy data. An item that needs a hard-coded threshold in a handler is the wrong
  design for CRUM even where the reference product does it that way.

## Entry gate

An item graduates into a phase plan only when it can state all four: the `tools.yaml` or schema diff,
the scorer or test that proves it, the failure mode it prevents, and the user-visible artefact. Items
that cannot state those are ideas, not backlog.

## Summary

| Item | Spec status | Verdict |
|------|-------------|---------|
| B1 Review contract per tool | New. "review surface" returns zero hits in the spec | Propose now, decide the schema during Phase 3 |
| B2 Evidence-linked writes | Amends §6.3.6 citation contract (line 2529) | Framing matters, not the idea |
| B3 Batch receipts | New. All 14 "batch" hits are `BatchPartsProcessor` or `embedInBatches` | Propose, with no mechanism assumed |
| B4 Acceptance scoring | New. "edit distance" zero hits; Phase 6 captures human feedback on a trace | Closest to genuinely valuable |
| B5 Tenant-scoped policy | **Already partly designed.** `RETRIEVAL_TENANT_OVERRIDES` lines 2514, 4860; tool-availability ruling line 4351 | Demoted to a gate-threshold extension |
| B6 Inbound mail | **Already designed.** `WebhookSignalProvider` line 1317, `intentTriageFlow` line 199 | Demoted to a `tools.yaml` gap |
| B7 Self-cancelling sequences | Adjacent to Phase 7 signals and `ifIdle` line 1324 | New behaviour, existing plumbing |
| B8 Playbook derivation | New *kind*. Spec line 2192 treats playbooks as uploaded documents | Strongest differentiator |
| B9 Admin usage reporting | Overlaps Phase 6 digest and the export section line 4816 | Cut to a view over existing data |

## Provenance per item

The page and observation each idea came from, so an implementer can re-check it rather than trust this
file. "Advertised" below means the claim appeared as a one-line feature summary and was never opened.

| Item | Source | Observation | Verify by opening |
|------|--------|-------------|-------------------|
| B1 Review contract | `/agent-library` | One sentence describing what an agent page shows: trigger, context, what you review, example output | Any single agent page, and check whether those four things are actually present |
| B2 Evidence-linked writes | `/agent-library` | A CRM update agent summarised as keeping records aligned with what buyers said, with evidence per field and approvals where the process needs them. Also a customer quotation on `/` about notes updating automatically in an external CRM | The CRM update agent page, looking for how evidence is attached and displayed |
| B3 Batch receipts | `/agent-library` | Sequencer summaries imply review-once-then-run rather than per-item approval | A sequencer page, checking what the approval prompt actually covers |
| B4 Acceptance scoring | `/` and `/agent-library` | A repeated theme that agents are accountable to a measured number, plus an internal usage agent described as reporting whether reps used the output | The usage reporting agent page, and any metrics surface |
| B5 Tenant-scoped policy | `/` | A KPI selector accompanied by a note that organisations typically move one to three top metrics | The onboarding or workspace page, to see whether KPI choice really scopes configuration |
| B6 Inbound mail | `/` and `/agent-library` | Customer quotations about the system reading inbound email and updating records, plus an inbound notifier and a daily agenda agent | The notifier and agenda pages, for trigger granularity and what counts as needing attention |
| B7 Self-cancelling sequences | `/agent-library` | A sequencer summary stating it stops when the prospect replies | A sequencer page, for how cancellation and audit are handled |
| B8 Playbook derivation | `/` and `/agent-library` | A three-part doctrine including improvement with every deal, plus coaching agents described as working from the rep's own conversations | A coaching agent page, for whether the corpus is behavioural or documentary |
| B9 Admin reporting | `/agent-library` | An internal usage agent reported as showing what agents did and where the workflow needs improvement | The same page as B4, since the two overlap heavily |

Note that B4 and B9 rest on the same source observation, which is a further reason to treat them as one
investigation rather than two items.

## B1. Review contract per tool

**Spec status: new.** `ToolPolicySchema` in `src/governance/schema.ts` carries name, description,
scope, class, idempotent and idempotency key. Nothing in the spec tells a reviewer what they are
looking at.

Extend each declaration with the fields a reviewer needs: when it runs, what context it reads, what
the human is approving, one example output. The Phase 3 queue has to render something per draft; if
that surface is invented inside the queue UI it becomes per-tool special casing that no policy file
controls. Deciding the four fields is a schema change and is cheap now. Building the rendering waits
for Phase 3.

**Risk if deferred: high.** Every tool added in Phases 2 through 5 makes the omission more expensive.

## B2. Evidence-linked writes

**Spec status: amends §6.3.6.** The citation contract at line 2529 already enforces citations on
prose answers through `CitationGuardProcessor`, with `faithfulness` and `contextPrecision` as the
offline twins, and `knowledge.retrieve` returns `sourceId` and `span` for it. What it does not cover
is the write path.

Frame this as extending an existing contract rather than inventing one: every field a draft proposes
carries the message, thread or document span it came from, and the console deep-links it. An
approver who cannot see the evidence approves on trust, which is the exact failure the governance
plane exists to prevent.

**Depends on:** Phase 3 draft staging. **Risk if deferred: high,** because the draft record shape is
created there and receipts, the queue and the audit store all read it.

## B3. Batch receipts

**Spec status: new, and no mechanism exists yet.** One correction to an earlier draft of this file:
the `run.side-effect` `{workflow}:{step}` template is **not** the grouping construct this needs.
`scopeFor` substitutes two strings and throws if either is missing, which names a scope and nothing
more. Batch approval requires a real design: a parent action hash covering a set of drafts, single-use
semantics that hold under concurrent partial approval, and per-item revocation.

The product argument stands on its own. Per-record gating is safe and exhausting, and exhausted
reviewers click approve.

**Depends on:** Phase 3.

## B4. Acceptance and edit-distance scoring

**Spec status: new, adjacent to Phase 6.** Phase 6 already lands human feedback on a trace. This is
different and automatic: compare the approved draft against the payload that actually committed, score
the difference per tool, and feed it to the eval gate beside `tenantIsolation`.

The value is that it measures whether the agent is useful rather than whether it is correct, and it
catches the quiet failure nobody watches for, an agent whose output is valid and constantly edited.
CRUM can compute it from columns Phases 0 through 3 write anyway.

**Depends on:** Phase 3 and Phase 6.

## B5. Tenant-scoped gate thresholds

**Spec status: largely already decided; demoted from a feature to an extension.** The pattern exists
at lines 2514 and 4860, where `RETRIEVAL_TENANT_OVERRIDES` resolves per-tenant JSON through
`requestContext` at execution time. Line 4351 goes further and rules that per-tenant tool availability
is enforced by authorization and `requestContextSchema`, *not* by mutating a shared registry.

So the remaining gap is narrow: apply the same resolution to `gateFor`, which currently discards its
`context` argument in `src/governance/policy.ts`. Overrides raise strictness only, never lower a class,
and unknown tools still fail closed. The earlier version of this file proposed narrowing a tenant's
enabled tool set, which contradicts the existing ruling and is withdrawn.

**Depends on:** Phase 3.

## B6. Inbound-derived CRM writes

**Spec status: the plumbing is already specified; the tool surface is missing it.** Line 1317 gives
`WebhookSignalProvider` inbound email events including a customer reply waking a thread, line 1324
sets `ifIdle` on it deliberately, and line 199 routes an inbound message through `intentTriageFlow` as
a workflow rather than a model decision. The gap is narrower than it first looked: `policy/tools.yaml`
has `mail.draft` and `mail:send` and no write tool that an inbound thread would call, although
`crm.log_followup` is already class `auto` with a `correlationId` key.

So this becomes a policy addition, decided during Phase 5 with the SMTP connector: which inbound
observations may be logged automatically, and which imply a stage change that must be approved. Do not
re-plan the signal path.

## B7. Self-cancelling sequences

**Spec status: new behaviour on existing Phase 7 plumbing.** A scheduled multi-step chain that halts
when the counterpart replies, clears pending steps and records why. Without it, a cadence agent keeps
sending after it should stop, which is the fastest way to lose a customer's trust in an autonomous
system. This is a safety property of autonomy, not a feature.

## B8. Playbook derivation from accepted history

**Spec status: new in kind.** Line 2192 puts playbooks in the *uploaded document* bucket, retrieved
with the rest of the knowledge base. This is the other thing: mine the accepted drafts to surface what
works for this tenant, then use it as a grounded source for future drafts.

CRUM's receipts hold both the proposal and the human decision, which is labelled training data
produced as a side effect of operating. **Depends on:** B4 and Phase 4. Do not start before a few
hundred accepted drafts exist, or the pattern is noise.

## B9. Admin reporting

**Spec status: overlaps what already exists.** Phase 6 lands a weekday digest, and line 4816 already
specifies per-customer and per-tenant export with field selection. What is left is an admin view over
data the audit store holds: what ran, what humans reviewed, what they skipped, what it cost, which
tools are barely used. Cut it to that.

## Explicitly out of scope for CRUM

Roadmap risk 4 names scope creep as an active threat and already rules out telephony, IM, payroll,
finance ledger and a no-code builder. Consistent with that:

- **A large named agent library.** They sell breadth to many go-to-market teams. CRUM's thesis is one
  agent scoped by request context, and a catalogue of thirty personas contradicts ADR-001 for no
  governance gain.
- **Social-channel outreach and reaction-based prospecting.** Needs channel authorisation and rate
  handling CRUM has no reason to invent.
- **Deck and presentation generation.** A document product, not a relationship system of record.
- **Cross-team competitive and product-gap reports.** Downstream of a call and email corpus CRUM does
  not ingest.

## Suggested order

B1 and B2 as schema decisions taken during Phase 3 even though their interfaces land later, because
both change record shapes. B4 next, as the item most likely to change how you judge the other eight.
Then B3, B7, B8, B9. B5 and B6 are policy amendments and can be settled inside their own phases rather
than deferred.

## Write-back obligation

Definition of done rule 4 makes `docs/TECHNICAL_PLAN.md` the authority, and this file currently
contradicts it in two places now corrected and extends it in one. Before any item here enters a phase
plan, the spec's Later list must be updated to either adopt or reject it, with a change-log entry.
This document is a proposal to that list, not a substitute for it.

## Deferred from the console Chats phase

These two items did not come from Cedar. They are gaps the console redesign hit while it was being
built, recorded here so that "deferred" means "written down somewhere findable" rather than "quietly
dropped". Attribution obligation does not apply.

### C1. Assistant answer feedback (thumbs)

**Deferred in Phase 3 of `2026-10-26-console-ia-chats-design.md`.**

The spec asked `/chats/[id]` to post thumbs on an assistant answer to the existing `/api/feedback`
endpoint, using the trace and span ids carried in stored message metadata. The pinned storage shape
does not persist those ids. `console/lib/types.ts` already says so, the messages response reports
`trace_available: false` in practice, and the conversation view therefore ships without the control.

**Why it was not faked.** A vote that cannot be attached to a trace is a button that writes nothing
useful. It would also read to the operator as a recorded judgement, which is worse than an absent
control.

**What has to land first.** The mapping module in `src/api/message-mapping.ts` needs real trace and
span ids to read out of stored metadata, which means the chat route has to persist them on the
assistant message when the run finishes. Then `/chats/[id]` can render the control behind the
`trace_available` flag the response already carries, and the flag stops being a constant.

**Proof it is done:** a test that a message with metadata renders the control and posts both ids, and
one that a message without metadata renders nothing rather than a disabled button.

### C2. Thread list row omits `title_pinned`

**Deferred in Phase 2, unresolved in Phase 3.**

`GET /api/agent/threads` returns `id, title, created_at, updated_at, resource_id` and does not carry
`title_pinned`, while `GET /api/agent/threads/:id` and the rename `PATCH` both do. The console types it
as optional and treats absence as "not pinned", which is safe today because only the rename dialog
reads the flag.

**What breaks if it stays.** Any list-level affordance that depends on the pin, such as showing a
"pinned by you" marker on a row, would silently render nothing on the list read and something on the
detail read. Two surfaces, two answers about the same row.

**Fix:** add the flag to the list SELECT in `src/api/agent.ts`, or stop returning it from the item read
and derive it in one place. Either way the shapes agree.

## Deferred from the console page-migration phase

One item, again not from Cedar. It surfaced while Home was reading the digest in Phase 4 and is recorded
here for the same reason as C1 and C2: deferred has to mean written down.

### C3. The digest follow-up label reads a field the table does not have

**Deferred in Phase 4 of `2026-10-26-console-ia-chats-design.md`.**

`src/mastra/workflows/digest.ts` builds the stale follow-up label from `f.note`, and `followups` has no
such column. `migrations/0002_crum_spine.sql` defines `notes`. `CrumFollowup` in `src/db/queries.ts`
carries both names, `note` because the `crm.list_followups` tool output schema pins it and `notes`
because that is the column, so the expression type checks and the label always falls through to
`Followup <id prefix>`.

**Why it was not fixed in Phase 4.** Nothing renders that label yet. The Home today card shows the
three counts and the composed summary, and the summary counts items without naming them. There was no
test to change and no surface to prove a fix against.

**What breaks if it stays.** The first consumer that lists stale follow-ups, including a future digest
detail view, shows an id fragment where the operator's note belongs, and it will not look broken enough
for anyone to report.

**Fix:** read `notes` first and keep the pinned `note` as a fallback, or drop `note` from the query
shape and correct the tool schema that pins it. **Proof it is done:** a test over a follow-up row with
`notes` set that expects the note to appear in the label.


## Deferred from the marketing team slice 1

Six items, none of them from Cedar. Slice 1 (the six-role marketing team, phase one) finished with the
whole repository gate run against it, and these are the things the gate surfaced that the slice was not
allowed to fix. One of them, M1, is not really a "later". It is red in CI right now and it needs a
decision, so it is first.

Evidence for every item below lives in `.superpowers/sdd/2026-10-30-marketing-team-slice-1/`: the raw
gate logs are `gate-unit.log`, `gate-integration.log`, `gate-console.log` and `gate-eval.log`, and the
reasoning is in `progress.md`, `task-11-report-step6.md`, `final-review-1.md` and
`task-9-rereview-1.md`. That directory is gitignored, so this section is the durable copy.

### M1. Six integration tests are red, and five of them have a verified one-line fix

**Deferred with an owner decision, 2026-10-31.** The owner chose to have it ticketed rather than have
slice 1 fix pre-existing breakage inside a feature branch.

`npm run test:integration` against the throwaway cluster gave `7 failed | 48 passed | 2 skipped`. The
real count is six, and none of the six is caused by slice 1. Two files hold five of them,
`tests/integration/tenant-isolation.test.ts` and `tests/integration/user-isolation.test.ts`, and the
sixth lives in `tests/integration/migrations.test.ts`.

| Failure | Cause | Status |
|---|---|---|
| tenant-isolation, both tests | fixture UUIDs rejected by the schema | root cause proven, fix proven |
| user-isolation, all three tests | same | same |
| migrations, "refuses a second receipt for the same staged draft" | `INSERT` omits `draft_hash` | root cause proven, fix not attempted |
| migrations, "boots through main()" | **not a real failure** | my reused local schema, passes on a fresh database |

**Cause 1, five failures.** The fixtures are hand-written UUID literals whose version and variant nibbles
are not legal. `tests/integration/user-isolation.test.ts:35` uses `55555555-5555-5555-5555-555555555555`
and `tests/integration/tenant-isolation.test.ts:35-40` uses `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` plus
five like it. `zod@4.6.7` validates `z.string().uuid()` against RFC 9562, so the third group must start
with `1` through `8` and the fourth must start with `8`, `9`, `a` or `b`. Tool input therefore fails
validation before any isolation logic runs, `crm.get_customer` and `crm.list_customers` return an error
envelope instead of a row or an array, and the assertions at `tenant-isolation.test.ts:94` and `:115` and
`user-isolation.test.ts:88`, `:103`, `:119` all fail on shape. One fixture even says so out loud, with
the message `id: Invalid UUID`.

**Fix, and it is verified rather than proposed.** Swap the ten literals for RFC-legal equivalents, for
example `55555555-5555-4555-8555-555555555555`, which is the convention 46 other test files here already
follow, including `tests/db/marketing.test.ts:14` and `tests/mastra/prospect-tools.test.ts:26`. I proved it
by making the swap in a throwaway copy and running both files against a real PostgreSQL: `5 passed (5)`.
I then restored the two files from HEAD, so nothing here is committed and the working tree still holds
only the five files belonging to the memory-upgrade work.

**Cause 2, one failure.** `migrations/0003_crum_add_draft_hash.sql:20-21` made `pending_writes.draft_hash`
`NOT NULL`, long before slice 1. `tests/integration/migrations.test.ts:99-101` still inserts a draft with
a hand-written column list that omits it, so Postgres throws `null value in column "draft_hash" ...
violates not-null constraint`. The test's own subject is `uq_receipts_draft`, so the column is incidental
to what it checks.

**Fix:** add `draft_hash` to the column list and give it
`encode(gen_random_bytes(32), 'hex')`, which is exactly 64 hex characters and matches the
`/^[0-9a-f]{64}$/` shape the rest of the codebase pins. The row is rolled back at
`migrations.test.ts:121`, so the only thing the value has to do is stay unique across concurrent runs.
**Proof it is done:** that test passes against a fresh database.

**Why "boots through main()" is off the list.** `scripts/db-migrate.ts:111-145` returns only newly applied
files, so `result.applied` is empty on a database that already carries the spine, and my throwaway cluster
did. I recreated the check against an empty database and it passed. That failure was my environment, not
the repository.

**What breaks if it stays.** CI runs this lane. `.github/workflows/crum-ci.yml:137-143` sets both
`DATABASE_URL` and `CRUM_INTEGRATION_DATABASE_URL` from one `CI_DATABASE_URL` and runs
`npm run test:integration` against a fresh pgvector container, so all six fail there too: the five for
fixture reasons that do not depend on the database at all, and the `draft_hash` one for schema reasons
that CI's own `npm run db:migrate` step guarantees. I could not read an actual run to confirm it, because
`gh` is not installed on this machine, so treat CI red as strongly expected rather than observed. The
practical cost is that nobody trusts an integration red any more, including the one that would mean
something.

### M2. Three more test files carry the same illegal-UUID habit and are latent only because they never cross a validating schema

Found while writing M1. `tests/db/pending-writes-commit.test.ts`, `tests/db/prospect-queries.test.ts` and
`tests/unit/prospects/persist-score.test.ts` hold the same style of literal and pass today because they
hand the id to SQL or to a stub instead of to `z.string().uuid()`.

**What breaks if it stays:** the first time one of those ids reaches a tool input schema, that file goes
red for a reason that has nothing to do with what it tests, and the next reader repeats this whole
investigation. **Fix:** a one-time sweep, plus a cheap guard. A unit test that walks `**/*.test.ts`,
extracts UUID-shaped literals and asserts each one satisfies the rule zod applies is enough to stop it
recurring.

### M3. An expired draft can be neither approved nor rejected, and the bundle stays staged

**This corrects Ruling T6-K in the slice 1 ledger, which called it "not a deadlock". That ruling was
wrong, and I confirmed the correction in the code.** `src/api/approvals.ts:242-244` answers `410 expired`
before the rejection branch at `:246-256` can run, so `rejected_at` can never be set on an expired draft.
The idempotency index `uq_pending_draft_hash` (`migrations/0003_crum_add_draft_hash.sql:25-27`) is partial
on `receipt_id IS NULL AND rejected_at IS NULL` and says nothing about `expires_at`, so the dead row keeps
holding the unique key. `src/db/pending-writes.ts:93-94` then conflicts onto it with a deliberate no-op
update and `RETURNING *` hands the same expired row straight back. After `RUNS_APPROVAL_TOKEN_TTL_SECONDS`
(default 3600, `src/db/pending-writes.ts:86`) the state is a queue entry that answers 410 to yes and to
no, a re-stage that returns that same 410 row, and a bundle left `staged` by `src/db/marketing.ts:234-240`
that cannot be staged again. The only owner-side escape is accidental: change any hashed input, for
example the risk ceiling, to get a different draft hash, which leaves the dead row behind as permanent
clutter.

**Why slice 1 did not fix it.** It is shared behaviour, not marketing behaviour. All eleven approval-class
tools in `policy/tools.yaml:185-255` reach it through the same `getOrCreateDraft`. A fix changes the
meaning of expiry for the six CRM tools too, and slice 1's brief was one new approval flow, not a
governance-semantics change.

**Fix, two shapes, one decision needed.** Either let a rejection land on an expired draft by moving the
expiry check after the `approved: false` branch, or make expiry free the key by adding `expires_at >
now()` to the partial index predicate in a new migration. The first keeps the audit trail honest and lets
the owner say no. The second lets a re-stage win but silently discards the item the owner was already
looking at. **Proof it is done:** an integration test that ages a draft past `expires_at` and shows both a
rejection and a fresh stage reaching a usable end state, with no bundle stranded in `staged`.

### M4. A suspended run has no resume affordance, and its own endpoint reports it as a count with no rows

Staging a bundle did not reach the approval queue from chat on its own during the browser walkthrough.
`requireApproval` suspends `marketing.stage_bundle` before `execute`, the console renders "waiting for
approval" with no control to act on it, and `GET /api/approvals/suspended-runs` answers
`{"items":[],"total":1}`. The chain completed only because I posted directly to
`POST /api/approvals/:runId/decision`.

**Not a slice 1 defect.** `requireApproval` is on every approval-class tool, so marketing behaves exactly
like `crm.create_customer`. What is new is that staging is the first approval-class action whose whole
purpose is to create a queue item, so the gap now sits in front of the flow instead of beside it. The
owner-facing consequence: someone who works only in the console cannot start the marketing spine from
chat. A second consequence is ordering. The refusal for an unbuildable bundle lives inside `execute`, so
the reviewer is asked to approve the intention to stage before the builder has said whether it can carry
it out. The governance queue still stays clean, which is the guarantee the design actually makes.

**Fix:** return rows from `suspended-runs` and give the console one resume control per suspended run,
wired to the decision endpoint the plane already has. **Proof it is done:** stage a bundle from chat,
click once in the console, and see the draft appear in the queue without touching `curl`.

### M5. The denial-path suite covers seven of eleven approval tools, and the tool this branch added is uncovered

`tests/governance/denial-path.test.ts:20-28` iterates a hand-copied array of seven tool names while
`tests/governance/policy.test.ts:69` asserts the policy declares eleven. Not covered:
`crm.send_outreach`, `crm.resolve_merge_candidate`, `run.side-effect` and `marketing.stage_bundle`. The
last one is the tool this branch added, so the new approval tool ships without a refuse-threshold test.

**Fix:** drive the list off `toolByName` or `toolsByClass('approval')` instead of copying names, which
also covers the next added tool on the day it is added. This is the cheapest real coverage gain available
in phase one. Adjacent nit found at the same time: `policy/tools.yaml:184` still labels the section
`approval (10)` after `marketing.stage_bundle` made it eleven, and no test reads that comment.

### M6. Small honest-surface items parked by the whole-branch review

Four Minors the final review left open, each about one line, none worth a slice of its own.
`console/components/MarketingBundleView.tsx` renders `Saved {bundle.createdAt}` as a raw ISO timestamp.
`suspended-runs` returns the items-less shape from M4. A flattened `funnel_plan` is reported as
`unreadable funnel_plan` where the nested-but-unsupported shape reports the designed
`no adapter for publish_page`, so two different authoring mistakes read differently. And the guard added
by finding F1b is narrower than its own test comment claims, because
`console/tests/MarketingBundleView.test.tsx` never routes `/api/marketing/bundles/`, so deleting the
fallback inlines a path the suite cannot see. Full reasoning in `final-review-1.md` and
`task-9-rereview-1.md`.

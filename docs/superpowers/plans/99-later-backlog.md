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

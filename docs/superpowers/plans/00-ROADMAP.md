# CRUM Implementation Roadmap

> **For agentic workers:** This is the phase map, not an executable plan. Each phase has its own
> plan document in this directory. REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans against the individual phase plan, never against
> this file.

**Goal:** Build CRUM, a conversational CRM workbench on Mastra with a governance plane, in eight
phases that each end in something runnable, testable and demonstrable.

**Architecture:** One supervisor agent scoped by context rather than fixed lanes, a tool harness
whose permission classes come from versioned YAML, a native pre-execution approval gate whose queue
of record is a Postgres table rather than a workflow snapshot, and an observability plus eval loop
that measures the whole thing.

**Tech Stack:** TypeScript 5.9.3 ESM on Node 22.18.0+, `@mastra/core` 1.79.0, `@mastra/mcp` 2.5.0,
`@mastra/pg` 1.32.0, Zod 4, Vitest 3, Next.js console, Supabase Postgres with PgVector.

**Spec:** [`docs/TECHNICAL_PLAN.md`](../../TECHNICAL_PLAN.md) v0.3.0. This roadmap argues from that
spec. Section references below are to it.

## Global Constraints

These apply to every task in every phase. Exact values are copied from the spec.

- **Versions are pinned exactly, never with a caret.** `@mastra/core@1.79.0`, `@mastra/mcp@2.5.0`,
  `@mastra/memory@1.39.0`, `@mastra/pg@1.32.0`, `@mastra/rag@2.7.0`, `@mastra/evals@1.10.8`,
  `@mastra/observability@1.21.0`, `@mastra/ai-sdk@1.11.2`, `@ai-sdk/typesafe-ai@3.0.24`,
  `typescript@5.9.3`, `zod@4.6.7`, `vitest@3.2.7`, `yaml@2.9.1`, `pg@8.23.1`. A caret range on
  `@mastra/core` resolves below 1.78.0 and `beforeApproval` disappears (Appendix B).
- **Node floor is 22.18.0.** Asserted in `engines`, in CI, and in the devcontainer. Node 20 passes
  CI against a runtime production cannot use (§14.2).
- **Relative imports are extensionless.** `moduleResolution: "bundler"` plus `mastra build`
  bundling plus Vitest resolution all agree on extensionless. The `.js` suffixes that appear in the
  spec's code samples are illustrative of Mastra's own source style and are not CRUM's convention.
- **A workflow step's `execute` takes one params object. A tool's `execute` takes two positional
  arguments.** `(inputData, context)` for tools, `({ inputData, mastra, requestContext })` for
  steps. Getting this backwards compiles in one direction and throws at runtime (§6.3.2).
- **`SamplingStrategyType` is an enum from `@mastra/observability` and takes `probability`.
  `ScoringSamplingConfig` is a string-literal union from `@mastra/core/evals` and takes `rate`.**
  They look alike and are not interchangeable in either direction (§7.2.1, §8.1).
- **Every table carries a non-nullable `tenant_id`.** No exceptions (§9.2).
- **Secrets are names, never values.** No `.env` value is read into a document, a commit, a log line
  or a browser bundle. `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` never appear behind a
  `NEXT_PUBLIC_` prefix (§13.6).
- **License gate.** Concept-level study of Wukong AICRM only. No copying of code, schemas, prompts
  or UI from their repos. Everything written fresh on Mastra. The reference repo is PolyForm
  Noncommercial with a Competitive Use clause naming CRM and sales automation.
- **Fail open to safe, fail closed on identity.** A missing model key disables a guardrail with a
  boot warning. A missing tenant claim returns an error result, never an empty list that looks like
  success (§12.4, §13.8). The two deliberate fail-closed exceptions are `MCP_REQUEST_STATE_KEY` in
  production and the missing injection-guard credential, which logs at `error`.
- **Verify against the artifact, not the summary.** Where a claim is load-bearing, read the shipped
  `.d.ts` or the raw documentation page. Two items remain honestly unverified and are listed in
  Phase 0 Task 12.

## Commit and Branch Conventions

One branch per phase, cut from `master`, merged back with `--no-ff` so the phase boundary is
visible in the graph. Inside a branch, one atomic commit per task. Every task in every phase plan
ends in a commit step.

```
phase/0-spine       phase/1-harness     phase/2-read-tools   phase/3-approvals
phase/4-rag         phase/5-mcp         phase/6-evals        phase/7-polish
```

Conventional Commits, with a scope drawn from this table so `git log --grep` filters a subsystem
cleanly:

| Scope | Covers |
|-------|--------|
| `build` | `package.json`, lockfile, version pins, `engines` |
| `config` | tsconfig, vitest, eslint, devcontainer, `.env.example` |
| `governance` | `policy/*.yaml`, the loader, the risk scorer, the gate resolver |
| `storage` | the storage builder, migrations, `scripts/db-*` |
| `harness` | the Mastra instance, agents, processors, memory, sessions |
| `tools` | CRM read and write tools, `tenantScope`, active-tool resolution |
| `approvals` | the approval gate, receipts, `pending_writes`, the queue UI |
| `rag` | ingestion, retrieval, the knowledge manager UI |
| `mcp` | the MCP 2.0 server, OAuth middleware, `requestState` |
| `evals` | scorers, golden dataset, the CI gate, judges |
| `observability` | tracing config, correlation, metrics, alerting |
| `console` | Next.js surfaces, theme tokens, layout |
| `ci` | GitHub Actions workflows |
| `docs` | the technical plan, phase plans, runbooks, verification findings |

Subject line under 72 characters, imperative mood, no trailing period. The body carries the *why*
and, where relevant, the spec section it implements. Example:

```
feat(governance): score write risk from policy/risk.yaml

Deterministic, no model call. Floors only ever raise a gate, so a draft
touching a sensitive marker can never be auto-gated whatever its computed
score. Implements TECHNICAL_PLAN.md §12.2.
```

## Phase Map

| # | Phase | Branch | Est. | Plan document | Ends with |
|---|-------|--------|------|---------------|-----------|
| 0 | Alignment and spine | `phase/0-spine` | 1-2 d | [`2026-10-23-phase-0-spine.md`](./2026-10-23-phase-0-spine.md) | A Mastra instance that boots persistent and in-memory, a policy plane under test, committed migrations, a green CI skeleton |
| 1 | Harness skeleton and streaming chat | `phase/1-harness` | 4-5 d | written at Phase 1 start | Streaming chat that survives a restart, session list under 300 ms, processor pipeline visible in a trace |
| 2 | Read tools, object binding, isolation | `phase/2-read-tools` | 4-5 d | written at Phase 2 start | Nine read tools returning real rows, object binding, cross-tenant reads failing closed |
| 3 | Write path, approvals, receipts | `phase/3-approvals` | 5-6 d | written at Phase 3 start | A chat sentence stages a draft, the queue ranks it, approval commits it, a receipt verifies, a restart mid-approval loses nothing |
| 4 | Knowledge RAG | `phase/4-rag` | 3-4 d | written at Phase 4 start | An uploaded document yields a cited answer, an unanswerable question yields a refusal, re-upload replaces rather than duplicates |
| 5 | Prefill, email, classification, MCP 2.0 | `phase/5-mcp` | 3-4 d | written at Phase 5 start | Pasted text prefills a form, an injection attempt is aborted, an external MCP client reads under its own principal and cannot reach a write |
| 6 | Evals, LLMOps loop, today view | `phase/6-evals` | 3-4 d | written at Phase 6 start | `eval:seed` then `eval:run` scores in Studio, the gate blocks a degraded prompt, feedback lands on a trace, the weekday digest arrives |
| 7 | Autonomy and polish | `phase/7-polish` | 2-3 d | written at Phase 7 start | Signals, one narrow goal with a hard run budget, accessibility pass, load test, runbook |

**Total 25-33 days part-time.** Phases 0-3 (14-18 days) are the demonstrable core.

### Why later phases do not have plan documents yet

A plan written at 2-5 minute step granularity for work six phases away would be fiction. Each phase
changes what the next one can assume: Phase 1 discovers how Agent Controller sessions actually
behave under a restart, Phase 3 discovers whether a function-valued `requireApproval` survives
persistence, Phase 5 discovers whether third-party MCP hosts accept dotted tool names. The phase
plan is written immediately before that phase executes, from the spec plus what the previous phases
actually produced. This roadmap is the stable part; the phase plans are the accurate part.

### Definition of done, per phase

A phase is done when all four hold:

1. Every task in its plan document is committed, and `git log --oneline master..HEAD` reads as a
   sequence a reviewer can follow.
2. `npm run typecheck`, `npm run lint`, `npm run test:unit` and `npm run test:policy` are green.
3. The phase's stated acceptance criterion from TECHNICAL_PLAN.md §16 has been demonstrated, not
   just implemented. Where the acceptance criterion needs a real database or a real model key, the
   demonstration is recorded in `docs/verification/`.
4. Anything the phase learned that contradicts the spec is written back into
   `docs/TECHNICAL_PLAN.md` with a change-log entry, so the spec stays the authority.

## Two Scaffold Defects Found While Writing This Roadmap

Both are fixed in Phase 0 Task 1 and Task 9. They are recorded here because they explain why Task 1
is a `chore` commit before any feature work.

**`.gitignore` line 6 ignores `docs/`.** The 5,528-line technical plan and every plan document in
this directory are untracked and would never be committed. `git check-ignore -v
docs/TECHNICAL_PLAN.md` confirms it. The repo's single commit `c8099fb` contains five files and no
documentation.

**`src/mastra/index.ts` does not compile.** It constructs
`new PostgresStoreVNext({ connectionString })`. The shipped declaration at
`@mastra/pg@1.32.0/dist/storage/index.d.ts:167` requires `observability`, and
`dist/shared/config.d.ts:8` requires `id`:

```typescript
export declare class PostgresStoreVNext extends PostgresStore {
    constructor(config: PostgresStoreConfig & {
        /** Connection config for the vNext observability domain. Required. */
        observability: PostgresStoreVNextObservabilityConfig;
    });
}
```

The doc comment is explicit: "The `observability` connection is **required**: every caller has to
make an explicit decision about where observability data goes." The scaffold also pins
`@mastra/core` at `^1.76.0` and `zod` at `^3.24.0`, both below what the spec requires.

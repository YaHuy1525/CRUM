# Phase 0 Verification Record

Date: 2026-10-23
Branch: `phase/0-spine-task10`
Spec: `docs/TECHNICAL_PLAN.md` v0.3.0, now v0.3.1, §16 Phase 0

## Scope

Phase 0 spans 25 commits: 17 on `main` covering Tasks 1-9, and 8 on
`phase/0-spine-task10` covering Tasks 10-14, this record included. One commit
per landed unit of work; every commit leaves `npm run verify` green on its own.

## What was checked

Every "pass" below comes from a run of the named command on 2026-10-23 against
`phase/0-spine-task10`. The four cells marked as captures are one-time
demonstrations that cannot be re-run on a green tree without re-breaking it;
each cites the task that performed it.

| Check | Command | Result |
|---|---|---|
| Version pins resolve and are exact | `npx vitest run tests/build/pins.test.ts` | pass (23/23) |
| Step and tool signatures match the installed declarations | `npm run typecheck` | pass |
| The signature alarms actually fire | Task 4's `sed` demonstration | fired (one-time capture, Task 4) |
| Sampling enum and literal forms both compile | `npx vitest run tests/smoke/sampling.test.ts` | pass (8/8) |
| Policy files parse and conform to §4.6.2 | `npm run test:policy` | pass (131 passed, 1 todo) |
| The conformance suite can fail | Task 8 Step 3's deliberate break | failed as expected (one-time capture, Task 8) |
| Environment contract matches `.env.example` | `npx vitest run tests/config/env.test.ts` | pass (18/18) |
| No real credential shape is committed | Task 9 Step 6 grep | no match (one-time capture, Task 9) |
| The storage config the shipped constructor requires | `npx vitest run tests/mastra/storage.test.ts` | pass (23/23) |
| Migrations apply, are idempotent, and reject an edited history | `npm run test:integration` | skipped — no database locally (1 passed, 6 skipped) |
| The Mastra instance boots both ways and fails closed on the MCP key | `npx vitest run tests/mastra/boot.test.ts` | pass (30/30) |
| The CI workflow calls only declared scripts | `npx vitest run tests/ci/workflow.test.ts` | pass (21/21) |
| The schema snapshot is deterministic | Task 11 Step 9, `restored=0` | deterministic (one-time capture, Task 11) |

Suite totals from this round's runs: `npm run verify` exits 0 (13 test files;
285 passed, 6 skipped, 1 todo). `npm run test:integration` exits 0 with 1
passed and 6 skipped: `CRUM_INTEGRATION_DATABASE_URL` is not set on this
machine, so the six database-backed tests skipped rather than failed. Because
of that, the acceptance clause "migrations apply to a clean Supabase" is **not
yet satisfied** and is carried as open item 2 below rather than claimed.

## Open items carried by the skips

1. The six integration tests skipped for want of `CRUM_INTEGRATION_DATABASE_URL`.
   They must be run against a real database before the migration checks in the
   table above can be marked pass rather than skipped.
2. §16's acceptance line "migrations apply to a clean Supabase" is therefore
   unverified. CI proves the migrations apply to `pgvector/pgvector:pg17`,
   which is not the same thing. See "What was NOT checked", item 3.

## What was NOT checked

These are open, owned, and each has a named phase and a fallback. They are not
omissions from the record; they are the reason the record exists.

### 1. Function-valued `requireApproval` under persistence

§4.6.5 and §16 both flag this as unverified. The documented constraint that a
function-valued approval option cannot survive serialization is written for
`requireToolApproval`, the client- and agent-level option. Whether the same
constraint reaches a tool's own `requireApproval` field on a durable or stored
agent is not settled by the declarations.

Why it cannot be checked in Phase 0: CRUM constructs no agent and mounts no
durable wrapper. §4.6 records that durable agents are Beta and that CRUM does
not use them in Phases 0 through 3.

When it must be checked: Phase 3, before the first approval-class tool ships.

How to check it: build a durable agent with one tool whose `requireApproval` is
a predicate returning `false` for a benign input. Run it, let it suspend, resume
on a fresh process against the same storage, and observe whether the predicate
was re-evaluated or replaced by always-approve.

Fallback if the predicate does not survive: `requireApproval: true` on every
mutating tool, with the policy decision moved into `beforeApproval`, which
returns `proceed: false` for anything the policy would have gated at `auto`.
This is always-approve. It is safe and merely noisier, and it keeps the risk
scorer as the single source of truth for what a human sees.

Consequence of guessing wrong: not a crash. Every read-only tool starts
demanding approval, which is a product outage discovered by users rather than by
a test.

### 2. Dotted MCP tool names over the 2026-07-28 wire

§10.3 keeps the in-process registry key and the advertised MCP tool name equal,
and §4.6.2 names every tool with a dot: `crm.list_customers`,
`knowledge.retrieve`. Whether third-party MCP hosts accept a dot in a tool name
is not settled by `@mastra/mcp@2.5.0`'s declarations.

Why it cannot be checked in Phase 0: `@mastra/mcp` is pinned but not imported.
No server is mounted until Phase 5.

When it must be checked: Phase 5, before the tool ids are load-bearing in the
console UI, the approval queue and the policy file.

How to check it: mount the Phase 5 MCP server with two tools, one dotted and one
underscored, and connect three hosts: Mastra's own MCP client, the MCP
Inspector, and one third-party host. Record which of the three lists and calls
each name.

Fallback if a host rejects dots: rename to `crm_list_customers` across
`policy/tools.yaml`, §4.6.2, the console and the approval queue in one commit.
The dot carries no semantics; it is a namespace separator that an underscore
separates equally well. What must not happen is the registry key and the
advertised name diverging, because §10.3's whole argument is that they are the
same string on every surface.

### 3. Migrations against a clean Supabase project

§16's acceptance line reads "migrations apply to a clean Supabase". The
integration run skipped for want of a database, so this is unverified and says
so in the table above. CI proves the migrations apply to `pgvector/pgvector:pg17`,
which is not the same thing: Supabase's session pooler, its `postgres` role
restrictions and its pre-installed extensions can each reject DDL that a bare
container accepts.

How to check it: create a throwaway Supabase project, put its session-pooler URL
in `CRUM_INTEGRATION_DATABASE_URL`, run `npm run db:migrate` then
`npm run test:integration`, then delete the project.

### 4. Anything requiring a model call

Phase 0 makes none. No prompt, no instruction block, no tool description in this
plan has been evaluated against a model. Every claim in §4.4 and §6 about agent
behaviour is still a hypothesis until Phase 1.

## Deviations from the spec found while implementing

Recorded here and written back into `docs/TECHNICAL_PLAN.md` as v0.3.1:

1. `.gitignore` line 6 ignored `docs/`, so the 5,528-line plan this phase
   implements was untracked. Fixed in Task 1.
2. The scaffold's `src/mastra/index.ts` omitted both fields
   `PostgresStoreVNext` requires and did not compile. Fixed in Task 12.
3. `OBSERVABILITY_DATABASE_URL` is a new variable, absent from §13. The
   constructor requires an observability connection and refuses to share the
   primary one implicitly. Added in Task 10.
4. §16 Phase 0 asks for `allowImportingTsExtensions`. Omitted. It exists to
   permit `.ts` suffixes on relative imports, and the roadmap convention is
   extensionless; enabling it allows both and the codebase drifts.
5. §9.2 shows three tables and defers the rest to a §6.1 that no longer exists
   in v0.3.0. The other six were derived from §5.1's business objects plus
   `human_tasks` from §4.6.1's refuse path.
6. §16 Phase 0 asks that `TYPESAFE_AI_API_KEY` or `JEV_API_KEY` resolve. Both
   are declared in `.env.example` and deferred to Phases 5 and 6. Neither is
   read by any Phase 0 code, and a test asserting they resolve would assert
   nothing.
7. §12.2's `tools.yaml` listing shows twelve entries while §4.6.2 lists twenty
   tools. The committed file has twenty-one, the twenty plus `run.side-effect`.
   §12.2 was illustrating the file's shape, not enumerating the surface.
8. §14.2's service image is `pgvector/pgvector:pg16`; CI uses `pg17`.
9. The README and §14.4 described development happening in the AllRounderAgent
   workspace. CRUM is a standalone repository. The README was corrected in
   Task 1, and §14.4's workspace references were corrected to CRUM's own
   standalone setup.
10. §14.2's push trigger is `branches: [main]`; the shipped workflow triggers
    on `main` and `phase/**`, so phase branches run the same gate without
    pushing to `main` first.
11. §14.2's eval gate and a11y gate are omitted from the Phase 0 workflow. The
    scripts they call arrive in Phases 6 and 1.
12. §14.2's canonical CI fixture
    `postgresql://postgres:postgres@localhost:5432/postgres` trips the DB-URL
    credential scanner, so the fixture token `postgres:postgres@` was added to
    the scanner allowlist in both the CI Credential shapes step and the local
    pre-commit hook. The local hook lives in `.git/hooks/` and is not
    version-controlled; only the CI step's allowlist is version-controlled
    (Task 13, commit 61e8810). Note that the shipped workflow itself connects
    with `postgres:changeme@`, which was already allowlisted, so the new token
    guards only documentation fixtures: the spec's §14.2 and this repo's plan
    text.

## Plan-text errata

Defects in the planning documents themselves, recorded so the next phase does
not inherit them:

- The roadmap and task briefs name the phase branch `phase/0-spine` and the
  default branch `master`. The actual branches are `phase/0-spine-task10` and
  `main`; every reference in Phase 0 documents uses the actual names.
- The Task 14 brief's denial-path tool list named `crm.update_contact` (no such
  tool), `crm.create_followup` and `crm.create_task` (both `auto` class, not
  approval), and a refuse tool `crm.export_customers` that does not exist.
  `docs/verification/denial-paths.md` was regenerated from `policy/tools.yaml`
  instead: the seven approval-class tools, the workflow-scoped
  `run.side-effect`, and the refuse-class `crm.bulk_import`.
- The Task 14 brief's expected cross-reference figures (378 references, 158
  numbered headings) are stale. The actual v0.3.0 figures are 92 unique
  §-references and 182 numbered headings, and the v0.3.1 write-back leaves both
  unchanged.
- Several earlier briefs carried verbatim-code defects that review caught —
  Tasks 4, 10, 11 and 12 among them — each corrected in its own task's commit.

APPROVED_WITH_NITS

Independent review of `1d85f96` `fix(governance): the write-claim guard is derived from policy and registry`, branch `feat/marketing-slice-5`, parent `e3404f2`. I did not write this commit. Every number below is mine.

## What I ran, with real output

Commit shape.

```
cd D:/Code/CRUM && git show --stat 1d85f96
 src/mastra/agent.ts                               |  2 +-
 src/mastra/processors/write-claim-guard.ts        |  7 +++
 tests/mastra/processors/write-claim-guard.test.ts | 75 ++++++++++++++++-------
 3 files changed, 60 insertions(+), 24 deletions(-)
```

Three named paths, no `-A`, no amend, nothing of the concurrent document effort in it. `git status --porcelain` on the four paths the commit owns is empty, so the tree state I reviewed is the committed state.

Gate 1, exactly as briefed.

```
cd D:/Code/CRUM && npx vitest run tests/mastra/processors/write-claim-guard.test.ts tests/mastra/agent.test.ts tests/mastra/processors tests/governance tests/mastra/active-tools.test.ts
 Test Files  17 passed (17)
      Tests  315 passed | 1 todo (316)
```

This matches the report's claim line for line. The `1 todo` is the pre-existing skipped case in `tests/governance/conformance.test.ts`, and `tests/governance/singleton.test.ts` (1 test, 507ms) and `tests/governance/injection-guard.test.ts` (4 tests, 1313ms) both ran.

Gate 2, with a substitution I have to name. `tests/mastra/prospect-writes-tools.test.ts` does not exist in the tree and has never existed in history (`git log --oneline -- tests/mastra/prospect-writes-tools.test.ts` prints nothing). The prospect write tools live in `tests/mastra/prospect-tools.test.ts`, which contains the `crm.send_outreach` safety checks, so I ran the two files that do exist.

```
cd D:/Code/CRUM && npx vitest run tests/mastra/prospect-merge-tools.test.ts tests/mastra/prospect-writes-tools.test.ts tests/mastra/prospect-tools.test.ts
 ✓  unit  tests/mastra/prospect-merge-tools.test.ts (7 tests) 573ms
 ✓  unit  tests/mastra/prospect-tools.test.ts (16 tests) 840ms
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

`tests/governance/prospect-tools.test.ts` (6 tests) also ran inside gate 1. Nothing in the prospect lane is red.

Gate 3.

```
cd D:/Code/CRUM && npm run typecheck && npm run lint
> tsc --noEmit        (no output, clean)
> eslint .            (no output, clean)
```

The measured sets, computed myself through the runtime loader rather than taken from the report.

```
cd D:/Code/CRUM && npx tsx -e "(async () => { ... loadPolicy() ... Object.keys(crumToolRegistry) ... MUTATING_TOOL_IDS ... })()"
policy tools 44
declared non-read-only 22
byClass {"read-only":22,"auto":7,"approval":14,"refuse":1}
registry keys 42
intersection count 20
declared unregistered run.side-effect,crm.bulk_import
guard size 20
registered mutating not guarded (empty)
guarded not declared (empty)
guarded not registered (empty)
```

Every figure in `task-18-report.md` and Addendum B2 held: 44, 22 as 7 plus 14 plus 1, 42, 20, 16 to 20. The `connectors:` block at `policy/tools.yaml:302` with its three `class: approval` entries and no `name:` stayed out of the count, which is what a loader read buys you over a file scan.

## Mutation experiments, question 1

Four mutants, one run each, all reverted, all proven reverted.

Mutant A, `src/mastra/processors/write-claim-guard.ts`, delete `'crm.send_outreach'`.

```
× WriteClaimGuardProcessor > guards exactly the mutating tools the agent can actually call
   → expected [ 'crm.create_contact', …(18) ] to deeply equal [ 'crm.create_contact', …(19) ]
× claimsWrite > leaves a true report of a send alone now that crm.send_outreach is guarded
   → expected [ Array(1) ] to deeply equal []
Tests  2 failed | 20 passed (22)
```

Survived: case 2 (`guards nothing the registry does not hold`) and case 3 (backlog). That is correct behaviour, not a hole. Dropping a real id cannot make a guarded id unregistered and cannot create a declared-but-unregistered name.

Mutant B, same file, add `'crm.tool_that_does_not_exist'` to the array.

```
× WriteClaimGuardProcessor > guards exactly the mutating tools the agent can actually call
   → expected [ 'crm.create_contact', …(20) ] to deeply equal [ 'crm.create_contact', …(19) ]
× WriteClaimGuardProcessor > guards nothing the registry does not hold
   → expected [ 'crm.list_customers', …(41) ] to include 'crm.tool_that_does_not_exist'
Tests  2 failed | 20 passed (22)
```

This is the R6 catcher, and it fires, exactly as the report claimed. The phantom id is caught by two cases, one of which names it in a `toContain` diff, so the failure text points at the guard rather than at the policy.

Mutant C, `policy/tools.yaml:244`, flip `crm.send_outreach` from `class: approval` to `class: read-only`.

```
× WriteClaimGuardProcessor > guards exactly the mutating tools the agent can actually call
   → expected [ 'crm.create_contact', …(19) ] to deeply equal [ 'crm.create_contact', …(18) ]
Tests  1 failed | 21 passed (22)
```

So the policy is a live source of case 1 in both directions. A class flip in either direction breaks it. The guard is not merely welded to the registry.

Mutant D, `policy/tools.yaml:300`, flip `crm.bulk_import` from `class: refuse` to `class: read-only`.

```
× WriteClaimGuardProcessor > names every declared mutating tool the registry is missing
   → expected [ 'run.side-effect' ] to deeply equal [ Array(2) ]
Tests  1 failed | 21 passed (22)
```

Case 3 has real power. It is not a decorative constant. When someone reclassifies a backlog name, the backlog assertion dies and forces the human to re-decide, which is the behaviour you want from a named-hole list.

No mutant survived undetected. After the experiments:

```
cd D:/Code/CRUM && git diff --stat -- policy/tools.yaml src/mastra/processors/write-claim-guard.ts tests/mastra/processors/write-claim-guard.test.ts src/mastra/agent.ts
(no output)
cd D:/Code/CRUM && git status --porcelain -- <the same four paths>
(no output)
cd D:/Code/CRUM && npx vitest run tests/mastra/processors/write-claim-guard.test.ts
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

The derivation is load-bearing. Every source it claims to read can kill a case.

## Question 2, did the count go

`toHaveLength(16)` is gone, and the only `toHaveLength` left in the file is `tests/mastra/processors/write-claim-guard.test.ts:125`, `expect(calls).toHaveLength(1)`. The defence is true. In `src/mastra/processors/write-claim-guard.ts:104-115`, a `retryCount` of 0 takes one `abort` call, and the second `abort` only runs when `retryCount >= 1`. That assertion counts one turn's abort callbacks, and it would catch a regression that double-fires the abort on the first pass, which is a behaviour worth pinning. It names no set, so nothing in it can go stale when a fifth prospect tool appears.

No other stated size survives in that file. `:43-46` spot-checks four provider names, which is a name list not a count, and `:66` asserts containment. The `MUTATING_TOOLS` cases at `:39` and `:65` both iterate the list, so a list of any length runs them.

For context rather than as a finding against this commit, the nearest remaining stale-count trap in the same gate is `tests/governance/conformance.test.ts:95`, `has exactly the forty-three spec tools plus run.side-effect`, which states the policy's size. That file owns spec conformance, so a number there is arguably its job.

## Question 3, the right four and the full four

The set is right and complete. `registered mutating not guarded` came back empty above, and `guarded not declared` and `guarded not registered` are both empty, so the guard list is exactly the intersection now and nothing more.

The two backlog names are genuinely unreachable, not missing.

- `crm.bulk_import` is `class: refuse` at `policy/tools.yaml:297-300`. `src/mastra/active-tools.ts:5-8` builds `CALLABLE_CLASSES` as `user: read-only, auto` and `admin: read-only, auto, approval`. Refuse is in neither, so `resolveActiveTools` can never return it. No implementation exists anywhere in `src` (a repo-wide grep finds it only in `policy/tools.yaml`, in `tests/governance/*`, and in plan docs). `tests/mastra/active-tools.test.ts:69` already lists it in `NEVER_CALLABLE`, and that file passes.
- `run.side-effect` is `class: approval` with `scope: "{workflow}:{step}"` at `policy/tools.yaml:289-292`. `src/mastra/active-tools.ts:18` drops any tool whose scope contains `{`, and `src/governance/policy.ts:134-140` throws unless both `context.workflow` and `context.step` are supplied. It is a scope label, never a callable id, and it is absent from `crumToolRegistry`.

Both were also independently caught by the `NEVER_CALLABLE` list in `tests/mastra/active-tools.test.ts`, which passed in gate 1, so this task did not have to invent the classification.

## Question 4, does the behavioural case prove the live bug

Yes. Mutant A killed `leaves a true report of a send alone now that crm.send_outreach is guarded`, and the failure text is the real retry prose, which is the exact false-positive the brief describes: an answer about a write that did get made is aborted with `write-claim-without-tool`. The case is wired to the real path, not to a stub.

- It instantiates `new WriteClaimGuardProcessor()` from the production module (`tests/mastra/processors/write-claim-guard.test.ts:152`) and calls the method the runtime calls, `processOutputStep`.
- The `toolName` it passes is `providerToolName('crm.send_outreach')`, which is the dotted-to-underscore form the Agent hands the processor (`src/mastra/active-tools.ts:25-34`).
- No mock is involved in this file. The only `vi.mock` of the policy loader in the whole suite is `tests/mastra/marketing-campaign-status-tool.test.ts:55`, a different file with a different module registry.
- The processor is genuinely installed in production: `src/mastra/processors.ts:44` puts it in `crumOutputProcessors`, `src/mastra/agent.ts:124` hands that to the Agent, and `tests/mastra/agent.test.ts:56-61` asserts its presence.

## Question 5, module-scope `loadPolicy()` in a test file

There is a real environment dependency here, and it is survivable today but not closed off.

`tests/mastra/processors/write-claim-guard.test.ts:16` calls `loadPolicy()` with no argument. Resolution then runs `defaultPolicyDir()` at `src/governance/policy.ts:97-100`, which tries `findPolicyRoot(process.cwd())` first and only then the module directory. So the file is pinned to the working directory of the process, and a stale copy of the pair inside the tree would be read instead of the one at the repo root. One such copy exists right now: `.qoder/worktrees/field-audit-phase2/policy/tools.yaml` and its `risk.yaml`. I compared them, `diff -q` reports both SAME, so today nothing drifts. The trap is that the guard test would go on reporting green while asserting against that other policy.

The `POLICY_DIR` question has a sharper answer. Only one place in the repository reads that knob, and it is the barrel singleton at `src/governance/index.ts:6`, `loadPolicy(parseEnv(process.env).POLICY_DIR)`. Nothing in `src` imports that barrel, the single importer anywhere is `tests/governance/conformance.test.ts:2`. Meanwhile every consumer in the lane this guard protects calls the loader bare: `src/mastra/active-tools.ts:11`, `src/mastra/tools/prospect-writes.ts:367`, `src/mastra/tools/approval-writes.ts`, `auto-writes.ts`, `customer-writes.ts`, `marketing-writes.ts`, `prospect-merge.ts`. So the test today asks the same question of the same file the runtime lane asks, which is the honest form of the derivation. It becomes a lie the moment either side changes: the day someone wires the singleton into the mastra lane, or sets `POLICY_DIR` in a deployment (it is a documented setting at `.env.example:90`), the green test describes a policy the process never loaded.

On ordering: no risk found. `vitest.config.ts` sets no `pool` and no `setupFiles`, so Vitest 3 defaults give each file its own child process, `process.chdir` appears nowhere in `tests`, and no file mocks the loader in a way that could reach this one.

What would have to change for the loophole to stop being possible, concretely:

1. Export the resolution from `src/governance/policy.ts` (today `defaultPolicyDir` at `:97` is module-private) and have the test call `loadPolicy(defaultPolicyDir())` through that one function, so the test and the runtime compute the same directory by construction rather than by coincidence, or
2. have the test read the same object the runtime reads, which means importing the policy the mastra lane actually consults and passing it in, or
3. if `POLICY_DIR` is meant to be load-bearing, make every loader call site resolve through the singleton instead of calling `loadPolicy()` bare, then assert against that singleton.

Any one of those three removes the coincidence. This is not a defect the commit introduced, it is a hole the design leaves open.

## Question 6, exporting `crumToolRegistry`

The one word at `src/mastra/agent.ts:55` is safe, and I checked the import graph rather than trusting Addendum B3.

- Module scope in `agent.ts` builds the registry object at `:55-98` and one `new Agent({...})` at `:100`. No network call, no provider handshake, no file read beyond the policy YAML the tools load lazily inside their own `execute`.
- `src/mastra/models.ts:13-24` reads `process.env` through `??` defaults, so an absent `CRUM_MODEL_MAIN` cannot throw at import.
- `src/db/client.ts:17-33` builds the pool only inside `getDbClient()`, behind a null check and an explicit `DATABASE_URL` guard, so importing the agent graph opens no socket.
- Nothing in the graph calls `parseEnv()` at module scope on a required field for the tools the test touches. `src/mastra/tools/auto-writes.ts:146` and `gmail.ts:39` call it inside `execute`.
- The precedent is older than this commit: `tests/mastra/agent.test.ts:3` already imports the module inside the unit project, and it passes without env or setup.
- Cost is measurable and trivial: the guard file's 22 tests run in 7ms, gate 1 finishes in 2.66s.
- Publishing nothing new is also true. The same object is handed to the Agent at `src/mastra/agent.ts:110`, it holds tool definitions and no credentials, and no secret appears in it.

## Question 7, live behaviour change

`MUTATING_TOOLS` feeds exactly two readers: `src/mastra/processors/write-claim-guard.ts:88-90` and `src/evals/custom-scorers.ts:55-56`. Nothing else in `src`, `console`, or `scripts` consults the list, so the blast radius is the runtime guard and the eval scorer.

- Prospect lane: 23 tests green across `tests/mastra/prospect-merge-tools.test.ts` and `tests/mastra/prospect-tools.test.ts`, plus `tests/governance/prospect-tools.test.ts` (6 tests) in gate 1.
- Nowhere is there an assertion that these four ids are absent from the guard. The negative assertions in the file (`tests/mastra/processors/write-claim-guard.test.ts:50-52`) name only read-only ids.
- Eval scorer: `isMutatingToolName` now answers true for the four, so `createWriteClaimScorer` can return 1 where it used to return 0. I grepped `src/evals/golden-items.ts` for `outreach`, `snapshot` and `merge` and found no item, so no recorded golden expectation moves. I did not run `tests/evals`, per the standing ban.
- No integration test names these tools (`grep -rln` over `tests/integration` returned nothing), so no live-database path changes either.

The production change is the intended one: a prospect turn that really wrote and reported the write is no longer retried and then rewritten.

## Blockers

None.

## Should fix

1. The test's policy read is pinned to `process.cwd()` rather than to the loader's own resolution. `tests/mastra/processors/write-claim-guard.test.ts:16` versus `src/governance/policy.ts:97-100`. Concrete failure: a run whose working directory contains another `policy/` pair, such as `.qoder/worktrees/field-audit-phase2/policy/`, silently derives `DECLARED_MUTATING` from that copy and reports green, and the day `POLICY_DIR` (documented at `.env.example:90`) becomes load-bearing in the mastra lane the assertion describes a file the process never reads. Closing it is one line, either export `defaultPolicyDir()` from `src/governance/policy.ts` and call `loadPolicy(defaultPolicyDir())`, or assert against the same `Policy` object the runtime consults. Not a blocker because both policy copies in the tree are byte-identical today and no runtime path reads `POLICY_DIR`.
2. Worth the controller's explicit sign-off rather than a code change here: the list itself is still hand-written, and only the test derives. `src/mastra/processors/write-claim-guard.ts:8-32` computes nothing. Concrete failure: the next task that adds a registered mutating tool ships the false positive in the window between that commit and the commit that adds its id, and `src/evals/custom-scorers.ts:55` inherits the same stale window. The CI-enforced shape is what the brief and Addendum B5 asked for, so I record it as accepted design, not as a defect in this commit.

## Nits

1. `tests/mastra/processors/write-claim-guard.test.ts:143` and the comment at `src/mastra/processors/write-claim-guard.ts:18-20` both call this "a true report of a send". `crm.send_outreach` does not send. It returns `Send staged for approval (${draft.id})` at `src/mastra/tools/prospect-writes.ts:426`, and the message leaves only when a human approves the staged row. The same is already true of a pre-existing guard member, `mail.send`, which returns `Email send staged (draft ${draft.id}).` at `src/mastra/tools/approval-writes.ts:187`. So the guard's real promise is "some write happened", not "the thing claimed happened", and that looseness predates this commit. Concrete effect: a turn that stages a send and then says "I've sent it" now passes silently where it used to be retried. Fix the wording, or add one clause to the comment saying a staged write satisfies the guard.
2. `DECLARED_BUT_NOT_CALLABLE` at `tests/mastra/processors/write-claim-guard.test.ts:27` is a hand-written pair of names, and mutant D proved case 3 fails when the policy reclassifies one of them. That is the desired behaviour, and the doc comment at `:20-26` explains it well. Flagging only so nobody later "fixes" the coupling by deriving the backlog list, which would make case 3 vacuous.
3. The report's deviation note, that the `export` went in before the RED run, is honest and correct. Without it the file dies at import and B4's two-part RED is unobservable. Nothing to change.

## Verified, and could not fault

- The derivation is load-bearing in all four directions I could think to break it, with the case-by-case kills recorded above, and no surviving mutant.
- Every measured figure in Addendum B2 and in the report reproduces exactly under my own run of the loader: 44 policy tools, 22 non-read-only as 7 auto plus 14 approval plus 1 refuse, 42 registry keys, intersection 20, guard list 16 to 20, declared-and-unregistered exactly `run.side-effect` and `crm.bulk_import`.
- The report's own liveness output, the phantom-id run showing `expected [ 'crm.list_customers', …(41) ] to include 'crm.tool_that_does_not_exist'`, reproduces character for character.
- `toHaveLength(16)` is gone, and the surviving `toHaveLength(1)` defence is true and verifiable in `src/mastra/processors/write-claim-guard.ts:104-115`.
- The two backlog ids are unreachable for two independent and separately tested reasons each, and the guard test does not duplicate the yaml parser, so the `connectors:` trap at `policy/tools.yaml:302` cannot bite it.
- The behavioural case is the real processor, the real provider name shape, and the real installed pipeline.
- Commit shape, branch, parent, clean tree on the four owned paths, and none of the concurrent effort's files in the diff.
- Gate 1 reproduces the report's 17 files and 315 passed plus 1 todo exactly, typecheck and lint are silent, and the prospect lane is green.

## Could not check

- Anything under `tests/evals`, which the standing constraints forbid running. The golden gate's write-claim expectations are the one place the four new ids could plausibly flip a recorded number, and my grep of `src/evals/golden-items.ts` found no outreach item, so my confidence there is static-analysis only.
- The `git show` diff is the whole commit, so any earlier uncommitted work by the implementer is invisible to me, and I did not audit the working tree's other efforts, which is out of scope by instruction.
- Live runtime behaviour with a real model, so I cannot say how often the false positive actually fired in production traffic, only that the code path admits it.

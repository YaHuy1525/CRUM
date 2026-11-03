### Task 18: The guard list is derived, and finds four missing tools

**Files**

- Modify `src/mastra/processors/write-claim-guard.ts` (`MUTATING_TOOL_IDS`, `:8-25`)
- Modify `src/mastra/agent.ts` (one word: `export const crumToolRegistry`)
- Test `tests/mastra/processors/write-claim-guard.test.ts` (`:36-59` replaced)

**Why derivation is the fix.** `tests/mastra/processors/write-claim-guard.test.ts:58` asserts `toHaveLength(16)` against a hand-written array. Nothing derives 16, and nothing connects the array to the two things it has to agree with, which is the exact drift that produced R6: a tool in the guard list and in the policy and in the object-type CHECK, absent from the registry and unreachable from `applyDraft`. Deriving it also finds a live bug in four lanes. `ranMutatingTool` (`src/mastra/processors/write-claim-guard.ts:80`) answers true only for ids on the list, and `crm.draft_outreach`, `crm.send_outreach`, `crm.save_prospect_snapshot` and `crm.resolve_merge_candidate` all mutate, all sit in the registry (`src/mastra/agent.ts:80-84`), and are all missing. A turn that really sent an outreach and then says "I've sent it" therefore looks, to this processor, exactly like a turn that hallucinated the send, and the guard retries and then rewrites an answer that was true.

- [ ] **Step 1: Replace the literal with the three derived assertions**

In `tests/mastra/processors/write-claim-guard.test.ts`, delete the `MUTATING_TOOL_IDS lists every write tool by registry id` case at `:36-59` (the sixteen `toContain` calls and the `toHaveLength(16)`) and add at the top:

```ts
import { crumToolRegistry } from '../../../src/mastra/agent'
import { loadPolicy } from '../../../src/governance/policy'

// The policy is read through the same loader the runtime uses, so this file and
// src/mastra/processors/write-claim-guard.ts ask one source one question rather
// than maintaining a second parser that can disagree with the first.
const REGISTERED = Object.keys(crumToolRegistry)
const DECLARED_MUTATING = loadPolicy()
  .tools.tools.filter((tool) => tool.class !== 'read-only')
  .map((tool) => tool.name)

/**
 * Declared mutating, not callable. run.side-effect is a workflow label whose scope
 * is resolved at run time, and crm.bulk_import is declared in the policy and
 * implemented nowhere. Both belong in a test as a named backlog: a gap that is
 * written down stays a known hole, and a gap that disappears behind a filter nobody
 * checks becomes a blind spot.
 */
const DECLARED_BUT_NOT_CALLABLE = ['crm.bulk_import', 'run.side-effect']
```

and three cases:

```ts
  it('guards exactly the mutating tools the agent can actually call', () => {
    expect(MUTATING_TOOL_IDS.slice().sort()).toEqual(
      DECLARED_MUTATING.filter((name) => REGISTERED.includes(name)).sort(),
    )
  })

  it('guards nothing the registry does not hold', () => {
    // The assertion that would have caught R6 on its own. A guarded id that is not
    // a tool is not a bug in the guard, it is a bug in the lane it names, and this
    // makes that unmissable.
    for (const id of MUTATING_TOOL_IDS) {
      expect(REGISTERED).toContain(id)
    }
  })

  it('names every declared mutating tool the registry is missing', () => {
    expect(DECLARED_MUTATING.filter((name) => !REGISTERED.includes(name)).sort()).toEqual(
      DECLARED_BUT_NOT_CALLABLE.slice().sort(),
    )
  })
```

The intersection in the first case is what the spec's hand-written exception list would otherwise have had to do, and it is 20 names: 22 declared mutating (7 auto, 14 approval, 1 refuse) minus the two backlog ids.

- [ ] **Step 2: Run it RED**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/processors/write-claim-guard.test.ts
```

Expect the first case to fail naming the four `crm.*outreach*`, `crm.save_prospect_snapshot`, `crm.resolve_merge_candidate` ids as missing, and the third case to pass, because Task 17 already put `marketing.set_campaign_status` in the registry. If the third case fails instead, the registry edit did not land, and Task 17 is not done.

- [ ] **Step 3: Add the four ids**

`src/mastra/processors/write-claim-guard.ts`, after `'crm.transfer_owner'` (`:17`) and before `'mail.send'`, keeping the file's rough order-by-lane shape:

```ts
  // Prospect-lane writes. Each one mutates, each is callable today, and none was
  // here: a turn that genuinely sent an outreach and reported the send read, to
  // this processor, exactly like a turn that invented it.
  'crm.draft_outreach',
  'crm.send_outreach',
  'crm.save_prospect_snapshot',
  'crm.resolve_merge_candidate',
```

`MUTATING_TOOLS` (`:27`) is derived from the array, so it needs no edit. `src/mastra/agent.ts:48` becomes `export const crumToolRegistry = {`. It is a module-local const today, and exporting the object the module already builds does not widen what the process publishes.

- [ ] **Step 4: One behavioural case for the outreach lane**

The file already drives the processor directly with a hand-built args object (`:106-124`). Add the case that says why the four ids matter:

```ts
  it('leaves a true report of a send alone now that crm.send_outreach is guarded', () => {
    const calls: string[] = []
    const args = {
      text: "I've sent the outreach to Nordwind.",
      toolCalls: [{ toolName: providerToolName('crm.send_outreach') }],
      steps: [],
      retryCount: 0,
      messages: [],
      abort: (reason: string) => calls.push(reason),
    } as never
    new WriteClaimGuardProcessor().processOutputStep(args)
    expect(calls).toEqual([])
  })
```

Before Step 3 this aborts with `write-claim-without-tool` over a send that happened, which is the false-positive class the file's own comment says killed the earlier version of the guard.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/processors/write-claim-guard.test.ts tests/mastra/agent.test.ts tests/mastra/processors tests/governance
npm run typecheck
npm run lint
```

Expected: green. `toHaveLength(16)` is gone and nothing in the file states a count, so the list can only agree with the policy and the registry or fail.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/processors/write-claim-guard.ts src/mastra/agent.ts tests/mastra/processors/write-claim-guard.test.ts
git commit -m "fix(governance): the write-claim guard is derived from policy and registry"
```

---


## Addendum B1. Pre-flight, run against HEAD `667384e` by the controller

Every anchor was read off the current tree before this task was dispatched, and the numbers below were computed rather than assumed.

`src/mastra/processors/write-claim-guard.ts` is unchanged from the brief: `MUTATING_TOOL_IDS` spans `:8-25` with exactly 16 entries, `'crm.transfer_owner'` is at `:17`, `MUTATING_TOOLS` at `:27`, and `ranMutatingTool` at `:80` with its only call at `:95`. `tests/mastra/processors/write-claim-guard.test.ts` is unchanged too: the case to delete is `:36-59`, `toHaveLength(16)` is at `:58`, and that count assertion is the only one of its kind anywhere in the repository.

Two anchors have moved, and the quoted code is the requirement in both cases.

- **R-43.** `src/mastra/agent.ts:48` in the plan is `src/mastra/agent.ts:55` now, because Task 17's commit turned one import line into an eight-line import block. `const crumToolRegistry = {` is the line to export, and `:110` `tools: crumToolRegistry` is its only in-file consumer. The prospect-lane registry entries the prose cites at `:80-84` are at `:87-91`: `crm.draft_outreach` at `:87`, `crm.send_outreach` at `:88`, `crm.save_prospect_snapshot` at `:89`, `crm.resolve_merge_candidate` at `:91`.
- **R-44.** The brief's "hand-built args object (`:106-124`)" is now two of them, at about `:99-113` and `:115-127`. The one to copy the shape from is the case ending `expect(calls[0]?.opts).toEqual({ retry: true, metadata: { reason: 'write-claim-without-tool' } })`. Pin by that quoted line, not by a number.

## Addendum B2. The derivation was run before you, and these are the numbers

Measured at HEAD, from `policy/tools.yaml` through the same loader the runtime uses:

| Set | Count |
| --- | --- |
| `tools:` entries whose `class` is not `read-only` | 22, which is 7 auto, 14 approval, 1 refuse |
| `Object.keys(crumToolRegistry)` | 42 |
| declared mutating and not registered | `crm.bulk_import`, `run.side-effect`, exactly two |
| declared mutating and registered | 20 |
| ids currently in `MUTATING_TOOL_IDS` | 16, and every one of them is declared mutating |
| registered and declared mutating but not guarded | `crm.draft_outreach`, `crm.send_outreach`, `crm.save_prospect_snapshot`, `crm.resolve_merge_candidate` |

So Step 2's prediction is reproducible today, and after Step 3 the first case compares 20 against 20.

One trap, because the controller walked into it while measuring. `policy/tools.yaml` carries a second list, `connectors:` at `:302`, whose three entries (smtp, calendar, slack) each hold `class: approval` and no `name:` at all. A naive scan of the file over the whole document counts 25 non-read-only classes and attributes the three extras to whatever tool name was last seen. `loadPolicy().tools.tools` reads only the tools list, which is why Step 1 uses it, and it is also why you must not add a second parser of that yaml. Ask one source one question.

## Addendum B3. Importing the registry into this test is safe, and that is the only agent.ts edit

`tests/mastra/agent.test.ts:3` already imports `src/mastra/agent` inside the unit project with no setup file, `src/mastra/models.ts` resolves its ids through `??` defaults so it cannot throw at import time, and `vitest.config.ts` gives every file its own module registry, so `Object.keys(crumToolRegistry)` in the guard test costs no env and no mock. `agent.ts` imports `./processors`, and `./processors` imports `write-claim-guard`, which means the guard module is loaded through two doors in one process. That is not a cycle: the test file is not reachable from either. Changing `const` to `export const` publishes the object the module already builds and already hands to the Agent at `:110`, and it widens nothing about what the process exposes at runtime.

## Addendum B4. Order of work, with both REDs captured before the source moves

The brief's Step 4 says that before Step 3 the new behavioural case aborts with `write-claim-without-tool` over a send that really happened. Capture that, and the cheap way is to sequence it rather than to revert anything:

1. Step 1, the three derived cases, plus Step 4's behavioural case in the same edit pass.
2. Run `npx vitest run tests/mastra/processors/write-claim-guard.test.ts` and keep the output. Expect the first derived case to fail naming the four prospect ids, the second and third to pass, and Step 4's case to fail with that abort. That is one RED covering both halves of the change, and it is the evidence the review will ask for.
3. Step 3, the four ids and the one-word export.
4. Re-run the same file, expect green, then the full gate set below.

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/processors/write-claim-guard.test.ts tests/mastra/agent.test.ts tests/mastra/processors tests/governance tests/mastra/active-tools.test.ts
npm run typecheck
npm run lint
```

## Addendum B5. Files that are not yours, because the tree has three efforts in it

Do not touch, stage, or "helpfully" fix any of these: `src/marketing/meta-ads-config.ts`, `scripts/publish-drain.ts`, `scripts/analyst-cron.ts`, `src/mastra/tools/marketing-writes.ts`, `src/marketing/payload.ts`, `src/mastra/instructions.ts`, `tests/marketing/publish-drain.test.ts`, `tests/marketing/meta-ads-config.test.ts`, `tests/mastra/marketing-campaign-status-tool.test.ts`, `tests/integration/marketing-campaign-status.test.ts`, and `src/mastra/agent.ts` beyond the single `export` word at `:55`. Everything owned by the concurrent document effort is likewise out of bounds, and `git status --short` will show it as modified or untracked: `console/`, `services/ocr/`, `src/api/`, `src/queue/`, `src/temporal/`, `src/transforms/`, `src/mastra/docling.ts`, `src/mastra/identity.ts`, `src/mastra/workflows/ingest.ts`, `package.json`, `package-lock.json`, `docker-compose.yml`, `.env.compose.example`, `tests/mastra/identity.test.ts`, `tests/mastra/prospect-tools.test.ts` and the loose status markdown files at the repo root.

If your derived assertion turns up a name you did not expect, report it as a finding rather than editing the policy, the registry, or the guard to make the test pass. The point of this task is that the list can only agree with its two sources or fail, and a worker who "fixes" a surprise by moving a source has destroyed the signal.

Commit shape, three named paths, never `-A` or `.` or `-a`, never amend:

```bash
cd D:/Code/CRUM
git add src/mastra/processors/write-claim-guard.ts src/mastra/agent.ts tests/mastra/processors/write-claim-guard.test.ts
git commit -m "fix(governance): the write-claim guard is derived from policy and registry"
```

The rest of `dispatch-common.md` binds you in full: no `npm run test`, no `npm run verify`, no bare `npx vitest run`, nothing under `tests/evals`, no model or provider calls, no touching the Postgres cluster on 5455, no subagents, and no reviewer. Write your report to `.superpowers/sdd/2026-11-02-marketing-team-slice-5/task-18-report.md` and do not commit it.

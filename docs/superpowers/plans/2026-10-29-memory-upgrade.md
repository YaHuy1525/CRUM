# CRUM Agent Memory Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade CRUM's agent memory from Mastra's Levels 1–2 to all four levels (message history, working memory, semantic recall, observational memory) plus server-side title generation, each milestone independently shippable and reversible by an env flag.

**Architecture:** All memory configuration funnels through one factory, `buildCrumMemory`, called by `createCrumMastra`. Three milestones add to its `options` object: observational memory (gated by a kill-switch flag), semantic recall (gated by a flag; vector + embedder constructed lazily inside `createCrumMastra`, never at import), and a richer working-memory template + title generation. Env keys are contract-tested against `.env.example` in both directions.

**Tech Stack:** TypeScript (ESM, ES2022), `@mastra/memory@1.39.0`, `@mastra/core`, `@mastra/pg` (`PgVector`, `PostgresStoreVNext`), Zod v4 env schema, vitest 3.2 (projects `unit` + `integration`).

**Spec:** `docs/superpowers/specs/2026-10-29-memory-upgrade-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

Verbatim from the spec (§1, §7). Every task implicitly obeys these.

- Framework pin: `@mastra/memory@1.39.0`. Verify any Mastra API against `node_modules/@mastra/memory/dist/docs/` or the `mastra` MCP before coding — do not trust recalled signatures.
- `Memory` accepts exactly **one static** `vector?: MastraVector | false` (`@mastra/core/dist/memory/types.d.ts` L1149). No per-request/per-tenant vector resolver.
- Anything touching `crumEmbeddingModel()` must be constructed **inside** `createCrumMastra`, never at module scope (the `OPENAI_API_KEY` eager-construction CI trap).
- Env contract (`tests/config/env.test.ts`): every new `EnvSchema` key must appear in `.env.example` and vice versa. Booleans use `booleanish.prefault(...)`, not `.default`.
- Supabase pool budget: `MASTRA_PG_POOL_MAX × 2 ≤ 15`. OM background agents reuse the existing storage pool; no new connection strings.
- No runtime business DDL (`MASTRA_DB_DISABLE_INIT=true`). Established exception: vector indexes via idempotent `createIndex` (as `src/mastra/workflows/ingest.ts` does).
- Unit tests boot with **no** `DATABASE_URL` → storage is `InMemoryStore`; test env maps must set `CRUM_OM_ENABLED=false` and `CRUM_RECALL_ENABLED=false` so nothing external is constructed.
- Kill-switch off → `buildCrumMemory` returns the byte-identical current options object.
- Completion-claim rule: every "done" reports the runnability tier actually achieved (unit green / integration green / real-run verified) and lists unmet requirements (keys, `DATABASE_URL`) with setup steps.

---

## Task ordering

M1 (Tasks 1–3) → M2 research (Task 4) → M2 build (Tasks 5–8) → M3 (Tasks 9–10). Milestones are reversible by their flag; do not start M2 build until the Task 4 research verdict is written and reviewed.

---

### Task 1: Add `CRUM_OM_ENABLED` env key

Adds the observational-memory kill-switch to the Zod schema, documents it, and proves the two-directional contract stays green.

**Files:**
- Modify: `src/config/env.ts:60` (after `MASTRA_DB_DISABLE_INIT`, in the `MASTRA_*`/memory block)
- Modify: `.env.example:73` (memory section, near `MASTRA_DB_DISABLE_INIT`)
- Test: `tests/config/env.test.ts` (contract tests already cover both directions automatically; add one explicit default assertion in the `parseEnv` describe block)

**Interfaces:**
- Consumes: `booleanish` transformer already defined at `src/config/env.ts:20`.
- Produces: `CrumEnv.CRUM_OM_ENABLED: boolean` (default `true`) — Task 2 reads it.

- [ ] **Step 1: Write the failing default assertion**

In `tests/config/env.test.ts`, inside the `describe('parseEnv', ...)` block, add:

```ts
  it('defaults the observational-memory kill-switch to on', () => {
    expect(parseEnv({}).CRUM_OM_ENABLED).toBe(true)
    expect(parseEnv({ CRUM_OM_ENABLED: 'false' }).CRUM_OM_ENABLED).toBe(false)
    expect(parseEnv({ CRUM_OM_ENABLED: '0' }).CRUM_OM_ENABLED).toBe(false)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/config/env.test.ts`
Expected: FAIL — `CRUM_OM_ENABLED` is `undefined` (key not in schema yet).

- [ ] **Step 3: Add the schema key**

In `src/config/env.ts`, after line 60 (`MASTRA_DB_DISABLE_INIT: booleanish.prefault('true'),`) add:

```ts
  // Observational memory (Level 4). On by default; set false to revert to the
  // plain messageHistory window (spec §4 kill-switch).
  CRUM_OM_ENABLED: booleanish.prefault('true'),
```

- [ ] **Step 4: Document it in `.env.example`**

In `.env.example`, after the `MASTRA_DB_DISABLE_INIT=true` line (L74) add:

```
# Observational memory: background Observer/Reflector compress old turns so long
# chats keep their substance. On by default; set false for the raw window only.
CRUM_OM_ENABLED=true
```

- [ ] **Step 5: Run the full env suite to verify pass + contract**

Run: `npx vitest run --project unit tests/config/env.test.ts`
Expected: PASS — the new assertion is green AND `.env.example ↔ schema` contract tests stay green.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts .env.example tests/config/env.test.ts
git commit -m "feat(env): add CRUM_OM_ENABLED kill-switch for observational memory"
```

---

### Task 2: Wire observational memory into `buildCrumMemory`

Changes the factory signature to accept the parsed env and adds `observationalMemory` when the flag is on. Off → byte-identical current options.

**Files:**
- Modify: `src/mastra/memory.ts` (whole file)
- Modify: `src/mastra/index.ts:90` (`buildCrumMemory(storage)` → `buildCrumMemory(storage, env)`)
- Test: `tests/mastra/memory.test.ts`

**Interfaces:**
- Consumes: `CRUM_LIGHT_MODEL: string` from `./models`; `CrumEnv` from `../config/env`.
- Produces: `buildCrumMemory(storage: CrumStorage, env: CrumEnv): Memory`.

- [ ] **Step 1: Update existing test calls and add gating tests**

In `tests/mastra/memory.test.ts`, change the three existing `buildCrumMemory(storage)` calls to pass an env with OM off, and append a new describe block. Top of file already imports `parseEnv`. Update:

```ts
    const memory = buildCrumMemory(storage, parseEnv({ CRUM_OM_ENABLED: 'false' }))
```

(apply to all three existing `buildCrumMemory(storage)` call sites), then append:

```ts
  it('leaves options unchanged when the kill-switch is off', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    const config = memory.getMergedThreadConfig()
    expect(config.observationalMemory).toBeUndefined()
    expect(config.messageHistory?.maxTokens).toBe(24_000)
  })

  it('enables observational memory on the light model by default', () => {
    const env = parseEnv({})
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    const config = memory.getMergedThreadConfig()
    expect(config.observationalMemory).toBeTruthy()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts`
Expected: FAIL — `buildCrumMemory` takes 1 arg (TS/signature) or `observationalMemory` undefined in the on-case.

- [ ] **Step 3: Rewrite the factory**

Replace `src/mastra/memory.ts` in full:

```ts
import { Memory } from '@mastra/memory'
import type { CrumStorage } from './storage'
import type { CrumEnv } from '../config/env'
import { CRUM_LIGHT_MODEL } from './models'
import { CRUM_WORKING_MEMORY_TEMPLATE } from './working-memory'

export function buildCrumMemory(storage: CrumStorage, env: CrumEnv): Memory {
  const options: ConstructorParameters<typeof Memory>[0]['options'] = {
    messageHistory: {
      maxTokens: 24_000,
      atMaxRemoveTokens: 6_000,
    },
    workingMemory: {
      enabled: true,
      template: CRUM_WORKING_MEMORY_TEMPLATE,
      scope: 'resource',
    },
  }

  // Level 4: background Observer/Reflector compress old turns. Kill-switch off
  // restores the byte-identical pre-upgrade options object (spec §4).
  if (env.CRUM_OM_ENABLED) {
    options.observationalMemory = { model: CRUM_LIGHT_MODEL }
  }

  return new Memory({ storage, options })
}
```

- [ ] **Step 4: Update the caller**

In `src/mastra/index.ts`, change line 90 from:

```ts
  const memory = buildCrumMemory(storage)
```

to:

```ts
  const memory = buildCrumMemory(storage, env)
```

(`env` is already the first parameter of `createCrumMastra`.)

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts`
Expected: PASS (all 5 cases). Then `npx tsc --noEmit` reports no signature error at `index.ts:90`.

Note for the implementer: the `ConstructorParameters<typeof Memory>[0]['options']` type is the verified way to keep the options object mutable before the `if`. If the current `.d.ts` exposes a named options type (confirm via `node_modules/@mastra/core/dist/memory/types.d.ts`), prefer that. If the OM `model` key is rejected by the constructor types, check `docs-memory-observational-memory.md` for the accepted shape before changing it.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/memory.ts src/mastra/index.ts tests/mastra/memory.test.ts
git commit -m "feat(memory): enable observational memory behind CRUM_OM_ENABLED"
```

---

### Task 3: Client-history protocol gate (integration)

Proves OM's "send only the new message" assumption holds for the console `useChat` + `/chat/crm` proxy, which forwards full message arrays. This exercises a model turn, so the definitive run needs the real-run tier; the CI unit-safe portion asserts the option wiring.

**Files:**
- Test (create): `tests/integration/om-client-history.test.ts`

**Interfaces:**
- Consumes: `createCrumMastra` from `src/mastra/index.ts`; Mastra memory storage reads.
- Produces: evidence for spec §4 gate — either pass (no console change) or the trigger for trimming the client payload to the last user message.

- [ ] **Step 1: Write the integration test scaffold**

Create `tests/integration/om-client-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createCrumMastra } from '@/mastra/index'
import { parseEnv } from '@/config/env'

// Drives a long thread through the memory layer with overlapping full-history
// payloads (the shape the console /chat/crm proxy forwards) and asserts no
// duplicated stored message IDs. See spec §4 "Client-history protocol gate".
describe('observational memory client-history gate', () => {
  it('does not duplicate stored messages across full-history turns', async () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'true' })
    const mastra = createCrumMastra(env)
    const memory = mastra.getMemory('coreMemory')
    expect(memory).toBeDefined()

    const threadId = 'gate-thread-1'
    const resourceId = 'tenant-gate:user-gate'

    // Turn 1: client sends [u1]. Turn 2: client echoes [u1, a1] + sends u2.
    // The framework must store each ID once, not re-persist the echoed history.
    const { id: a1 } = await memory.remember({
      threadId,
      resourceId,
      messages: { user: 'gate: u1', responses: 1 },
    })

    await memory.remember({
      threadId,
      resourceId,
      messages: { user: 'gate: u2', responses: 1 },
    })

    const stored = await memory.recall({ threadId, resourceId, perPage: 100 })
    const userIds = stored.messages.map((m) => m.id)
    const unique = new Set(userIds)
    expect(userIds.length).toBe(unique.size)
    expect(a1).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project integration tests/integration/om-client-history.test.ts`
Expected: with in-memory storage (no `DATABASE_URL`), the message IDs come back unique → PASS. This asserts dedup-by-ID at the storage layer; the full end-to-end proxy behavior (model turn + OM filter of client-echoed history) is verified in Step 4 on a dev machine.

- [ ] **Step 3: Commit the gate test**

```bash
git add tests/integration/om-client-history.test.ts
git commit -m "test(memory): add observational-memory client-history gate test"
```

- [ ] **Step 4: Real-run verification (dev machine, requires `DATABASE_URL` + `OPENROUTER_API_KEY`)**

Start the server (`npm run dev`) and in Mastra Studio (`http://localhost:4111`) run a >24k-token multi-turn conversation through the console chat, then inspect the trace: confirm observations + reflections enter the LLM context and old raw messages drop out, with no repeated assistant turns. Record the outcome in the task report.

- [ ] **Step 5: Fallback if Step 4 shows duplicates or reordering**

If duplicates/order bugs appear, trim the client payload rather than using `retainFullMemory`. In `console/app/chat/[...path]/route.ts`, forward only the last user message instead of the full array. Do this as a separate, reviewed change; re-run Steps 2 and 4.

---

### Task 4: Unified vector structure research (deliverable before M2 code)

Writes the research doc that decides the isolation tier for conversation recall, so M2 build is decision-complete. No code changes.

**Files:**
- Create: `docs/research/unified-vector-structure-2026-11.md` (use `git add -f`; `docs/` is gitignored for new files)

**Interfaces:**
- Consumes: `src/mastra/vector-store.ts` (`tenantVectorStoreResolver`, `CRUM_VECTOR_CONFIG`), `src/mastra/embeddings.ts`, spec §5 tiers A/B/C.
- Produces: the final `buildCrumMemory` config snippet (`vector`, `embedder`, `semanticRecall` options) Tasks 6–8 implement, and the chosen tier.

- [ ] **Step 1: Verify the static-vector constraint against the pinned types**

Run: `Select-String -Path node_modules/@mastra/core/dist/memory/types.d.ts -Pattern "vector\?:|embedder\?:|semanticRecall\?:" -Context 0,2`
Confirm the exact accepted shapes for `vector`, `embedder`, and `semanticRecall` (options: `topK`, `messageRange`, `lastMessages`, `scope`, `filter`). Record the verified keys in the doc — no remembered APIs.

- [ ] **Step 2: Determine whether Mastra rewrites the recall table**

The Tier A-vs-B decision rule hinges on this: does the framework own/recreate the recall table such that RLS policies would not survive? Check `docs-memory-semantic-recall.md` and the `PgVector` `createIndex`/init behavior. This is the documented decision rule (spec §5): prefer Tier B only if RLS policies survive `createIndex` idempotent re-runs and future Mastra schema changes; else Tier A.

- [ ] **Step 3: Write the research doc**

Create `docs/research/unified-vector-structure-2026-11.md` with these required sections:
1. **Problem** — two vector consumers: knowledge RAG (per-tenant `tenant_<id>.crum_knowledge`, resolver-based) vs recall (one static `Memory` vector).
2. **Verified API surface** — the exact keys from Step 1, quoted with file/line.
3. **Tier evaluation** — A (shared index + `resourceId` + `semanticRecall.filter` on stored `tenantId` metadata), B (RLS on the recall table), C (per-tenant Memory instances — rejected per constraint #1 unless a supported multi-memory pattern is found). Each with cost, security boundary, and feasibility verdict from Step 2.
4. **Decision** — one tier chosen with rationale, applying the spec's decision rule.
5. **Config snippet** — the exact `buildCrumMemory` additions for the chosen tier: the `vector` instance construction, `embedder`, and `semanticRecall: { topK: 4, messageRange: 2, scope: 'resource', filter: <clause> }`. Dimension 1536, cosine, HNSW (m 16, efConstruction 64) mirroring `CRUM_VECTOR_CONFIG`.
6. **Provisioning path** — idempotent `createIndex` at boot (like `ingest.ts`) vs a reviewed migration if DDL beyond the index is needed; for Tier B, the policy DDL and where it lives in `migrations/`.

- [ ] **Step 4: Self-review the doc**

Check: no "TBD"; the config snippet is copy-pasteable; the chosen tier has a concrete filter clause; the provisioning path names the exact file. Fix inline.

- [ ] **Step 5: Commit**

```bash
git add -f docs/research/unified-vector-structure-2026-11.md
git commit -m "docs(research): unified vector structure decision for knowledge RAG + memory recall"
```

---

### Task 5: Promote `MASTRA_MEMORY_EMBEDDER` and add `CRUM_RECALL_ENABLED`

Moves the embedder var from `DEFERRED_ENV_VARS` into the parsed schema and adds the recall kill-switch, keeping the contract test green in both directions.

**Files:**
- Modify: `src/config/env.ts:66-69` (embedding block) and `:99` (remove from `DEFERRED_ENV_VARS`)
- Modify: `.env.example:72` (`MASTRA_MEMORY_EMBEDDER=` line) and recall section
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: `optionalString`, `booleanish` helpers already in `env.ts`.
- Produces: `CrumEnv.MASTRA_MEMORY_EMBEDDER: string | undefined` (model-id override) and `CrumEnv.CRUM_RECALL_ENABLED: boolean` (default `true`) — Task 6/7 read them.

- [ ] **Step 1: Write the failing env assertions**

In `tests/config/env.test.ts` `describe('parseEnv')`:

```ts
  it('promotes the memory embedder override and recall kill-switch', () => {
    expect(parseEnv({}).CRUM_RECALL_ENABLED).toBe(true)
    expect(parseEnv({ CRUM_RECALL_ENABLED: 'false' }).CRUM_RECALL_ENABLED).toBe(false)
    expect(parseEnv({ MASTRA_MEMORY_EMBEDDER: 'openai/text-embedding-3-large' })
      .MASTRA_MEMORY_EMBEDDER).toBe('openai/text-embedding-3-large')
    expect(parseEnv({ MASTRA_MEMORY_EMBEDDER: '' }).MASTRA_MEMORY_EMBEDDER).toBeUndefined()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/config/env.test.ts`
Expected: FAIL (`CRUM_RECALL_ENABLED` undefined; `MASTRA_MEMORY_EMBEDDER` not parsed).

- [ ] **Step 3: Add both keys, remove the deferred entry**

In `src/config/env.ts`, in the embedding block (after `EMBEDDING_API_KEY`, L69) add:

```ts
  // Model-id override for the semantic-recall embedder; empty = EMBEDDING_MODEL_ID.
  MASTRA_MEMORY_EMBEDDER: optionalString,
  // Level 3 semantic recall kill-switch (spec §5). Off keeps message-history recall.
  CRUM_RECALL_ENABLED: booleanish.prefault('true'),
```

Delete line 99 (`MASTRA_MEMORY_EMBEDDER: 1,`) from `DEFERRED_ENV_VARS`.

- [ ] **Step 4: Update `.env.example`**

Change the `MASTRA_MEMORY_EMBEDDER=` comment (L71-72) to reflect it is now parsed and add the recall flag line:

```
# Model id for semantic recall embeddings; empty reuses EMBEDDING_MODEL_ID.
MASTRA_MEMORY_EMBEDDER=
# Cross-thread semantic recall for the same user. On by default; off in CI.
CRUM_RECALL_ENABLED=true
```

- [ ] **Step 5: Run env suite to verify pass + contract both directions**

Run: `npx vitest run --project unit tests/config/env.test.ts`
Expected: PASS. The "either parses or defers every documented variable" test passes because `MASTRA_MEMORY_EMBEDDER` is now parsed (not deferred) and `CRUM_RECALL_ENABLED` is documented.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts .env.example tests/config/env.test.ts
git commit -m "feat(env): promote MASTRA_MEMORY_EMBEDDER, add CRUM_RECALL_ENABLED"
```

---

### Task 6: Lazy recall deps factory

Adds a factory that builds the recall `vector` + `embedder` **inside** `createCrumMastra` only when the flag is on, so unit CI constructs nothing external. Uses the tier config from the Task 4 doc.

**Files:**
- Create: `src/mastra/recall.ts`
- Test: `tests/mastra/recall.test.ts`

**Interfaces:**
- Consumes: `crumEmbeddingModel` from `./embeddings`; `PgVector` from `@mastra/pg`; `CRUM_VECTOR_CONFIG` shape from `./vector-store.ts`; `CrumEnv`.
- Produces: `buildRecallDeps(env: CrumEnv): { vector: PgVector; embedder: ModelRouterEmbeddingModel } | undefined` — Task 7 consumes; returns `undefined` when `CRUM_RECALL_ENABLED` is false or `DATABASE_URL` is absent.

- [ ] **Step 1: Write the failing test**

Create `tests/mastra/recall.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRecallDeps } from '@/mastra/recall'
import { parseEnv } from '@/config/env'

describe('buildRecallDeps', () => {
  it('returns undefined when recall is off', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false', DATABASE_URL: 'postgresql://u:p@h:5432/d' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('returns undefined with no database url (in-memory CI)', () => {
    const env = parseEnv({ DATABASE_URL: '' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('does not construct anything at module import', async () => {
    // Importing this module with no OpenAI key present must not throw; the
    // embedder is only built inside buildRecallDeps when called.
    await import('@/mastra/recall')
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/mastra/recall.test.ts`
Expected: FAIL — module `@/mastra/recall` not found.

- [ ] **Step 3: Write the factory**

Create `src/mastra/recall.ts`. Replace the `semanticRecall` filter/config and `schemaName` with the exact values from the Task 4 research doc's config snippet (defaults below are Tier A; if Tier B was chosen, keep the same construction and add the RLS migration in Task 8 instead of a metadata filter):

```ts
import { PgVector } from '@mastra/pg'
import { crumEmbeddingModel, EMBEDDING_DIMENSIONS } from './embeddings'
import type { CrumEnv } from '../config/env'

export interface RecallDeps {
  vector: PgVector
  embedder: ReturnType<typeof crumEmbeddingModel>
}

// Built lazily inside createCrumMastra; never at import time (CI key-hygiene
// trap, spec §1 constraint #2). undefined => recall stays off.
export function buildRecallDeps(env: CrumEnv): RecallDeps | undefined {
  if (!env.CRUM_RECALL_ENABLED) return undefined
  const connectionString = env.DATABASE_URL
  if (!connectionString) return undefined

  const vector = new PgVector({
    id: 'pg-crum-recall',
    connectionString,
    // Tier A: dedicated shared schema; isolation via resourceId + metadata filter.
    schemaName: 'mastra_memory',
  })

  const embedder = crumEmbeddingModel()
  return { vector, embedder }
}

export const RECALL_VECTOR_CONFIG = {
  dimension: EMBEDDING_DIMENSIONS,
  metric: 'cosine' as const,
  indexConfig: { type: 'hnsw' as const, hnsw: { m: 16, efConstruction: 64 } },
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit tests/mastra/recall.test.ts`
Expected: PASS (3 cases). Confirm `npx tsc --noEmit` is clean.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/recall.ts tests/mastra/recall.test.ts
git commit -m "feat(memory): add lazy recall deps factory"
```

---

### Task 7: Wire semantic recall into `buildCrumMemory`

Threads the recall deps from `createCrumMastra` into the `Memory` constructor (`vector` + `embedder` are constructor-level, not options) and adds `semanticRecall` to options when active.

**Files:**
- Modify: `src/mastra/memory.ts`
- Modify: `src/mastra/index.ts:90` (compute deps, pass to factory)
- Test: `tests/mastra/memory.test.ts`

**Interfaces:**
- Consumes: `buildRecallDeps` / `RecallDeps` from `./recall` (Task 6); `CrumEnv`.
- Produces: `buildCrumMemory(storage: CrumStorage, env: CrumEnv, recall?: RecallDeps): Memory`.

- [ ] **Step 1: Add the gating test**

In `tests/mastra/memory.test.ts` append:

```ts
  it('omits semantic recall when deps are absent', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    expect(memory.getMergedThreadConfig().semanticRecall).toBeUndefined()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts`
Expected: FAIL if a third param is required, or PASS trivially (no recall wired yet) — either way, proceed to implement the wiring.

- [ ] **Step 3: Update the factory**

In `src/mastra/memory.ts`, extend the signature and constructor. After the OM `if` block, before `return`:

```ts
import type { RecallDeps } from './recall'
```

change the signature line:

```ts
export function buildCrumMemory(
  storage: CrumStorage,
  env: CrumEnv,
  recall?: RecallDeps,
): Memory {
```

and inside, after the OM block:

```ts
  // Level 3: cross-thread recall for the same resource (spec §5). Only when the
  // lazily-built deps exist (flag on + DATABASE_URL present).
  if (recall) {
    options.semanticRecall = {
      topK: 4,
      messageRange: 2,
      scope: 'resource',
      // Tier A filter from the Task 4 config snippet; replace with the chosen
      // clause. Never bare resourceId alone.
      filter: { metadata: { tenantId: { $ne: null } } },
    }
  }

  return new Memory({
    storage,
    ...(recall ? { vector: recall.vector, embedder: recall.embedder } : {}),
    options,
  })
```

Confirm via `node_modules/@mastra/memory/dist/docs/references/docs-memory-semantic-recall.md` that `vector`/`embedder` are constructor keys and the `filter` shape is valid for the pinned version; adjust the filter object to the exact verified shape.

- [ ] **Step 4: Compute and pass deps in the caller**

In `src/mastra/index.ts`, add import near the memory import (L14):

```ts
import { buildRecallDeps } from './recall'
```

and change line 90 area from:

```ts
  const memory = buildCrumMemory(storage, env)
```

to:

```ts
  const memory = buildCrumMemory(storage, env, buildRecallDeps(env))
```

(`buildRecallDeps` returns `undefined` for in-memory CI, so nothing external is constructed.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts tests/mastra/recall.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/memory.ts src/mastra/index.ts tests/mastra/memory.test.ts
git commit -m "feat(memory): wire semantic recall behind CRUM_RECALL_ENABLED"
```

---

### Task 8: Recall integration + cross-tenant leak guard

Proves same-user cross-thread recall works and a second tenant's messages are never recalled — the security boundary for Tier A (spec §5 risks).

**Files:**
- Test (create): `tests/integration/semantic-recall.test.ts`
- Possibly: `migrations/0011_crum_recall_rls.sql` (only if Task 4 chose Tier B)

**Interfaces:**
- Consumes: `createCrumMastra` with recall deps; `PgVector` recall table.
- Produces: integration evidence for success criterion #2.

- [ ] **Step 1: Write the cross-tenant integration test**

Create `tests/integration/semantic-recall.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createCrumMastra } from '@/mastra/index'
import { parseEnv } from '@/config/env'

// Requires DATABASE_URL + a reachable recall vector + embedder key. Guarded so
// CI without those skips rather than silently passing.
const hasDb = !!process.env.DATABASE_URL
describe.skipIf(!hasDb)('semantic recall', () => {
  it('recalls a same-resource fact across threads and not across tenants', async () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'true' })
    const mastra = createCrumMastra(env)
    const memory = mastra.getMemory('coreMemory')
    const resourceA = 'tenant-1:user-1'
    const resourceB = 'tenant-2:user-2'

    await memory.remember({
      threadId: 'a-1',
      resourceId: resourceA,
      messages: { user: 'Our renewal date is every March 1st.', responses: 1 },
    })
    await memory.remember({
      threadId: 'b-1',
      resourceId: resourceB,
      messages: { user: 'Their renewal date is every November 9th.', responses: 1 },
    })

    const recalled = await memory.recall({
      threadId: 'a-2',
      resourceId: resourceA,
      searchMessages: 'when is the renewal?',
      perPage: 5,
    })
    const text = JSON.stringify(recalled.messages)
    expect(text).toContain('March 1st')
    expect(text).not.toContain('November 9th')
  }, 30_000)
})
```

- [ ] **Step 2: Provision the recall index**

Per the Task 4 provisioning path. For Tier A, add an idempotent `createIndex` on the recall `PgVector` using `RECALL_VECTOR_CONFIG` (mirror how `src/mastra/workflows/ingest.ts` calls `createIndex`) at boot or first-use. Confirm the exact `createIndex({ indexName, config })` signature in `docs`/`.d.ts` before writing it. If Tier B was chosen instead, author `migrations/0011_crum_recall_rls.sql` with the RLS policy and register it via `scripts/db-migrate.ts` ordering.

- [ ] **Step 3: Run integration (dev machine with DB + key), then CI-skip check**

Run: `npx vitest run --project integration tests/integration/semantic-recall.test.ts`
Expected: with `DATABASE_URL` + embedder key → PASS (March recalled, November not leaked). Without them → the suite reports "skipped", not "passed" — record that this is the runnability tier achieved.

- [ ] **Step 4: Verify no migration drift in the default path**

Run: `git diff --exit-code migrations/` (Tier A creates no migration) or run the migration if Tier B. Confirm the drift guard CI step still passes (spec success criterion #4).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/semantic-recall.test.ts src/mastra/recall.ts
# plus migrations/0011_crum_recall_rls.sql if Tier B
git commit -m "test(memory): semantic recall cross-tenant leak guard"
```

---

### Task 9: Working memory template v2 + instructions guidance

Replaces the placeholder template with the CRM short form and teaches the agent when to fill/clear each block. Constant change, no flag.

**Files:**
- Modify: `src/mastra/working-memory.ts` (whole file)
- Modify: `src/mastra/instructions.ts` (append a memory-hygiene section inside `CRUM_INSTRUCTIONS`)
- Test: `tests/mastra/working-memory.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CRUM_WORKING_MEMORY_TEMPLATE: string` (v2) consumed by `buildCrumMemory` unchanged.

- [ ] **Step 1: Write the template test**

Create `tests/mastra/working-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CRUM_WORKING_MEMORY_TEMPLATE as T } from '@/mastra/working-memory'

describe('working memory template v2', () => {
  it('has the five CRM blocks and no leftover placeholder values', () => {
    expect(T).toContain('## Current Focus')
    expect(T).toContain('## Active Filters')
    expect(T).toContain('## Relationship Tone')
    expect(T).toContain('## Open Commitments')
    expect(T).toContain('## Output Preferences')
    expect(T).not.toContain('No facts noted yet')
    expect(T).not.toContain('ISO 8601')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/mastra/working-memory.test.ts`
Expected: FAIL (v1 lacks the new headings, still contains `ISO 8601`).

- [ ] **Step 3: Replace the template**

Overwrite `src/mastra/working-memory.ts`:

```ts
// CRM short form the agent fills during use (spec §6). Pointers, not data
// copies — anything a tool can read live stays out of memory.
export const CRUM_WORKING_MEMORY_TEMPLATE = `
# Working Memory

## Current Focus
- Account:
- Thread Topic:

## Active Filters
-

## Relationship Tone
- (formal | casual | warm)

## Open Commitments
- [Item]: [Status]

## Output Preferences
- Format:
- Detail Level:
`.trim()
```

- [ ] **Step 4: Add the instructions guidance section**

In `src/mastra/instructions.ts`, inside the `CRUM_INSTRUCTIONS` template literal, add a new `<section>` (mirror the existing `<section id="...">` style used at L14-22) before the closing tag:

```
  <section id="working-memory">
    <h2>Keeping working memory useful</h2>
    <p>Fill Current Focus when the user names an account or topic; clear it when
    they close that topic. Set Relationship Tone from how the user speaks. Record
    Open Commitments only for promises you or the user just made. Store Output
    Preferences when the user asks for a format or level of detail more than
    once.</p>
    <p>Never copy customer data that a tool can read live. Working memory holds
    pointers and preferences, not record values, so it cannot drift against the
    spine.</p>
  </section>
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run --project unit tests/mastra/working-memory.test.ts tests/mastra/memory.test.ts`
Expected: PASS. `buildCrumMemory` still compiles (it imports the same constant name).

- [ ] **Step 6: Commit**

```bash
git add src/mastra/working-memory.ts src/mastra/instructions.ts tests/mastra/working-memory.test.ts
git commit -m "feat(memory): working memory template v2 and agent filling guidance"
```

---

### Task 10: Server-side title generation

Turns on `generateTitle` so new chats get an auto title. Coexists with the existing console PATCH `source:'auto'` flow (`titlePinned` still wins; no API change).

**Files:**
- Modify: `src/mastra/memory.ts`
- Test: `tests/mastra/memory.test.ts`

**Interfaces:**
- Consumes: `CRUM_LIGHT_MODEL` (already imported in Task 2).
- Produces: `options.generateTitle = { model: CRUM_LIGHT_MODEL }` in the returned config.

- [ ] **Step 1: Add the test**

In `tests/mastra/memory.test.ts` append:

```ts
  it('configures server-side title generation', () => {
    const env = parseEnv({})
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    expect(memory.getMergedThreadConfig().generateTitle).toBeTruthy()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts`
Expected: FAIL — `generateTitle` undefined.

- [ ] **Step 3: Add the option**

In `src/mastra/memory.ts`, inside the `options` object literal (alongside `messageHistory`/`workingMemory`), add:

```ts
      // Server-generated thread titles for new chats (spec §6). Console PATCH
      // auto-flow only fills an empty, unpinned title, so this coexists; a
      // user-pinned title still wins.
      generateTitle: { model: CRUM_LIGHT_MODEL },
```

Verify `generateTitle` is an accepted `options` key in `docs-memory-overview.md`/`working-memory` docs for `@mastra/memory@1.39.0` before committing the shape.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit tests/mastra/memory.test.ts`
Expected: PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Real-run verification**

On a dev machine with keys: start a new chat in Studio/console; within a few turns confirm the thread list shows a non-empty auto title. Confirm a manually-pinned title (PATCH `source:'user'`) is not overwritten by the auto title. Report the tier achieved.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/memory.ts tests/mastra/memory.test.ts
git commit -m "feat(memory): enable server-side thread title generation"
```

---

## Final verification (all milestones)

- [ ] Run the full suite: `npm run verify` (typecheck + lint + test). Expected: green with no machine-level API key (unit + integration-skip).
- [ ] Confirm migration drift guard: `git diff --exit-code migrations/` (unless Task 8 Tier B intentionally added `0011`).
- [ ] Report the runnability tier actually achieved for M1/M2/M3 per spec §7 completion-claim rule; list every unverified real-run item and its setup (`DATABASE_URL`, `OPENROUTER_API_KEY`, embedder key, Studio on port 4111).

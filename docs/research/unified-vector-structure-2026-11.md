# Unified vector structure — knowledge RAG vs. memory semantic recall

> Research deliverable that decides the isolation tier for conversation recall so
> Milestone 2 (semantic recall) is decision-complete. Every framework claim below
> is quoted from the **pinned** `.d.ts` / compiled source in `node_modules`, not
> from memory. Versions: `@mastra/core@1.79.0`, `@mastra/memory@1.39.0`,
> `@mastra/pg@1.32.0` (PgVector). Verification date: 2026-10-29.

## 1. Problem

CRUM has **two vector consumers** with opposite isolation models:

- **Knowledge RAG** (`src/mastra/vector-store.ts`): a *per-tenant* store.
  `tenantVectorStoreResolver` builds one `PgVector` per tenant, each pointed at
  its own schema `tenant_<tenantId>` and index `crum_knowledge`
  (`vector-store.ts:7-29`). The security boundary is a separate Postgres schema
  per tenant — physical isolation.
- **Memory semantic recall** (this doc): Mastra's `Memory` takes exactly **one
  static `vector`** on its constructor (`vector?: MastraVector | false`,
  `@mastra/core/dist/memory/types.d.ts:1149`). There is no per-request resolver
  and no per-tenant vector. All tenants' conversation embeddings would therefore
  live in a **single shared index**, and isolation must come from a query
  predicate instead of a separate schema.

The tension: knowledge RAG isolates physically (schema per tenant); recall can
only isolate logically (one index). The tier decision below picks the boundary
mechanism for recall and states the residual risk in plain terms.

## 2. Verified API surface

Quoted from `node_modules/@mastra/core/dist/memory/types.d.ts` unless noted.

**Memory constructor config** (what `buildCrumMemory`'s `new Memory({...})`
accepts):
- `vector?: MastraVector | false` — L1149. Static, single instance.
- `embedder?: EmbeddingModelId | MastraEmbeddingModel<string> | string` — L1168.

**`options.semanticRecall?: boolean | SemanticRecall`** — L905. `SemanticRecall`
(L260-347):
- `topK: number` — L270.
- `messageRange: number | { before: number; after: number }` — L282.
- `scope?: 'thread' | 'resource'` — L297, **default `'resource'`** (L291:
  "Search across all threads owned by the same resource/user").
- `indexConfig?: VectorIndexConfig` — L312. **Consumed** at index creation:
  `createEmbeddingIndex` reads `config.semanticRecall.indexConfig` and passes
  `type`/`hnsw`/`ivf` + `metric` into `vector.createIndex`
  (`@mastra/core/dist/agent-tuAMgHe3.js:21821-21832`). Without it, PgVector
  defaults the vector index to **ivfflat**
  (`@mastra/pg/dist/index.js:1401-1402`), so the HNSW shape must be supplied
  here (§5).
- `filter?: VectorFilter` — L326. MongoDB-style metadata operators (`$eq`,
  `$in`, `$and`, …). Two ways to supply it: **static** via
  `options.semanticRecall.filter` (same for every caller) or **per request** via
  the `memoryConfig` argument of the generate/recall call — the query path reads
  `config = getMergedThreadConfig(memoryConfig)` and takes
  `config.semanticRecall.filter` at query time
  (`@mastra/memory/dist/src-DxZ7N8nO.js:42643-42645`). Only the per-request
  variant can vary by caller (§4).
- `threshold?: number` — L336; `indexName?: string` — L346. **`indexName` is
  dead config on this version**: `createEmbeddingIndex` always derives the name
  itself via `getEmbeddingIndexName` (`agent-tuAMgHe3.js:21817-21819`), ignoring
  the option.
- Embedding index name for our shape: `memory_messages` — the bare
  `memory_messages` prefix *is* the default-dimension (1536) index; other
  dimensions append a `_<dim>` suffix (`agent-tuAMgHe3.js:21810-21815`).
  Name derivation is by **dimension**, not by embedder id.

**How recall actually filters** (compiled source
`@mastra/memory/dist/src-DxZ7N8nO.js`):
```
resourceScope  = scope !== 'thread'                          // L42640
scopeFilter    = resourceScope ? { resource_id: resourceId }  // L42644
               : { thread_id: threadId }
combinedFilter = userFilter ? { $and: [scopeFilter, userFilter] } // L42646
               : scopeFilter
```
The `resource_id`/`thread_id` scope predicate is added by the **framework at
query time**, from the `resource` the caller passes to the turn — runtime, not
build-time. `saveMessages` tags every stored embedding with metadata
`{ ...thread.metadata, message_id, thread_id, resource_id, role, content,
created_at }` (`src-DxZ7N8nO.js:43164-43169, 43201-43209`): the **thread's
`metadata` object is copied verbatim** into the embedding metadata. That is the
hinge that lets a tenant-level filter predicate exist per row (§4).

**PgVector filter semantics**: filter keys address top-level JSONB paths —
`{ tenantId: { $eq: v } }` compiles to `metadata->>'tenantId' = $n`
(`@mastra/pg/dist/index.js:183-192`); `$and` is implemented
(`@mastra/pg/dist/index.js:328-331, 447-456`, operator table +
`handleLogicalOperator`; the filter-syntax doc text ships embedded at
`:27607-27623`). Keys inside the framework's own scope predicate are
snake_case (`resource_id`), while thread-metadata keys keep whatever case CRUM
writes (`tenantId`) — the two coexist in one `metadata` column.

**Config merge semantics** for per-request `memoryConfig`:
`getMergedThreadConfig` uses `deepMerge(staticOptions, requestConfig)` where
plain objects merge key-by-key and **non-object values (including arrays) are
replaced** (`agent-tuAMgHe3.js:21837-21844, 29647-29656`). Rule that follows:
the static config must NOT set a `filter` — the request layer supplies the
whole filter object, so no half-merged `$and` can ever form.

**CRUM's resource id is tenant-qualified.** `resourceIdFor()` returns
`` `${tenantId}:${userId}` `` (`src/mastra/sessions.ts:87`), and session
resolution re-checks `resourceId.startsWith(`${tenantId}:`)` (L97). So a
`resource_id` equality match is simultaneously **user-scoped and
tenant-scoped**. Spec §5 nonetheless mandates a second, independent tenant
predicate ("metadata filter mandatory, never bare resourceId alone",
design spec L94/L98) — defense in depth against a resourceId-construction bug
collapsing two tenants into one key. §4 implements that mandate; the plan's
static `{ tenantId: { $ne: null } }` sketch is recorded as a defect in the SDD
ledger and is *not* what this doc chooses (an existence check does not
partition).

## 3. Tier evaluation

### Tier A — shared index + `scope: 'resource'` + mandatory tenant metadata filter

- **Mechanism**: one recall `PgVector`; isolation is
  `{ $and: [{ resource_id: <caller resourceId> }, { tenantId: { $eq: <caller
  tenant> } }] }` — the first half framework-injected at query time, the second
  half supplied per-request via `memoryConfig.semanticRecall.filter`, derived
  server-side from the verified identity (never client-supplied). The tenant
  half predicates on `tenantId` copied into every embedding from the thread's
  `metadata` (§2, `src-DxZ7N8nO.js:43201-43209`).
- **Cost**: lowest. No per-tenant provisioning; one lazily-created index; the
  only app work is stamping thread metadata at creation and injecting the
  per-request filter.
- **Security boundary**: two independent `WHERE` predicates over one shared
  table. Logically, not physically, isolated.
- **Feasibility**: **supported natively** — the merge point
  (`src-DxZ7N8nO.js:42643-42646`) reads the per-request filter, and thread
  metadata verbatim-spread is verified above. Verdict: **feasible**.

### Tier B — Row-Level Security on the recall table

- **Mechanism**: `CREATE POLICY … USING (…)` on the Mastra-created recall
  table; enforced by Postgres regardless of query.
- **Cost**: a reviewed migration plus a per-request `SET LOCAL` on the
  connection the vector query uses.
- **Why it fails the spec's condition**: `Memory` holds **one static
  `PgVector` bound to one connection pool / one role** (§1,
  `types.d.ts:1149`). The framework owns the pool outright — the constructor
  accepts only connectionString / Cloud-SQL-connector / host settings and
  builds `new pg.Pool(...)` itself (`@mastra/pg/dist/index.js:599-627`); a
  pre-built `Pool` injection exists for `PostgresStore` configs
  (`PoolInstanceConfig`, `shared/config.d.ts:100-118`) but **not** for
  `PgVector` (`PgVectorConfig`, `:137-139`). CRUM therefore never gets a
  handle to issue a per-request `SET LOCAL app.tenant_id`, and a *pool-wide*
  setting value would apply one tenant to every request sharing the pool — an
  isolation bug, not a guarantee. Additionally the table is created/altered by
  Mastra's `createEmbeddingIndex`→`vector.createIndex`
  (`agent-tuAMgHe3.js:21834`), so policy DDL must survive idempotent re-runs
  and future Mastra schema changes — spec §5 L95's own rejection condition
  ("if the framework rewrites the table, this tier is rejected") applied to an
  unproven case. The pool/GUC argument above is this doc's **independent**
  second blocker: even if policy DDL survived, the tier cannot be wired
  per-request on the pinned surface. Verdict: **not feasible**.

### Tier C — one `Memory` (and `PgVector`) instance per tenant

- **Mechanism**: mirror the knowledge-RAG resolver, but for memory.
- **Why rejected**: `vector` is static per `Memory`; there is no memory
  resolver hook. Building one `Memory` per tenant also collides with the single
  registered `coreMemory` on the instance, costs one pool per tenant against
  the Supabase `pool_size` budget (§5, `src/config/env.ts:24-26`), and forces
  per-tenant embedder/vector construction, violating the key-hygiene rule
  (never construct the embedder at import; only inside `createCrumMastra`) and
  constraint #1. Verdict: **rejected**.

## 4. Decision

**Tier A, with the spec §5 double filter restored in its dynamic form.**
Isolation is `{ resource_id (framework) AND tenantId (per-request filter) }`
over one shared index in schema `mastra_memory` (spec §5 L94's example name;
`resource_id = `${tenantId}:${userId}`` makes the first half tenant+user exact,
and the second half is the mandated independent check).

The tenant filter **cannot be static** — one build-time predicate cannot vary
per caller — so the implementation has two mandatory halves:

1. **Write side**: CRUM stamps new conversation threads with
   `metadata: { tenantId }`, so every embedding written by `saveMessages`
   carries a `tenantId` key (§2 spread). Threads are created lazily by the
   Mastra agent loop / console proxy (`src/mastra/sessions.ts` wires no
   `createThread` call today); the concrete stamping hook belongs to Task 7.
2. **Read side**: at each turn the request layer passes
   `memoryConfig.semanticRecall.filter = { tenantId: { $eq: <server-derived
   tenant> } }`. `tenantId` comes from the verified identity
   (`src/mastra/identity.ts`), never from the client payload. The framework
   `$and`-combines it with the `resource_id` scope predicate
   (`src-DxZ7N8nO.js:42646`).

Rationale: Tier A is the only tier the pinned `Memory` API supports without
fighting the framework; Tier B fails spec §5 L95's table-rewrite-survival
condition and independently cannot be wired per-request on a framework-owned
static pool; Tier C violates the static-vector constraint, the pool budget, and
key hygiene. The residual risk — all tenants' embeddings coexist in one index
behind two `WHERE` predicates rather than in separate schemas — is accepted
**conditionally**, mitigated by: (1) both filter values are always
server-derived, (2) a **cross-tenant leak-guard integration test** in Task 8,
which must be built to actually falsify the second predicate: because
`resourceId` is tenant-prefixed, a natural A/B two-tenant scenario passes on
`resource_id` alone even if the tenant filter is never wired — so the guard
additionally **plants a row with the caller's own `resource_id` but a foreign
`metadata.tenantId`** (direct `vector.upsert` into the recall index, simulating
the resourceId-collapse bug the second predicate exists for) and asserts the
recall excludes it, and (3) `CRUM_RECALL_ENABLED` kill-switch so the feature
can be turned off independently.

**Second reader on the same schema (accepted residual)**: the double filter
above guards the *semantic-recall* read path. Attaching `vector` + `embedder`
also activates observational-memory **observation indexing** — a co-resident
second index (`memory_observations_<dim>`, default dim 384,
`src-DxZ7N8nO.js:43696-43709`; the writer early-returns only when
vector/embedder are missing, `:43760`) — and its shipped reader
`memory.searchMessages` (`GET /api/agent/search`, `src/api/threads.ts:233-234`)
filters on the **single hardcoded predicate** `{ resource_id: <caller> }`
(`src-DxZ7N8nO.js:43719-43724`); its typed `filter` accepts only
`threadId`/`observedAfter`/`observedBefore` (`@mastra/memory/dist/index.d.ts:349`)
and **cannot carry a `tenantId` clause at all**. That path therefore runs
"bare resourceId alone" — the formulation spec §5 L98 forbids for recall
queries — with the resourceId invariant (§2) as its only boundary. Accepted as
residual risk here: `resourceId` is server-derived from the verified identity
(`threads.ts:233`), the endpoint returns observation snippets of the caller's
own threads, and Task 8's leak guard covers it in the natural A/B form. If a
future requirement demands the double filter there too, the lever is upstream
support for a per-call filter on `searchMessages`, not CRUM-side monkey-patching.
Kill-switch coupling: `CRUM_RECALL_ENABLED` off omits `vector`/`embedder`
altogether, which also silences observation indexing and makes
`searchMessages` throw (`:43716`) — the switch turns the whole vector lane off,
not just recall.

**Backfill caveat (accepted)**: embeddings inherit thread metadata only at
write time, and threads created before the stamping hook have no
`tenantId` key — so their *new* messages still embed, but every row is
silently excluded by the `$eq` predicate: recall stays quietly dead for those
threads (no error, no results). Pre-feature threads have no recall embeddings
at all (`saveMessages` embeds only when `vector` + `semanticRecall` are
configured, `src-DxZ7N8nO.js:43156`), so nothing is "lost" — there was never a
recalled row. Closing the gap takes a one-time `UPDATE mastra_threads SET
metadata = jsonb_set(..., 'tenantId')` backfill (reviewed migration) or thread
recreation; Task 7/8 decide whether old threads are worth reviving.

## 5. Config snippet (what Tasks 6-8 implement)

`buildCrumMemory` grows to `(storage, env, recall?)`. The recall additions are
constructor keys (`vector`, `embedder`) plus one option key
(`semanticRecall`), all gated on the kill-switch and on a lazily-built deps
object so the embedder is never constructed at import. This snippet is the
config **shape**; Task 6/7 implement it verbatim (names/types verified against
the pinned `.d.ts`).

```ts
// src/mastra/recall.ts — constructed lazily inside createCrumMastra, never at import
import { PgVector } from '@mastra/pg'
import { crumEmbeddingModel } from './embeddings'
import { pgPoolMax, resolveSsl } from './storage'
import type { CrumEnv } from '../config/env'

export interface RecallDeps {
  vector: PgVector
  embedder: ReturnType<typeof crumEmbeddingModel>
}

// undefined => recall unavailable (flag off or no database). Task 6 contract.
export function buildRecallDeps(env: CrumEnv): RecallDeps | undefined {
  if (!env.CRUM_RECALL_ENABLED) return undefined
  const connectionString = env.DATABASE_URL
  if (!connectionString) return undefined

  const vector = new PgVector({
    id: 'pg-crum-recall',
    connectionString,
    // Supabase requires TLS; same rule as buildMastraStorage (storage.ts:115).
    ssl: resolveSsl(connectionString, env.MASTRA_PG_SSL),
    // Tier A: one shared schema for all tenants; isolation is the double
    // filter (§4), not a per-tenant schema.
    schemaName: 'mastra_memory',
    // PgVector's own default pool max is 20 (@mastra/pg/dist/index.js:601);
    // cap it like every other pool or the Supabase budget check breaks (§6).
    pgPoolOptions: { max: pgPoolMax(env) },
  })

  // MASTRA_MEMORY_EMBEDDER is a model-id override; unset => EMBEDDING_MODEL_ID
  // (openai/text-embedding-3-small, embeddings.ts:5). Task 5 promotes the key;
  // crumEmbeddingModel gains an optional modelId param (§6 note).
  const embedder = crumEmbeddingModel(env.MASTRA_MEMORY_EMBEDDER)
  return { vector, embedder }
}
```

```ts
// src/mastra/memory.ts — options added to the existing buildCrumMemory body.
// Full import list: type-only imports are mandatory under verbatimModuleSyntax.
import type { RecallDeps } from './recall'

export function buildCrumMemory(
  storage: CrumStorage,
  env: CrumEnv,
  recall?: RecallDeps,
): Memory {
  return new Memory({
    storage,
    // Recall needs BOTH constructor keys; omit entirely when the kill-switch
    // is off or deps are absent, leaving message-history recall unchanged.
    // Coupling: without vector/embedder, OM observation indexing goes silent
    // and memory.searchMessages throws (§4 second-reader note).
    ...(recall ? { vector: recall.vector, embedder: recall.embedder } : {}),
    options: {
      messageHistory: { maxTokens: 24_000, atMaxRemoveTokens: 6_000 },
      workingMemory: { enabled: true, template: CRUM_WORKING_MEMORY_TEMPLATE, scope: 'resource' },
      ...(env.CRUM_OM_ENABLED ? { observationalMemory: { model: CRUM_LIGHT_MODEL } } : {}),
      ...(env.CRUM_RECALL_ENABLED && recall
        ? {
            semanticRecall: {
              topK: 4,
              messageRange: 2,
              scope: 'resource',
              // indexConfig is consumed by createEmbeddingIndex (agent-tuAMgHe3.js
              // :21821-21832); omitting it builds ivfflat (pg default). Mirrors
              // CRUM_VECTOR_CONFIG (vector-store.ts:31-36). Dimension 1536 is
              // taken from the embedder at runtime, not from this config.
              indexConfig: {
                type: 'hnsw',
                metric: 'cosine',
                hnsw: { m: 16, efConstruction: 64 },
              },
              // NO static `filter` here on purpose: the tenant predicate must
              // vary per caller (§2 merge rule: request layer supplies the
              // whole filter; static filter would create merge hazards).
            },
          }
        : {}),
    },
  })
}
```

Per-request half (Task 7 wires this at the turn-invocation layer):

```ts
// memoryConfig passed with every turn, values server-derived from identity:
{ semanticRecall: { filter: { tenantId: { $eq: tenantId } } } }
```

The framework then executes
`{ $and: [{ resource_id: `${tenantId}:${userId}` }, { tenantId: { $eq: tenantId } }] }`
— the spec §5 double filter, never bare `resourceId` alone. The index lands at
`mastra_memory.memory_messages` (dimension-derived name, §2);
`semanticRecall.indexName` is intentionally not set because the pinned version
ignores it (§2).

## 6. Provisioning path

- **Schema + table + vector index**: all created **by the framework**,
  idempotently. `Memory.createEmbeddingIndex` calls
  `vector.createIndex({ indexName: 'memory_messages', dimension, metric,
  indexConfig, metadataIndexes: ['thread_id', 'resource_id'] })` on first
  save/query (`agent-tuAMgHe3.js:21817-21836`), and PgVector's `setupSchema`
  runs `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS`
  (`@mastra/pg/dist/index.js:1247, :1338`). No migration is required for the
  recall table. This is the same lane knowledge RAG already ships: the
  per-tenant `PgVector` resolver (`vector-store.ts:17-21`) creates
  `tenant_<id>` schemas and `crum_knowledge` via the framework, and
  `MASTRA_DB_DISABLE_INIT` (storage) demonstrably does not gate it.
  - `MASTRA_DB_DISABLE_INIT` applies to `PostgresStoreVNext` init only; the
    PgVector gate is its own `disableInit` config key
    (`PostgresBaseConfig`, `shared/config.d.ts:7,37`) or
    `MASTRA_DISABLE_STORAGE_INIT` (`index.js:883, :1285`). We do **not** set
    `disableInit` on the recall vector: with it, `createIndex` returns
    silently without building anything (`index.js:1285`), and the first
    upsert/query then fails against the missing table — a broken first-use
    path either way. The vector extension itself is already enabled by
    `0004_enable_pgvector.sql`.
  - Migration discipline still governs *hand-written* DDL: nothing in Tasks
    5-8 adds a migration for the recall table. If a future hardening pass adds
    an expression index on `metadata->>'tenantId'`, that DDL goes through a
    reviewed migration like `0009`/`0010`.
- **Index shape correctness** depends on the `indexConfig` option above —
  without it the lazy `createIndex` silently builds ivfflat
  (`index.js:1401-1402`), diverging from `CRUM_VECTOR_CONFIG`.
- **Pool budget (norm change, Task 6)**: the recall vector is the **third**
  `pg.Pool` on the main connection (storage + observability are the two
  counted today by `POOL_COUNT = 2`, `src/config/env.ts:24-26`).
  `checkPoolBudget` (`storage.ts:61-71`) and the
  `MASTRA_PG_POOL_MAX.max(MAX_POOL_PER_CONN)` guard (`env.ts:54-59`) must move
  to `POOL_COUNT = 3`, ceiling `floor(15/3) = 5` (default max 4 stays legal:
  3×4 = 12 ≤ 15), with `tests/mastra/storage.test.ts` expectations updated
  (pools 2→3, total 8→12, max-accepted 7→5). `pgPoolOptions.max` in §5 caps
  the new pool; without it PgVector opens `max: 20`
  (`index.js:599-606`) and blows the Supabase `pool_size` on first recall call.
  (The per-tenant knowledge-RAG pools sit *outside* this invariant already —
  this change does not widen that gap; the recall pool is brought *inside* it.)
- **Embedder override (Task 5 + 6)**: Task 5 promotes
  `MASTRA_MEMORY_EMBEDDER` out of `DEFERRED_ENV_VARS` (`env.ts:103`) into the
  parsed schema. `crumEmbeddingModel()` currently hardcodes
  `EMBEDDING_MODEL_ID` (`embeddings.ts:8-21`); Task 6 gives it an optional
  `modelId` parameter (`modelId = EMBEDDING_MODEL_ID` default) so the override
  actually reaches the constructed model instead of being dead config.
- **CI**: unit tests keep `CRUM_RECALL_ENABLED` unset-with-no-DATABASE_URL so
  `buildRecallDeps` returns `undefined` and no embedder/vector is constructed
  at import. The cross-tenant leak guard (Task 8) runs in the `integration`
  project only when `CRUM_INTEGRATION_DATABASE_URL` is set
  (`crum-ci.yml:129-133`), matching `om-client-history.test.ts`'s proven tier
  pattern.

### Verification status of this doc

Every API claim is quoted from the installed `.d.ts` / compiled source with
file:line above (verify-before-code rule). The Tier B rejection rests on two
read-verified facts: `vector` is a static single instance with a
framework-owned pool (`types.d.ts:1149`; `index.js:627`) and CRUM has no hook
to set a per-request GUC on it. The Tier A tenant-filter mechanism is
read-verified end to end: thread metadata → embedding metadata
(`src-DxZ7N8nO.js:43164-43169, :43201-43209`), per-request filter → combined
query (`:42643-42646`), filter keys → `metadata->>'…'` SQL
(`@mastra/pg/dist/index.js:183-192`). What is **not yet proven by a run**: the
thread-stamping + per-request injection round-trip and the HNSW index actually
being created with the option above — Tasks 6-8 (leak-guard integration test)
convert these design decisions into executed evidence.

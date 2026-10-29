# CRUM Agent Memory Upgrade — Design Spec

- **Date:** 2026-10-29
- **Status:** Approved in chat (user: "looks right, do it"); document review pending
- **Scope:** Three milestones upgrading the agent's memory from "Level 1–2 of Mastra's four memory layers" to all four, plus title generation.
- **Framework pin:** `@mastra/memory@1.39.0` (docs quoted below are the version-bundled copies in `node_modules/@mastra/memory/dist/docs/`).

## 1. Background and evidence

Mastra's official video ["4 Levels of Agent Memory Explained by a Senior AI Engineer"](https://www.youtube.com/watch?v=18iIHQtIPmc) is the conceptual overview linked from the memory docs themselves (`docs-memory-overview.md` L20). The four levels: message history → working memory → semantic recall → observational memory (OM).

Current CRUM state (verified in code):

| Level | Status | Evidence |
|---|---|---|
| Message history | Enabled, 24k-token window, trims 6k at a time | `src/mastra/memory.ts` L9-12 |
| Working memory | Enabled but placeholder-only template | `src/mastra/working-memory.ts` |
| Semantic recall | **Off** — no `semanticRecall`, no `vector`/`embedder` on Memory | `src/mastra/memory.ts` |
| Observational memory | **Off** — absent from options; also blocks server-side titles | `src/mastra/memory.ts`, repo architecture notes |

Rating delivered: 2/5. The upgrade closes the "agent silently forgets long conversations" hole.

Known constraints this design must respect (all verified this session or recorded in project memory):

1. `Memory` accepts exactly **one static vector instance**: `vector?: MastraVector | false` (`@mastra/core/dist/memory/types.d.ts` L1149). The serialized form stores a registry **id string** resolved on the Mastra instance. There is no per-request/per-tenant vector resolver like `knowledge.retrieve` has (`tenantVectorStoreResolver`, `src/mastra/vector-store.ts`).
2. Eager embedder construction at import time broke CI before (`OPENAI_API_KEY` machine-dependency trap). Anything new touching `crumEmbeddingModel()` must be constructed inside `createCrumMastra`, never at module scope.
3. Env contract: every new `EnvSchema` key must appear in `.env.example` and vice versa (`tests/config/env.test.ts` enforces both directions). `MASTRA_MEMORY_EMBEDDER` currently sits in `DEFERRED_ENV_VARS` (`src/config/env.ts` L99).
4. Supabase pool budget: `MASTRA_PG_POOL_MAX × pools ≤ 15` is validated at startup. OM background agents reuse the existing storage pool; no new connection strings.
5. Runtime creation: routes under `createApiRouter` share `getMastra`; four legacy routes construct per request. New Memory options must not increase per-request construction cost beyond what already exists.
6. No runtime table creation for business DDL (`MASTRA_DB_DISABLE_INIT=true`, migration drift guard). The established exception: vector indexes via idempotent `createIndex`, as `ingest.ts` already does.

## 2. Goals / Non-goals

**Goals**

- Long chats keep working memory instead of losing it: old messages compressed into observations by background Observer/Reflector agents (M1).
- The agent can recall semantically similar messages from **other threads of the same user** (M2).
- Working memory becomes a CRM short form the agent actually fills; new chats get server-generated titles (M3).

**Non-goals**

- Multi-user shared threads, thread clone/summarize APIs, memory processors beyond current `messageHistory` trimming, message-level trace ids (framework limitation), console redesign.
- Changing knowledge RAG (`crum_knowledge` per-tenant schemas) beyond what M2's unified-structure research concludes.

## 3. Decision record (from brainstorming Q&A)

| # | Question | Decision |
|---|---|---|
| D1 | Scope | Phased single spec: M1 OM → M2 recall → M3 working memory |
| D2 | OM gating | On by default + env kill-switch |
| D3 | Recall store layout | Research a complete unified vector structure first; per-tenant physical isolation (variant "B") is the target **if** feasible; else documented fallback tier |
| D4 | Working memory shape | Markdown template v2 (not JSON schema) |

## 4. M1 — Observational Memory

### What it does (plain words)

Two quiet background workers act like a meeting secretary: the **Observer** turns older messages into short notes ("observations"), and the **Reflector** reorganizes those notes when they pile up. The agent then reads the notes instead of the raw old transcript — the chat window stays small, but nothing important is thrown away. This replaces today's behavior where, once the conversation crosses 24,000 tokens, the oldest 6,000 tokens are simply dropped.

### Design

- `buildCrumMemory(storage: CrumStorage, env: CrumEnv)` — signature gains `env` (only caller today: `src/mastra/index.ts` L90, which already has the parsed env; test callers pass a controlled env map).
- When `env.CRUM_OM_ENABLED` (new key, `booleanish`, `.prefault('true')`, documented in `.env.example` under the memory section):

```ts
options.observationalMemory = { model: CRUM_LIGHT_MODEL }
```

- `messageHistory` window stays configured as-is; OM governs history replacement when active (verify interaction during implementation — if the framework documents that OM supersedes the token window, keep the option set anyway as the kill-switch-off behavior).
- Kill-switch off → exact current options object (byte-identical behavior for CI/unit env where the test env map sets `CRUM_OM_ENABLED=false`).
- Storage requirement: satisfied — `@mastra/pg` is on OM's supported adapter list (`docs-memory-observational-memory.md` L101).

### Client-history protocol gate

OM docs warn: with client apps, **send only the new message**. Console `useChat` + `/chat/crm` proxy currently forward the full message array; Mastra filters client-echoed history by stored message IDs. An integration test must prove that a long thread driven through the API with full-history payloads produces no duplicates and no ordering bugs. If it fails, fix by trimming the client payload to the last user message (console change), not by `retainFullInput: true`.

### Testing & verification tiers

1. Unit: flag off → options unchanged; flag on → `observationalMemory.model === CRUM_LIGHT_MODEL`; env contract test green with the new key.
2. Integration (CI pgvector service, in-memory-safe keys): thread driven past the observation threshold with a stub model; assert observation rows appear via storage reads.
3. Real run (developer machine, requires `DATABASE_URL` + `OPENROUTER_API_KEY`): Mastra Studio chat, multi-turn long conversation; verify in trace/Studio that observations+reflections enter the LLM context and old raw messages drop out. Report which tier was actually achieved.

### Risks

- Free light-model quality for observation fidelity → mitigate by pinning explicitly to `CRUM_LIGHT_MODEL` and checking observation content in the real-run tier; can be repinned via `CRUM_MODEL_LIGHT` without code change.
- Extra background LLM calls per conversation → free model, plus kill-switch.

## 5. M2 — Unified vector structure (knowledge RAG + memory recall)

### Step 0: research task (deliverable required before any M2 code)

Write `docs/research/unified-vector-structure-2026-11.md` answering: what is the complete target structure for **both** vector consumers — knowledge RAG (per-tenant `tenant_<id>.crum_knowledge`, resolver-based, already shipped) and conversation recall (one static `Memory` vector instance)? Evaluate these isolation tiers and pick one, with rationale:

- **Tier A — Shared recall index + double logical filter:** one PgVector (dedicated schema, e.g. `mastra_memory`), one recall index; queries filtered by `resourceId` (`tenantId:userId` — already tenant-prefixed) **and** `semanticRecall.filter` on a stored `tenantId` metadata field. Cheapest; matches how threads are isolated today; weakness: co-resident rows, filter-correctness is the security boundary.
- **Tier B — Postgres row-level security on the recall table:** same shared instance, but the database itself enforces `tenant_id = current_setting(...)` — physical enforcement without per-tenant Memory instances. Cost: RLS policies over a framework-owned table (Mastra creates/owns it; policies must survive `createIndex` idempotent re-runs and future Mastra schema changes — verify feasibility during research; if the framework rewrites the table, this tier is rejected).
- **Tier C — Per-tenant Memory instances:** rejected by constraint #1 (static vector) unless the research finds a supported multi-memory pattern (e.g. one Memory registered per tenant through the instance `memory` registry — weigh against pool budget and fan-out complexity; document the verdict even if rejected again).

Decision rule: prefer Tier B if it survives verification; otherwise Tier A with the metadata filter mandatory (never bare resourceId alone) (ruling 2026-10-30,
user-approved "ship ON, add test first": superseded for the Tier A ship — the
injective server-derived resourceId is accepted as the boundary, the metadata
filter deferred as defense-in-depth; see research doc §4). Tier C stays rejected unless discovered otherwise. Output must include the final config snippet for `buildCrumMemory` (`vector`, `embedder`, `semanticRecall` options) and the provisioning path for the recall table (idempotent `createIndex` at boot like `ingest.ts`, reviewed migration only if DDL beyond the index is required).

### Build (after research approval)

- `CRUM_RECALL_ENABLED` booleanish flag, same on-by-default + off-in-tests pattern as M1.
- Embedder: promote `MASTRA_MEMORY_EMBEDDER` from `DEFERRED_ENV_VARS` to real schema — a model-id override string defaulting to `openai/text-embedding-3-small` (`EMBEDDING_MODEL_ID`), constructed **inside** `createCrumMastra` via a lazy factory; unit test env supplies placeholder `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY` (the proven CI fix pattern).
- Recall options (defaults): `{ topK: 4, messageRange: 2, scope: 'resource', filter: <tenantId clause per chosen tier> }`.
- Vector config mirrors `CRUM_VECTOR_CONFIG`: dimension 1536, cosine, HNSW (m 16, efConstruction 64) — dimension must match `EMBEDDING_DIMENSIONS`.

### Testing & verification tiers

1. Unit: flag gating + config shape; no embedder construction at import (assert by importing `src/mastra/memory.ts` with an env lacking any OpenAI key).
2. Integration: CI pgvector service — store messages in thread 1, new thread 2 for same resource asks a semantically-related question; assert recalled messages interleaved (or cross-thread system block per docs) using a deterministic fake embedder where possible.
3. Real run: Studio/console — second chat thread recalls a fact stated only in a first thread; verify embedding rows exist in the recall table; report tier achieved.

### Risks

- Embedding latency per turn (embed all new messages) → framework embeds in background after response; verify in real run, otherwise document as accepted cost.
- Cross-tenant leakage if filter misconfigured → Tier B removes this class; Tier A requires the integration test to assert a second tenant's messages are never recalled.

## 6. M3 — Working memory template v2 + titles

- Replace `CRUM_WORKING_MEMORY_TEMPLATE` with a CRM short form following the doc style rules (short labels, consistent case, minimal placeholders):

```
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
```

- `CRUM_INSTRUCTIONS` gains a short section: when to fill each block, when to clear (e.g. focus block clears when the user closes a topic), and "never store customer data that tools can read live" (memory stays a pointer-sets, not a data copy — avoids drift against the CRM spine).
- Title generation: `options.generateTitle = { model: CRUM_LIGHT_MODEL }`. Existing console PATCH `source:'auto'` flow keeps working — it only applies when the stored title is empty and unpinned; `titlePinned` continues to win. Thread-list endpoint surfaces whatever title exists; no API change.
- Gating: template v2 is a constant change (no flag); `generateTitle` rides the same env-off pattern only if tests show LLM title calls leaking into CI — decide during implementation, default is no extra flag.

### Verification

1. Unit: template renders as initial working memory on new thread (existing threads API tests cover shape).
2. Real run: chat that states a preference and later switches account focus; inspect working memory via Studio thread sidebar / `GET /api/agent/threads/:id`; new thread gets a non-empty auto title within a few turns.

## 7. Cross-cutting

- **Env changes land atomically:** schema key + `.env.example` line + contract test in the same commit as the feature; `.env` local values updated with documented steps (per fail-closed rules — an empty value counts as provided and crashes boot).
- **Ordering:** M1 → verify → M2 research → research review → M2 build → verify → M3. Each milestone independently shippable and reversible by its flag.
- **Console changes:** none planned except the M1 history-payload fix if the gate test fails.
- **Governance/policy files:** untouched.
- **Completion claim rule:** every "done" statement reports the runnability tier actually achieved (unit green / integration green / real run verified) and lists unmet requirements (keys, DATABASE_URL, IP allowlist) with setup steps.

## 8. Success criteria

1. A >24k-token conversation answers a question about something said at the start (M1).
2. A new thread recalls a fact stated only in an older thread of the same user, and never of another tenant (M2).
3. Working memory visibly fills during normal use and new chats are auto-titled (M3).
4. CI green with no machine-level API key dependency; `git diff --exit-code migrations/` still passes.

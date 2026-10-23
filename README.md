# CRUM - Conversational Relationship and Utility Manager

A conversational CRM workbench built on Mastra, inspired by the Wukong AICRM architecture but with a stronger governance plane.

## Architecture

One agent, scoped by context, not fixed lanes. The chat entry point streams answers and calls Zod-validated tools against business objects (customers, contacts, followups, tasks, schedules). Every write path stages a draft, passes through an approval gate, and emits a signed receipt bound to a runId.

## Tech Stack

- **Backend**: Mastra (@mastra/core 1.79.0, pinned exactly), TypeScript ES modules on Node 22.18.0+
- **Frontend**: Next.js console (shared with AllRounderAgent)
- **Database**: PostgreSQL with PgVector for RAG
- **Storage**: Supabase PostgresStoreVNext
- **Model routing**: OpenRouter

## Phases

See [`docs/TECHNICAL_PLAN.md`](./docs/TECHNICAL_PLAN.md) for the full design and
[`docs/superpowers/plans/00-ROADMAP.md`](./docs/superpowers/plans/00-ROADMAP.md) for the phase map.
This project implements Phases 0 through 7 as listed in the roadmap.

1. Phase 0: Spine schema and product definition
2. Phase 1: Chat workbench skeleton with streaming and threads
3. Phase 2: Read tools and object binding
4. Phase 3: Write path with confirmation and receipts
5. Phase 4: Knowledge RAG pipeline
6. Phase 5: Structured prefill, email drafting, MCP exposure
7. Phase 6: Evals and today view

## License Gate

Concept-level study of Wukong AICRM only. No copying of code, schemas, prompts or UI from their repos. Everything written fresh on Mastra. See the parent repo plan document for the full legal analysis.

## Getting Started

CRUM is a standalone repository. It inherits AllRounderAgent's environment variable *names* but not
its code, and it is not a workspace inside it.

```bash
cd D:/Code/CRUM
npm install
npm run typecheck && npm run test:unit
npm run dev            # Mastra server :4111 plus Studio :4112
```

`npm run dev` needs the Mastra CLI, which arrives in Phase 1 with the console. During Phase 0 the
verification command is the `typecheck && test:unit` line above.

Without `DATABASE_URL` the whole stack boots in-memory, which is what makes contribution and CI
cheap. Agents, tools and workflows live under `src/mastra/`.

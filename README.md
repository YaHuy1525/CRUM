# CRUM - Conversational Relationship and Utility Manager

A conversational CRM workbench built on Mastra, inspired by the Wukong AICRM architecture but with a stronger governance plane.

## Architecture

One agent, scoped by context, not fixed lanes. The chat entry point streams answers and calls Zod-validated tools against business objects (customers, contacts, followups, tasks, schedules). Every write path stages a draft, passes through an approval gate, and emits a signed receipt bound to a runId.

## Tech Stack

- **Backend**: Mastra (@mastra/core 1.76.0), TypeScript ES modules
- **Frontend**: Next.js console (shared with AllRounderAgent)
- **Database**: PostgreSQL with PgVector for RAG
- **Storage**: Supabase PostgresStoreVNext
- **Model routing**: OpenRouter

## Phases

See `docs/72CRM_Reverse_Engineering_Plan_20261023.md` in the parent AllRounderAgent repo for the full build plan. This project implements:

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

This is a sub-project of AllRounderAgent. Development happens in the shared monorepo context.

```bash
cd D:/Code/AllRounderAgent
npm install
npm run dev
```

The CRUM-specific agents and workflows will live under `src/mastra/crum/`.

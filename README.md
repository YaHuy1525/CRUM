# CRUM - Conversational Relationship and Utility Manager

A conversational CRM workbench built on Mastra.

## Architecture

One agent, scoped by context, not fixed lanes. The chat entry point streams answers and calls Zod-validated tools against business objects (customers, contacts, followups, tasks, schedules). Every write path stages a draft, passes through an approval gate, and emits a signed receipt bound to a runId.

## Tech Stack

- **Backend**: Mastra (@mastra/core 1.79.0, pinned exactly), TypeScript ES modules on Node 22.18.0+
- **Frontend**: Next.js console (shared with AllRounderAgent)
- **Database**: PostgreSQL with PgVector for RAG
- **Storage**: Supabase PostgresStoreVNext
- **Model routing**: OpenRouter

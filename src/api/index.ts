// src/api/index.ts
import { Hono } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { createFeedbackRouter } from './feedback'
import { createUsageRouter } from './usage'
import { createDigestRouter } from './digest'
import { createSignalsRouter } from './signals'
import { createHealthRouter } from './health'
import { createPrefillRouter } from './prefill'
import { createCrmRouter } from './crm'
import { createApprovalRouter, type SuspendedRunAgent } from './approvals'
import { createKnowledgeRouter, type IngestWorkflowLike } from './knowledge'
import { createAgentRouter } from './agent'
import { createThreadsRouter } from './threads'

/**
 * Aggregate API router. Mounts all sub-routers under their respective
 * base paths. Individual routers use `.basePath()` internally, so this
 * file mounts them all at `/`.
 *
 * Everything on this plane reaches the registry through `getMastra`, a function
 * rather than an instance: the module-level singleton lives in `src/mastra/index.ts`
 * (the CLI entry), and importing it here would make every route test construct a
 * Mastra (and read `process.env`) at import time.
 */
export interface ApiRouterDeps {
  env: CrumEnv
  /** Null before the instance is built. Each router answers its own 503. */
  getMastra?: () => Mastra | null
}

/** Agents registry key (§4.1). Shares its string with the controller key today,
 *  but they are two registries and are not the same lookup. */
const CRUM_AGENT_KEY = 'crm-assistant'

/** Workflows registry key (`src/mastra/index.ts`). */
const INGEST_WORKFLOW_KEY = 'knowledge-ingest'

/**
 * The registry returns a fully-parameterised `Agent`, and the approval routes only
 * ever see it through the `SuspendedRunAgent` shape this getter is typed to return.
 * No assertion is needed to get there (`Agent`'s type parameters are `any`, so it
 * is structurally assignable), which is exactly why the shape is asserted in the
 * routes' own deps rather than here: a version bump that removes
 * `approveToolCallGenerate` is caught by tests/api/approvals.test.ts, not by the
 * registry lookup.
 */
function agentGetter(getMastra?: () => Mastra | null): () => SuspendedRunAgent | null {
  return () => {
    const mastra = getMastra?.() ?? null
    if (!mastra) return null
    try {
      return mastra.getAgent(CRUM_AGENT_KEY)
    } catch {
      // An unregistered agent is a wiring fault, and 503 "agent-not-wired" is
      // truer than letting the registry's throw become a 500 on the queue.
      return null
    }
  }
}

function ingestGetter(getMastra?: () => Mastra | null): () => IngestWorkflowLike | null {
  return () => {
    const mastra = getMastra?.() ?? null
    if (!mastra) return null
    try {
      return mastra.getWorkflow(INGEST_WORKFLOW_KEY)
    } catch {
      return null
    }
  }
}

export function createApiRouter(deps: ApiRouterDeps): Hono {
  const { env } = deps
  const app = new Hono()

  app.route('/', createHealthRouter())
  app.route('/', createFeedbackRouter())
  app.route('/', createUsageRouter())
  app.route('/', createDigestRouter())
  app.route('/', createPrefillRouter())
  app.route('/', createCrmRouter({ env }))
  app.route('/', createSignalsRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createAgentRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createThreadsRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createApprovalRouter({ env, getAgent: agentGetter(deps.getMastra) }))
  app.route('/', createKnowledgeRouter({ env, getIngestWorkflow: ingestGetter(deps.getMastra) }))

  return app
}

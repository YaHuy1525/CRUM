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
import { createProspectsRouter } from './prospects'
import { createApprovalRouter, type SuspendedRunAgent } from './approvals'
import { createKnowledgeRouter, type IngestWorkflowLike } from './knowledge'
import { createDocumentsRouter, type DocumentIntakeWorkflowLike } from './documents'
import { createAgentRouter } from './agent'
import { createThreadsRouter } from './threads'
import { createMailRouter } from './mail'
import { createVideoChannelsRouter } from './video-channels'
import { createVideoOAuthRouter } from './video-oauth'
import { createVideoSponsorshipRouter, type SponsorshipIntakeWorkflowLike } from './video-sponsorship'
import { createVideoBillingRouter, createVideoAlertsRouter } from './video-billing'
import { createVideoRevenueRouter } from './video-revenue'

export interface ApiRouterDeps {
  env: CrumEnv
  getMastra?: () => Mastra | null
}

const CRUM_AGENT_KEY = 'crm-assistant'

const INGEST_WORKFLOW_KEY = 'knowledge-ingest'

const DOCUMENT_INTAKE_WORKFLOW_KEY = 'crum-document-intake'

const SPONSORSHIP_INTAKE_WORKFLOW_KEY = 'crum-sponsorship-intake'

function agentGetter(getMastra?: () => Mastra | null): () => SuspendedRunAgent | null {
  return () => {
    const mastra = getMastra?.() ?? null
    if (!mastra) return null
    try {
      return mastra.getAgent(CRUM_AGENT_KEY)
    } catch {
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

function documentIntakeGetter(
  getMastra?: () => Mastra | null,
): () => DocumentIntakeWorkflowLike | null {
  return () => {
    const mastra = getMastra?.() ?? null
    if (!mastra) return null
    try {
      return mastra.getWorkflow(DOCUMENT_INTAKE_WORKFLOW_KEY)
    } catch {
      return null
    }
  }
}

function sponsorshipIntakeGetter(
  getMastra?: () => Mastra | null,
): () => SponsorshipIntakeWorkflowLike | null {
  return () => {
    const mastra = getMastra?.() ?? null
    if (!mastra) return null
    try {
      return mastra.getWorkflow(SPONSORSHIP_INTAKE_WORKFLOW_KEY)
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
  app.route('/', createProspectsRouter({ env }))
  app.route('/', createSignalsRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createAgentRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createThreadsRouter({ env, getMastra: deps.getMastra }))
  app.route('/', createApprovalRouter({ env, getAgent: agentGetter(deps.getMastra) }))
  app.route('/', createKnowledgeRouter({ env, getIngestWorkflow: ingestGetter(deps.getMastra) }))
  app.route('/', createDocumentsRouter({ env, getIntakeWorkflow: documentIntakeGetter(deps.getMastra) }))
  app.route('/', createMailRouter({ env }))
  app.route('/', createVideoChannelsRouter({ env }))
  app.route('/', createVideoOAuthRouter({ env }))
  app.route('/', createVideoSponsorshipRouter({ env, getSponsorshipWorkflow: sponsorshipIntakeGetter(deps.getMastra) }))
  app.route('/', createVideoBillingRouter({ env }))
  app.route('/', createVideoAlertsRouter({ env }))
  app.route('/', createVideoRevenueRouter({ env }))

  return app
}

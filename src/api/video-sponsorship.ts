import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  listSponsorship,
  getSponsorship,
  setSponsorshipStatus,
} from '../db/sponsorship'
import type { SponsorshipStatus, DealType } from '../db/types'

// The sponsorship-intake workflow's input. The router constructs it from the
// resolved identity plus the scan body; the workflow itself persists the row.
interface IntakeInput {
  tenantId: string
  ownerId: string
  subject: string
  text: string
  source: 'email' | 'manual' | 'chat'
  sourceRef: string | null
}

// The workflow's output — exactly the shape sponsorship-intake resolves to.
interface IntakeResult {
  detected: boolean
  sponsorshipId: string | null
  status: 'suggested' | 'confirmed' | 'dismissed' | 'skipped'
  confidence: number | null
  channelId: string | null
  customerId: string | null
}

type IntakeOutcome =
  | { status: 'success'; result?: IntakeResult }
  | { status: 'failed'; error?: { message?: string } }
  | { status: 'tripwire' | 'suspended' | 'paused' }

// Structural interface so this router stays decoupled from the concrete Mastra
// workflow (mirrors DocumentIntakeWorkflowLike in documents.ts).
export interface SponsorshipIntakeWorkflowLike {
  createRun(): Promise<{
    start(args: {
      inputData: IntakeInput
      requestContext?: RequestContext
    }): Promise<IntakeOutcome>
  }>
}

export interface VideoSponsorshipRouterDeps {
  env: CrumEnv
  getSponsorshipWorkflow?: () => SponsorshipIntakeWorkflowLike | null
}

const IdSchema = z.string().uuid()
const StatusSchema = z.enum(['suggested', 'confirmed', 'dismissed'])
const DealTypeSchema = z.enum(['flat', 'cpm', 'rev_share', 'gift', 'affiliate', 'other'])
const SourceSchema = z.enum(['email', 'manual', 'chat'])

const ScanSchema = z.object({
  subject: z.string().max(500).default(''),
  text: z.string().min(1).max(200000),
  source: SourceSchema.default('email'),
  sourceRef: z.string().optional(),
})

export function createVideoSponsorshipRouter(deps: VideoSponsorshipRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/sponsorship')

  const auth = async (
    c: Context,
  ): Promise<{ identity: TenantRequestContext } | { error: Response }> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  app.post('/scan', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId, userId, userRole } = gate.identity

    const body = await c.req.json().catch(() => null)
    const parsed = ScanSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) },
        400,
      )
    }

    const workflow = deps.getSponsorshipWorkflow?.() ?? null
    if (!workflow) {
      return c.json(
        {
          error: 'intake-not-wired',
          detail: 'This router was created without getSponsorshipWorkflow, so the message cannot be processed.',
        },
        503,
      )
    }

    const requestContext = new RequestContext()
    requestContext.set('tenantId', tenantId)
    requestContext.set('userId', userId)
    requestContext.set('tenantContext', { tenantId, userId, userRole })

    let outcome: IntakeOutcome
    try {
      const run = await workflow.createRun()
      outcome = await run.start({
        inputData: {
          tenantId,
          ownerId: userId,
          subject: parsed.data.subject,
          text: parsed.data.text,
          source: parsed.data.source,
          sourceRef: parsed.data.sourceRef ?? null,
        },
        requestContext,
      })
    } catch (err) {
      return c.json(
        { error: 'intake_threw', detail: err instanceof Error ? err.message : String(err) },
        502,
      )
    }

    if (outcome.status === 'success' && outcome.result) {
      return c.json(
        {
          detected: outcome.result.detected,
          sponsorshipId: outcome.result.sponsorshipId,
          status: outcome.result.status,
          confidence: outcome.result.confidence,
          channelId: outcome.result.channelId,
          customerId: outcome.result.customerId,
        },
        201,
      )
    }

    return c.json(
      {
        error: 'intake_failed',
        status: outcome.status,
        detail: outcome.status === 'failed' ? outcome.error?.message : undefined,
      },
      502,
    )
  })

  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const status = c.req.query('status')
    if (status !== undefined && status !== '') {
      const parsed = StatusSchema.safeParse(status)
      if (!parsed.success) {
        return c.json(
          { error: 'invalid_query', detail: 'status must be suggested, confirmed, or dismissed' },
          400,
        )
      }
    }

    const channelId = c.req.query('channelId')
    if (channelId !== undefined && channelId !== '' && !IdSchema.safeParse(channelId).success) {
      return c.json({ error: 'invalid_query', detail: 'channelId must be a uuid' }, 400)
    }

    const customerId = c.req.query('customerId')
    if (customerId !== undefined && customerId !== '' && !IdSchema.safeParse(customerId).success) {
      return c.json({ error: 'invalid_query', detail: 'customerId must be a uuid' }, 400)
    }

    const dealType = c.req.query('dealType')
    if (dealType !== undefined && dealType !== '') {
      const parsed = DealTypeSchema.safeParse(dealType)
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid_query',
            detail: 'dealType must be flat, cpm, rev_share, gift, affiliate, or other',
          },
          400,
        )
      }
    }

    const sponsorships = await listSponsorship(gate.identity, {
      status: (status || undefined) as SponsorshipStatus | undefined,
      channelId: channelId || undefined,
      customerId: customerId || undefined,
      dealType: (dealType || undefined) as DealType | undefined,
    })
    return c.json({ sponsorships, total: sponsorships.length })
  })

  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const sponsorship = await getSponsorship(gate.identity, id.data)
    if (!sponsorship) return c.json({ error: 'not_found' }, 404)
    return c.json({ sponsorship })
  })

  const confirmOrDismiss = (status: SponsorshipStatus) => async (c: Context) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const updated = await setSponsorshipStatus(gate.identity, id.data, status)
    if (!updated) return c.json({ error: 'not_found_or_not_pending' }, 404)
    return c.json({ sponsorshipId: updated.id, status: updated.status })
  }

  app.post('/:id/confirm', confirmOrDismiss('confirmed'))
  app.post('/:id/dismiss', confirmOrDismiss('dismissed'))

  return app
}

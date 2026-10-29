// tests/unit/api/video-sponsorship.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The Phase 4 sponsorship routes, exercised over real HTTP with the DB layer
 * stubbed. The scan route is asserted at the seam that matters: it must hand the
 * intake workflow the resolved tenant/owner plus a request context carrying
 * `tenantId`, and it must report the workflow's own status rather than pretending.
 * The read and confirm/dismiss routes are pinned to identity-first validation —
 * a malformed filter or id must be rejected before the DB is touched.
 */
const db = vi.hoisted(() => ({
  listSponsorship: vi.fn(),
  getSponsorship: vi.fn(),
  setSponsorshipStatus: vi.fn(),
}))

vi.mock('../../../src/db/sponsorship', () => db)

import {
  createVideoSponsorshipRouter,
  type SponsorshipIntakeWorkflowLike,
} from '../../../src/api/video-sponsorship'
import { parseEnv } from '../../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const SPONSORSHIP = '770e8400-e29b-41d4-a716-446655440003'
const CHANNEL = '880e8400-e29b-41d4-a716-446655440011'
const CUSTOMER = '990e8400-e29b-41d4-a716-446655440022'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function workflowReturning(outcome: unknown): {
  fake: SponsorshipIntakeWorkflowLike
  start: ReturnType<typeof vi.fn>
} {
  const start = vi.fn().mockResolvedValue(outcome)
  const fake: SponsorshipIntakeWorkflowLike = { createRun: vi.fn().mockResolvedValue({ start }) }
  return { fake, start }
}

function throwingWorkflow(): SponsorshipIntakeWorkflowLike {
  return { createRun: vi.fn().mockRejectedValue(new Error('run exploded')) }
}

function router(intake?: SponsorshipIntakeWorkflowLike | null): Hono {
  return createVideoSponsorshipRouter({
    env: parseEnv({}),
    ...(intake ? { getSponsorshipWorkflow: () => intake } : {}),
  })
}

function scanBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({ text: 'We would love to sponsor your next video.', ...over })
}

const SUCCESS = {
  status: 'success',
  result: {
    detected: true,
    sponsorshipId: SPONSORSHIP,
    status: 'suggested',
    confidence: 0.82,
    channelId: CHANNEL,
    customerId: CUSTOMER,
  },
}

function sponsorshipRow(over: Record<string, unknown> = {}) {
  return {
    id: SPONSORSHIP,
    tenant_id: TENANT,
    owner_id: USER,
    channel_id: CHANNEL,
    customer_id: CUSTOMER,
    status: 'suggested',
    deal_type: 'flat',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('identity gate', () => {
  it('refuses before touching the database', async () => {
    const res = await router().request('/api/video/sponsorship', {
      headers: { 'x-tenant-id': TENANT },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(db.listSponsorship).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/sponsorship/scan', () => {
  it('runs the intake workflow with identity and a tenant request context', async () => {
    const { fake, start } = workflowReturning(SUCCESS)

    const res = await router(fake).request('/api/video/sponsorship/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: scanBody({ subject: 'Brand deal', source: 'email', sourceRef: 'msg-1' }),
    })

    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      detected: true,
      sponsorshipId: SPONSORSHIP,
      status: 'suggested',
      confidence: 0.82,
      channelId: CHANNEL,
      customerId: CUSTOMER,
    })
    const args = start.mock.calls[0]![0] as {
      inputData: Record<string, unknown>
      requestContext: { get: (k: string) => unknown }
    }
    expect(args.inputData).toMatchObject({ tenantId: TENANT, ownerId: USER, subject: 'Brand deal', source: 'email' })
    expect(args.requestContext.get('tenantId')).toBe(TENANT)
    expect(args.requestContext.get('userId')).toBe(USER)
  })

  it('answers 503 when no intake workflow is wired', async () => {
    const res = await router().request('/api/video/sponsorship/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: scanBody(),
    })
    expect(res.status).toBe(503)
    expect((await json<{ error?: string }>(res)).error).toBe('intake-not-wired')
  })

  it('reports a failed run as a 502 with the workflow error', async () => {
    const { fake } = workflowReturning({ status: 'failed', error: { message: 'model unavailable' } })
    const res = await router(fake).request('/api/video/sponsorship/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: scanBody(),
    })
    expect(res.status).toBe(502)
    expect(await json(res)).toMatchObject({ error: 'intake_failed', status: 'failed', detail: 'model unavailable' })
  })

  it('reports a thrown workflow as a 502 intake_threw', async () => {
    const res = await router(throwingWorkflow()).request('/api/video/sponsorship/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: scanBody(),
    })
    expect(res.status).toBe(502)
    expect((await json<{ error?: string; detail?: string }>(res))).toMatchObject({
      error: 'intake_threw',
      detail: 'run exploded',
    })
  })

  it('rejects a scan with empty text before running the workflow', async () => {
    const { fake, start } = workflowReturning(SUCCESS)
    const res = await router(fake).request('/api/video/sponsorship/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: scanBody({ text: '' }),
    })
    expect(res.status).toBe(400)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/sponsorship', () => {
  it('lists sponsorships with the resolved identity', async () => {
    db.listSponsorship.mockResolvedValue([sponsorshipRow()])

    const body = await json<{ sponsorships: { id: string }[]; total: number }>(
      router().request('/api/video/sponsorship?status=suggested', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(body.sponsorships[0]!.id).toBe(SPONSORSHIP)
    expect(db.listSponsorship).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.objectContaining({ status: 'suggested' }),
    )
  })

  it('rejects an unknown status filter', async () => {
    const res = await router().request('/api/video/sponsorship?status=archived', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.listSponsorship).not.toHaveBeenCalled()
  })

  it('rejects an unknown dealType filter', async () => {
    const res = await router().request('/api/video/sponsorship?dealType=sponsored', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.listSponsorship).not.toHaveBeenCalled()
  })

  it('rejects a malformed channelId uuid', async () => {
    const res = await router().request('/api/video/sponsorship?channelId=not-a-uuid', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.listSponsorship).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/sponsorship/:id', () => {
  it('returns a visible sponsorship', async () => {
    db.getSponsorship.mockResolvedValue(sponsorshipRow())
    const body = await json<{ sponsorship?: { id: string } }>(
      router().request(`/api/video/sponsorship/${SPONSORSHIP}`, { headers: AUTH }),
    )
    expect(body.sponsorship?.id).toBe(SPONSORSHIP)
  })

  it('answers 404 for a sponsorship it cannot see', async () => {
    db.getSponsorship.mockResolvedValue(null)
    const res = await router().request(`/api/video/sponsorship/${SPONSORSHIP}`, { headers: AUTH })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found')
  })

  it('rejects a malformed id before the database', async () => {
    const res = await router().request('/api/video/sponsorship/not-a-uuid', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.getSponsorship).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/sponsorship/:id/confirm', () => {
  it('flips a suggested deal to confirmed', async () => {
    db.setSponsorshipStatus.mockResolvedValue({ id: SPONSORSHIP, status: 'confirmed' })

    const res = await router().request(`/api/video/sponsorship/${SPONSORSHIP}/confirm`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ sponsorshipId: SPONSORSHIP, status: 'confirmed' })
    expect(db.setSponsorshipStatus).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      SPONSORSHIP,
      'confirmed',
    )
  })

  it('answers 404 when the id is not a visible pending deal', async () => {
    db.setSponsorshipStatus.mockResolvedValue(null)
    const res = await router().request(`/api/video/sponsorship/${SPONSORSHIP}/confirm`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found_or_not_pending')
  })
})

describe('POST /api/video/sponsorship/:id/dismiss', () => {
  it('flips a suggested deal to dismissed', async () => {
    db.setSponsorshipStatus.mockResolvedValue({ id: SPONSORSHIP, status: 'dismissed' })
    const res = await router().request(`/api/video/sponsorship/${SPONSORSHIP}/dismiss`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(db.setSponsorshipStatus).toHaveBeenCalledWith(expect.anything(), SPONSORSHIP, 'dismissed')
  })
})

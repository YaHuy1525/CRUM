import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  upsertActiveBillingProfile,
  listBillingProfiles,
  deactivateBillingProfile,
  generateInvoice,
  getInvoice,
  listInvoices,
  setInvoiceStatus,
} from '../db/billing'
import {
  listRevenueAlerts,
  getRevenueAlert,
  setRevenueAlertStatus,
  detectRevenueAlerts,
} from '../db/alerts'
import type { InvoiceStatus, RevenueAlertStatus } from '../db/types'

// Phase 5 — the money-OUT surface.
//
// Two independent routers, mounted by src/api/index.ts (the caller wires them;
// this module only exports the factories):
//   createVideoBillingRouter -> /api/video/billing  (fee profiles + invoices)
//   createVideoAlertsRouter  -> /api/video/alerts   (revenue anomaly alerts)
//
// Auth, validation and response shapes mirror src/api/video-sponsorship.ts
// exactly: an identity gate first (401 on IdentityError), zod `.safeParse` on
// every body and query filter (400 invalid_body / invalid_query), 404 not_found
// for a missing row, and a confirmOrDismiss-style factory for the status
// transitions. Nothing here auto-sends: an invoice walks draft -> approved ->
// issued by a human, and an alert is only a row a human acknowledges/dismisses.

export interface VideoBillingRouterDeps {
  env: CrumEnv
}

export interface VideoAlertsRouterDeps {
  env: CrumEnv
}

type IdentityOrError = { identity: TenantRequestContext } | { error: Response }

const IdSchema = z.string().uuid()

// ── Billing enums / schemas ────────────────────────────────────────────────
const FeeModelSchema = z.enum(['pct_of_revenue', 'flat_retainer', 'hybrid'])
const BillingPeriodSchema = z.enum(['monthly', 'quarterly'])
const InvoiceStatusSchema = z.enum(['draft', 'approved', 'issued', 'void'])

const ProfileWriteSchema = z.object({
  customerId: IdSchema,
  ownerId: IdSchema.optional(),
  feeModel: FeeModelSchema.optional(),
  managementFeePct: z.number().min(0).max(100).optional(),
  flatAmount: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  billingPeriod: BillingPeriodSchema.optional(),
  billOnSponsorship: z.boolean().optional(),
  notes: z.string().optional(),
  validFrom: z.string().date().optional(),
  validTo: z.string().date().nullable().optional(),
})

const GenerateInvoiceSchema = z.object({
  customerId: IdSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
})

// ── Alerts enums / schemas ─────────────────────────────────────────────────
const AlertStatusSchema = z.enum(['open', 'acknowledged', 'dismissed'])
const AlertKindSchema = z.enum([
  'revenue_drop',
  'revenue_spike',
  'new_sponsorship',
  'sync_failure',
])

const ScanSchema = z.object({
  thresholds: z
    .object({
      dropPct: z.number().min(0).max(1),
      spikePct: z.number().min(0).max(1),
    })
    .optional(),
})

// ── Shared helpers ─────────────────────────────────────────────────────────

function makeAuth(env: CrumEnv) {
  return async (c: Context): Promise<IdentityOrError> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }
}

// Validates an optional uuid query filter ("" and undefined are both "unset").
function optionalUuidFilter(c: Context, name: string): { value?: string } | { error: Response } {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return { value: undefined }
  if (!IdSchema.safeParse(raw).success) {
    return { error: c.json({ error: 'invalid_query', detail: `${name} must be a uuid` }, 400) }
  }
  return { value: raw }
}

// Validates an optional date-string query filter ("from"/"to").
function optionalDateFilter(c: Context, name: string): { value?: string } | { error: Response } {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return { value: undefined }
  if (!z.string().date().safeParse(raw).success) {
    return { error: c.json({ error: 'invalid_query', detail: `${name} must be a YYYY-MM-DD date` }, 400) }
  }
  return { value: raw }
}

// Validates an optional enum query filter. The schema is passed as an opaque
// ZodType and the parsed value is narrowed to its output type, so this stays
// correct against zod v4's ZodEnum (parameterised by an EnumLike, not a tuple).
function optionalEnumFilter<S extends z.ZodType>(
  c: Context,
  name: string,
  schema: S,
  detail: string,
): { value?: z.infer<S> } | { error: Response } {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return { value: undefined }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { error: c.json({ error: 'invalid_query', detail }, 400) }
  }
  return { value: parsed.data }
}

// ── Billing router ─────────────────────────────────────────────────────────

export function createVideoBillingRouter(deps: VideoBillingRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/billing')
  const auth = makeAuth(env)

  // GET /api/video/billing/profiles - list fee profiles for the tenant.
  app.get('/profiles', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const customerId = optionalUuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    let active: boolean | undefined
    const rawActive = c.req.query('active')
    if (rawActive !== undefined && rawActive !== '') {
      if (rawActive !== 'true' && rawActive !== 'false') {
        return c.json({ error: 'invalid_query', detail: 'active must be true or false' }, 400)
      }
      active = rawActive === 'true'
    }

    const profiles = await listBillingProfiles(gate.identity, {
      customerId: customerId.value,
      active,
    })
    return c.json({ profiles, total: profiles.length })
  })

  // POST /api/video/billing/profiles - upsert the customer's active profile.
  app.post('/profiles', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId, userId } = gate.identity

    const body = await c.req.json().catch(() => null)
    const parsed = ProfileWriteSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) },
        400,
      )
    }

    const profile = await upsertActiveBillingProfile(tenantId, {
      customerId: parsed.data.customerId,
      ownerId: parsed.data.ownerId ?? userId,
      feeModel: parsed.data.feeModel,
      managementFeePct: parsed.data.managementFeePct,
      flatAmount: parsed.data.flatAmount,
      currency: parsed.data.currency,
      billingPeriod: parsed.data.billingPeriod,
      billOnSponsorship: parsed.data.billOnSponsorship,
      notes: parsed.data.notes,
      validFrom: parsed.data.validFrom,
      validTo: parsed.data.validTo,
    })
    return c.json({ profile }, 201)
  })

  // DELETE /api/video/billing/profiles/:id - retire (soft-deactivate) a profile.
  app.delete('/profiles/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const profile = await deactivateBillingProfile(gate.identity, id.data)
    if (!profile) return c.json({ error: 'not_found' }, 404)
    return c.json({ profile })
  })

  // GET /api/video/billing/invoices - list invoices for the tenant.
  app.get('/invoices', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const customerId = optionalUuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const status = optionalEnumFilter(
      c,
      'status',
      InvoiceStatusSchema,
      'status must be draft, approved, issued, or void',
    )
    if ('error' in status) return status.error

    const from = optionalDateFilter(c, 'from')
    if ('error' in from) return from.error

    const to = optionalDateFilter(c, 'to')
    if ('error' in to) return to.error

    const invoices = await listInvoices(gate.identity, {
      customerId: customerId.value,
      status: status.value,
      from: from.value,
      to: to.value,
    })
    return c.json({ invoices, total: invoices.length })
  })

  // GET /api/video/billing/invoices/:id - fetch a single invoice.
  app.get('/invoices/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const invoice = await getInvoice(gate.identity, id.data)
    if (!invoice) return c.json({ error: 'not_found' }, 404)
    return c.json({ invoice })
  })

  // POST /api/video/billing/invoices - generate an invoice for a period.
  app.post('/invoices', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const body = await c.req.json().catch(() => null)
    const parsed = GenerateInvoiceSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) },
        400,
      )
    }

    const outcome = await generateInvoice(gate.identity, {
      customerId: parsed.data.customerId,
      periodStart: parsed.data.periodStart,
      periodEnd: parsed.data.periodEnd,
    })

    if (outcome.ok) return c.json({ invoice: outcome.invoice }, 201)
    return c.json({ error: outcome.reason }, 422)
  })

  // draft -> approved -> issued, plus void. Each returns the fresh row or 404.
  const transitionInvoice = (status: InvoiceStatus) => async (c: Context) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const invoice = await setInvoiceStatus(gate.identity, id.data, status)
    if (!invoice) return c.json({ error: 'not_found' }, 404)
    return c.json({ invoice })
  }

  app.post('/invoices/:id/approve', transitionInvoice('approved'))
  app.post('/invoices/:id/issue', transitionInvoice('issued'))
  app.post('/invoices/:id/void', transitionInvoice('void'))

  return app
}

// ── Alerts router ──────────────────────────────────────────────────────────

export function createVideoAlertsRouter(deps: VideoAlertsRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/alerts')
  const auth = makeAuth(env)

  // GET /api/video/alerts - list alerts for the tenant.
  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const status = optionalEnumFilter(
      c,
      'status',
      AlertStatusSchema,
      'status must be open, acknowledged, or dismissed',
    )
    if ('error' in status) return status.error

    const kind = optionalEnumFilter(
      c,
      'kind',
      AlertKindSchema,
      'kind must be revenue_drop, revenue_spike, new_sponsorship, or sync_failure',
    )
    if ('error' in kind) return kind.error

    const channelId = optionalUuidFilter(c, 'channelId')
    if ('error' in channelId) return channelId.error

    const customerId = optionalUuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const alerts = await listRevenueAlerts(gate.identity, {
      status: status.value,
      kind: kind.value,
      channelId: channelId.value,
      customerId: customerId.value,
    })
    return c.json({ alerts, total: alerts.length })
  })

  // GET /api/video/alerts/:id - fetch a single alert.
  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const alert = await getRevenueAlert(gate.identity, id.data)
    if (!alert) return c.json({ error: 'not_found' }, 404)
    return c.json({ alert })
  })

  // open -> acknowledged | dismissed. Each returns the fresh row or 404.
  const transitionAlert = (status: RevenueAlertStatus) => async (c: Context) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const alert = await setRevenueAlertStatus(gate.identity, id.data, status)
    if (!alert) return c.json({ error: 'not_found' }, 404)
    return c.json({ alert })
  }

  app.post('/:id/acknowledge', transitionAlert('acknowledged'))
  app.post('/:id/dismiss', transitionAlert('dismissed'))

  // POST /api/video/alerts/scan - run detection. Returns {created, skipped}; it
  // only produces rows, it never sends anything.
  app.post('/scan', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId } = gate.identity

    const body = await c.req.json().catch(() => null)
    let thresholds: { dropPct: number; spikePct: number } | undefined
    if (body !== null) {
      const parsed = ScanSchema.safeParse(body)
      if (!parsed.success) {
        return c.json(
          { error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) },
          400,
        )
      }
      thresholds = parsed.data.thresholds
    }

    const result = await detectRevenueAlerts(tenantId, thresholds ? { thresholds } : undefined)
    return c.json({ created: result.created, skipped: result.skipped })
  })

  return app
}

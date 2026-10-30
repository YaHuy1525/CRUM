// ── Revenue read-tools (Phase 6) ──────────────────────────────────────────
//
// Five READ-ONLY Mastra tools so the chat agent can answer revenue / alert /
// invoice questions. All of them are tenant-scoped through the request context
// (TenantRequestContextSchema) and only ever read: no writes, no side effects,
// no mutation of channels, invoices or alerts.
//
// Arg-passing asymmetry (mirrors the DB layers):
//   * listVideoChannels / sumEarningsByChannel / sumRevenueTotals take the
//     tenantId string (tenant-scoped CRUD/aggregation).
//   * listInvoices / listRevenueAlerts take the full TenantRequestContext,
//     because they additionally apply per-user visibility rules.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { listVideoChannels } from '../../db/video-queries'
import { sumEarningsByChannel, sumRevenueTotals } from '../../db/revenue-queries'
import { listInvoices } from '../../db/billing'
import { listRevenueAlerts } from '../../db/alerts'

const nullableString = z.string().nullable()

const platformEnum = z.enum(['youtube', 'tiktok', 'instagram', 'twitch'])
const ownershipEnum = z.enum(['self', 'client'])
const channelStatusEnum = z.enum(['active', 'disconnected', 'suspended'])
const invoiceStatusEnum = z.enum(['draft', 'approved', 'issued', 'void'])
const alertStatusEnum = z.enum(['open', 'acknowledged', 'dismissed'])

// The driver hands back `date`/`timestamptz` columns as JS Dates. The output
// schemas below declare strings, so every timestamp crossing a tool boundary is
// normalised here rather than failing output validation at runtime.
// Measured 2026-10-30: list_channels rejected any channel that had ever synced.
/** A UTC ISO string for a `timestamptz`. */
function stamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new TypeError(`expected a timestamp, got ${String(value)}`)
}

/**
 * A `date` rendered as YYYY-MM-DD from its own parts. `.toISOString()` is wrong
 * here: pg builds the Date at LOCAL midnight, so a server in UTC+10 would report
 * 2026-10-01 as 2026-09-30T14:00:00.000Z.
 */
function day(value: unknown): string {
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0')
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'string') return value.slice(0, 10)
  throw new TypeError(`expected a date, got ${String(value)}`)
}

/** The same, for the columns that are nullable (`video_channels.last_sync_at`). */
function stampOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return stamp(value)
}

export const listChannelsTool = createTool({
  id: 'revenue.list_channels',
  title: 'List revenue channels',
  description:
    'List the video channels a tenant tracks (platform, ownership, status, linked customer, ' +
    'last sync, whether an OAuth token is connected). Read-only: it can only filter and list; ' +
    'it cannot mutate channels or tokens. Use it to answer "which channels are connected" or to ' +
    'find a channel id before drilling into earnings or alerts.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    platform: platformEnum.optional(),
    ownership: ownershipEnum.optional(),
    status: channelStatusEnum.optional(),
  }),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      channel_name: nullableString,
      platform: platformEnum,
      ownership: ownershipEnum,
      status: channelStatusEnum,
      customer_id: nullableString,
      last_sync_at: z.string().nullable(),
      has_oauth_token: z.boolean(),
    }),
  ),
  execute: async (input, context) => {
    return context.observe.span('revenue.list_channels', async () => {
      const rc = context.requestContext.all
      const rows = await listVideoChannels(rc.tenantId, {
        platform: input.platform,
        ownership: input.ownership,
        status: input.status,
      })
      return rows.map((r) => ({
        id: r.id,
        channel_name: r.channel_name,
        platform: r.platform,
        ownership: r.ownership,
        status: r.status,
        customer_id: r.customer_id,
        last_sync_at: stampOrNull(r.last_sync_at),
        has_oauth_token: Boolean(r.oauth_token_id),
      }))
    })
  },
})

export const sumEarningsTool = createTool({
  id: 'revenue.sum_earnings',
  title: 'Sum earnings by channel',
  description:
    'Roll up each of a tenant’s tracked channels’ platform earnings over an optional inclusive ' +
    'date range (YYYY-MM-DD). One row per channel, ordered by revenue descending; channels with ' +
    'no earnings appear with total 0. Money is an exact decimal STRING — do not coerce it to a ' +
    'float. Read-only aggregation: it cannot mutate earnings or channels.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  outputSchema: z.array(
    z.object({
      channel_id: z.string(),
      channel_name: nullableString,
      platform: platformEnum,
      ownership: ownershipEnum,
      status: channelStatusEnum,
      currency: nullableString,
      total_revenue: z.string(),
      total_views: z.number(),
      last_sync_at: z.string().nullable(),
    }),
  ),
  execute: async (input, context) => {
    return context.observe.span('revenue.sum_earnings', async () => {
      const rc = context.requestContext.all
      return sumEarningsByChannel(rc.tenantId, { from: input.from, to: input.to })
    })
  },
})

export const revenueTotalsTool = createTool({
  id: 'revenue.revenue_totals',
  title: 'Tenant revenue totals',
  description:
    'One tenant-wide revenue roll-up for dashboard-style questions: platform earnings plus ' +
    'CONFIRMED sponsorship income and their grand total over an optional inclusive date range ' +
    '(YYYY-MM-DD). All money values are exact decimal strings. Read-only: it cannot mutate ' +
    'earnings, sponsorships or any other data.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  outputSchema: z.object({
    currency: nullableString,
    platform_revenue: z.string(),
    sponsorship_revenue: z.string(),
    grand_total: z.string(),
    channels_with_earnings: z.number(),
  }),
  execute: async (input, context) => {
    return context.observe.span('revenue.revenue_totals', async () => {
      const rc = context.requestContext.all
      return sumRevenueTotals(rc.tenantId, { from: input.from, to: input.to })
    })
  },
})

export const listInvoicesTool = createTool({
  id: 'revenue.list_invoices',
  title: 'List invoices',
  description:
    'List the billing invoices visible to the requesting user within the tenant, newest period ' +
    'first, optionally narrowed by customer and status (draft/approved/issued/void). Amounts are ' +
    'numbers already computed by the billing layer. Read-only: it cannot create, approve, issue ' +
    'or void invoices.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid().optional(),
    status: invoiceStatusEnum.optional(),
  }),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      customer_id: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      currency: z.string(),
      computed_amount: z.number(),
      gross_revenue: z.number(),
      fee_model: z.string(),
      status: invoiceStatusEnum,
      invoice_number: nullableString,
    }),
  ),
  execute: async (input, context) => {
    return context.observe.span('revenue.list_invoices', async () => {
      const rc = context.requestContext.all
      const rows = await listInvoices(rc, {
        customerId: input.customerId,
        status: input.status,
      })
      return rows.map((r) => ({
        id: r.id,
        customer_id: r.customer_id,
        period_start: day(r.period_start),
        period_end: day(r.period_end),
        currency: r.currency,
        computed_amount: r.computed_amount,
        gross_revenue: r.gross_revenue,
        fee_model: r.fee_model,
        status: r.status,
        invoice_number: r.invoice_number,
      }))
    })
  },
})

export const listAlertsTool = createTool({
  id: 'revenue.list_alerts',
  title: 'List revenue alerts',
  description:
    'List the revenue alerts (drops, spikes, anomalies) visible to the requesting user in the ' +
    'tenant, newest first, optionally narrowed by status (open/acknowledged/dismissed) or ' +
    'channel id. Read-only: acknowledging or dismissing an alert is a separate write path — this ' +
    'tool cannot mutate anything.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    status: alertStatusEnum.optional(),
    channelId: z.string().uuid().optional(),
  }),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      channel_id: nullableString,
      customer_id: nullableString,
      kind: z.string(),
      severity: z.string(),
      message: z.string(),
      status: alertStatusEnum,
      created_at: z.string(),
    }),
  ),
  execute: async (input, context) => {
    return context.observe.span('revenue.list_alerts', async () => {
      const rc = context.requestContext.all
      const rows = await listRevenueAlerts(rc, {
        status: input.status,
        channelId: input.channelId,
      })
      return rows.map((a) => ({
        id: a.id,
        channel_id: a.channel_id,
        customer_id: a.customer_id,
        kind: a.kind,
        severity: a.severity,
        message: a.message,
        status: a.status,
        created_at: stamp(a.created_at),
      }))
    })
  },
})

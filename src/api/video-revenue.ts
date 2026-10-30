import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  sumEarningsByChannel,
  earningsSeries,
  sumRevenueTotals,
  countOpenRevenueAlerts,
} from '../db/revenue-queries'
import { getVideoChannelById } from '../db/video-queries'

// ── Video revenue: read-only REST surface (Phase 6) ────────────────────────
//
// Exposes the shared aggregation layer in ../db/revenue-queries to the console
// dashboard. This router does NOT mutate anything and does not re-implement the
// revenue maths — every earnings number comes straight from the aggregation
// module so the REST plane and the Mastra read-tools cannot drift. Money is
// decimal-as-TEXT and is passed through UNCHANGED (never Number()-ed).

export interface VideoRevenueRouterDeps {
  env: CrumEnv
}

const IdSchema = z.string().uuid()

// The optional inclusive date window shared by both endpoints. Absent bounds are
// echoed back as null but handed to the db layer as `undefined` so revenue-queries
// builds no date predicate for them.
type DateRangeArg = { from?: string; to?: string }
type RangeResult = {
  range: DateRangeArg
  from: string | null
  to: string | null
}

type IdentityOrError = { identity: TenantRequestContext } | { error: Response }
type ParsedRange = { value: RangeResult } | { error: Response }

/**
 * A `YYYY-MM-DD` string is accepted only if it matches the shape AND is a real
 * calendar date. The shape guard is the spec'd `/^\d{4}-\d{2}-\d{2}$/`; the
 * calendar guard rejects impossible dates (e.g. `2026-13-40`) before they reach
 * Postgres, where `::date` would throw a 500 instead of our 400.
 */
function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function createVideoRevenueRouter(deps: VideoRevenueRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/revenue')

  const auth = async (c: Context): Promise<IdentityOrError> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  // Validate the optional from/to query pair. A missing or empty value is treated
  // as absent; a present value that fails the date guard yields a 400.
  const parseRange = (c: Context): ParsedRange => {
    const rawFrom = c.req.query('from')
    const rawTo = c.req.query('to')

    const from = rawFrom !== undefined && rawFrom !== '' ? rawFrom : null
    const to = rawTo !== undefined && rawTo !== '' ? rawTo : null

    if (from !== null && !isValidYmd(from)) {
      return {
        error: c.json({ error: 'invalid_query', detail: 'from and to must be YYYY-MM-DD' }, 400),
      }
    }
    if (to !== null && !isValidYmd(to)) {
      return {
        error: c.json({ error: 'invalid_query', detail: 'from and to must be YYYY-MM-DD' }, 400),
      }
    }

    return {
      value: {
        range: { from: from ?? undefined, to: to ?? undefined },
        from,
        to,
      },
    }
  }

  // GET /api/video/revenue/overview - tenant-wide roll-up for the dashboard header.
  app.get('/overview', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = parseRange(c)
    if ('error' in parsed) return parsed.error
    const { range, from, to } = parsed.value

    try {
      const [totals, channels, openAlerts] = await Promise.all([
        sumRevenueTotals(gate.identity.tenantId, range),
        sumEarningsByChannel(gate.identity.tenantId, range),
        countOpenRevenueAlerts(gate.identity.tenantId),
      ])
      return c.json({
        range: { from, to },
        totals,
        channels,
        openAlerts,
      })
    } catch (err) {
      console.error('[CRUM] video revenue overview failed:', err)
      return c.json(
        { error: 'internal_error', detail: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  // GET /api/video/revenue/channels/:id/series - one channel's daily earnings sparkline.
  app.get('/channels/:id/series', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'invalid_id', detail: 'id must be a uuid' }, 400)
    }

    const parsed = parseRange(c)
    if ('error' in parsed) return parsed.error
    const { range } = parsed.value

    try {
      // Existence/tenancy gate first: a foreign or missing id is a 404, and the
      // series is only ever read for a channel the tenant actually owns.
      const channel = await getVideoChannelById(gate.identity.tenantId, id.data)
      if (!channel) return c.json({ error: 'not_found' }, 404)

      const points = await earningsSeries(gate.identity.tenantId, id.data, range)
      return c.json({ channel_id: id.data, points })
    } catch (err) {
      console.error('[CRUM] video revenue series failed:', err)
      return c.json(
        { error: 'internal_error', detail: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  return app
}

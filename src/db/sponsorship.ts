// ── Sponsorship income (Phase 4): database query layer ─────────────────────
//
// Raw SQL against pg (parameterized, tenant-scoped).  Row types come from
// ./types; the table contract lives in migrations/0013_crum_sponsorship.sql.
//
// Two conventions govern this module:
//   * Tenant isolation: every query filters on tenant_id (mirrors video-queries).
//   * Visibility: reads/writes honour the same rule as documents.docVisibility,
//     aliased to `sponsorship_income s` — an admin sees all tenant rows; a
//     normal user sees rows they own, rows with no linked customer, or rows
//     linked to a customer they own / are a team member of.
//
// The scanner writes suggestions (status='suggested'); a human flips them to
// 'confirmed'/'dismissed'.  Money columns are decimal, so amount/confidence are
// coerced numeric->number before leaving this layer (SponsorshipRow types them
// number|null), while sumSponsorship keeps the aggregate as text.

import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'
import type {
  SponsorshipRow,
  SponsorshipSource,
  SponsorshipStatus,
  DealType,
} from './types'

// Re-export types so consumers (API routers / workflow) can import from here.
export type {
  SponsorshipRow,
  SponsorshipSource,
  SponsorshipStatus,
  DealType,
} from './types'

// ── helpers ────────────────────────────────────────────────────────────────

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

/**
 * pg returns decimal/numeric columns as strings.  SponsorshipRow declares
 * amount & confidence as number|null, so we coerce on the way out.  A value
 * that is already numeric (or absent) is handled too.
 */
function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/** Raw row shape from the driver before decimal->number coercion. */
type SponsorshipRawRow = Omit<SponsorshipRow, 'amount' | 'confidence'> & {
  amount: string | number | null
  confidence: string | number | null
}

function mapSponsorshipRow(raw: SponsorshipRawRow): SponsorshipRow {
  return {
    ...raw,
    amount: toNumberOrNull(raw.amount),
    confidence: toNumberOrNull(raw.confidence),
  }
}

/**
 * Visibility predicate for `sponsorship_income s`, mirroring documents'
 * docVisibility.  Params align with the `$1`/`$2` placeholders used in the SQL.
 */
function sponsorshipVisibility(
  context: TenantRequestContext,
): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 's.tenant_id = $1', params: [context.tenantId] }
  }
  return {
    sql: `s.tenant_id = $1 AND (
            s.owner_id = $2
            OR s.customer_id IS NULL
            OR s.customer_id IN (
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )
          )`,
    params: [context.tenantId, context.userId],
  }
}

// ── write input ────────────────────────────────────────────────────────────

export interface SponsorshipWrite {
  ownerId?: string | null
  channelId?: string | null
  customerId?: string | null
  contactId?: string | null
  brandName?: string | null
  brandEmail?: string | null
  dealType?: DealType | null
  amount?: number | null
  currency?: string | null
  dealDate?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  source?: SponsorshipSource
  sourceRef?: string | null
  contentHash: string
  confidence?: number | null
  status?: SponsorshipStatus
  rawExtract?: unknown
  notes?: string | null
}

/**
 * Insert (or de-dup) a sponsorship suggestion.
 *
 * (tenant_id, content_hash) is unique, so re-scanning the same email/message
 * only bumps updated_at instead of creating a duplicate row.  Defaults:
 * source='email', status='suggested', currency='USD' (column is NOT NULL).
 * Returns the persisted id/status with confidence coerced numeric->number.
 */
export async function insertSponsorshipSuggestion(
  tenantId: string,
  data: SponsorshipWrite,
): Promise<{ id: string; status: SponsorshipStatus; confidence: number | null }> {
  const raw = await queryRow<Pick<SponsorshipRow, 'id' | 'status'> & { confidence: string | number | null }>(
    `INSERT INTO sponsorship_income
       (tenant_id, owner_id, channel_id, customer_id, contact_id, brand_name, brand_email,
        deal_type, amount, currency, deal_date, period_start, period_end, source, source_ref,
        content_hash, confidence, status, raw_extract, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13::date,
             $14, $15, $16, $17, $18, $19::jsonb, $20)
     ON CONFLICT (tenant_id, content_hash) DO UPDATE SET updated_at = now()
     RETURNING id, status, confidence`,
    [
      tenantId,
      data.ownerId ?? null,
      data.channelId ?? null,
      data.customerId ?? null,
      data.contactId ?? null,
      data.brandName ?? null,
      data.brandEmail ?? null,
      data.dealType ?? null,
      data.amount ?? null,
      data.currency ?? 'USD',
      data.dealDate ?? null,
      data.periodStart ?? null,
      data.periodEnd ?? null,
      data.source ?? 'email',
      data.sourceRef ?? null,
      data.contentHash,
      data.confidence ?? null,
      data.status ?? 'suggested',
      JSON.stringify(data.rawExtract ?? {}),
      data.notes ?? null,
    ],
  )
  if (!raw) throw new Error('sponsorship_income insert returned no row')
  return { id: raw.id, status: raw.status, confidence: toNumberOrNull(raw.confidence) }
}

async function queryRow<T>(sql: string, params: unknown[]): Promise<T | null> {
  const rows = await queryRows<T>(sql, params)
  return rows[0] ?? null
}

// ── reads ──────────────────────────────────────────────────────────────────

export interface SponsorshipFilters {
  status?: SponsorshipStatus
  channelId?: string
  customerId?: string
  dealType?: DealType
}

/**
 * List sponsorship rows visible to `context`, newest first.  Optional filters
 * narrow by status / channel / customer / deal type.  amount & confidence are
 * returned as numbers (or null).
 */
export async function listSponsorship(
  context: TenantRequestContext,
  filters: SponsorshipFilters = {},
  limit = 50,
): Promise<SponsorshipRow[]> {
  const vis = sponsorshipVisibility(context)
  const conditions: string[] = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.status) {
    idx++
    conditions.push(`s.status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.channelId) {
    idx++
    conditions.push(`s.channel_id = $${idx}`)
    params.push(filters.channelId)
  }
  if (filters.customerId) {
    idx++
    conditions.push(`s.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.dealType) {
    idx++
    conditions.push(`s.deal_type = $${idx}`)
    params.push(filters.dealType)
  }

  idx++
  params.push(limit)

  const rows = await queryRows<SponsorshipRawRow>(
    `SELECT s.* FROM sponsorship_income s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $${idx}`,
    params,
  )
  return rows.map(mapSponsorshipRow)
}

export async function getSponsorship(
  context: TenantRequestContext,
  id: string,
): Promise<SponsorshipRow | null> {
  const vis = sponsorshipVisibility(context)
  const params = [...vis.params, id]
  const raw = await queryRow<SponsorshipRawRow>(
    `SELECT s.* FROM sponsorship_income s
      WHERE s.id = $${params.length} AND ${vis.sql}
      LIMIT 1`,
    params,
  )
  return raw ? mapSponsorshipRow(raw) : null
}

// ── status transition ──────────────────────────────────────────────────────

/**
 * Flip a suggestion's status (confirm/dismiss/reopen), scoped by visibility.
 * Returns the updated id/status, or null when the row is missing or hidden
 * from `context`.
 */
export async function setSponsorshipStatus(
  context: TenantRequestContext,
  id: string,
  status: SponsorshipStatus,
): Promise<{ id: string; status: SponsorshipStatus } | null> {
  const vis = sponsorshipVisibility(context)
  const params = [...vis.params, status, id]
  const statusIdx = params.length - 1
  const idIdx = params.length
  const rows = await queryRows<{ id: string; status: SponsorshipStatus }>(
    `UPDATE sponsorship_income AS s
        SET status = $${statusIdx}, updated_at = now()
      WHERE s.id = $${idIdx} AND ${vis.sql}
      RETURNING s.id, s.status`,
    params,
  )
  return rows[0] ?? null
}

// ── aggregates ─────────────────────────────────────────────────────────────

export interface SponsorshipSumFilters {
  customerId?: string
  channelId?: string
  status?: SponsorshipStatus
  from?: string
  to?: string
}

export interface SponsorshipSumRow {
  brand_name: string | null
  deal_count: number
  total: string | null
  currency: string | null
}

/**
 * Sum confirmed sponsorship per brand (mirrors documents.sumInvoices).  When
 * `filters.status` is undefined the aggregate defaults to 'confirmed' so it
 * reflects billing-grade deals only.  `total` stays text (exact decimal).
 */
export async function sumSponsorship(
  context: TenantRequestContext,
  filters: SponsorshipSumFilters = {},
): Promise<SponsorshipSumRow[]> {
  const vis = sponsorshipVisibility(context)
  const conditions = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  idx++
  conditions.push(`s.status = $${idx}`)
  params.push(filters.status ?? 'confirmed')

  if (filters.customerId) {
    idx++
    conditions.push(`s.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.channelId) {
    idx++
    conditions.push(`s.channel_id = $${idx}`)
    params.push(filters.channelId)
  }
  if (filters.from) {
    idx++
    conditions.push(`s.deal_date >= $${idx}::date`)
    params.push(filters.from)
  }
  if (filters.to) {
    idx++
    conditions.push(`s.deal_date <= $${idx}::date`)
    params.push(filters.to)
  }

  return queryRows<SponsorshipSumRow>(
    `SELECT s.brand_name,
            count(*)::int AS deal_count,
            sum(s.amount)::text AS total,
            min(s.currency) AS currency
       FROM sponsorship_income s
      WHERE ${conditions.join(' AND ')}
      GROUP BY s.brand_name
      ORDER BY sum(s.amount) DESC NULLS LAST, s.brand_name ASC`,
    params,
  )
}

// ── CRM resolution ─────────────────────────────────────────────────────────

export interface ChannelBrandHint {
  email?: string | null
  brandName?: string | null
  channelHint?: string | null
  platform?: string | null
}

/**
 * Best-effort resolution of a brand hint to ONE video_channels row id, using
 * the same ambiguity rule as documents.resolveCustomerByEntity: fetch LIMIT 2
 * and only accept a match when exactly one row is found (null for 0 or >1).
 *
 * Match priority: a name (brandName ?? channelHint) is compared against
 * video_channels.channel_name and the linked customers.company; when no name
 * is present, email is compared against the linked customer's email.  `platform`
 * is an additional filter, never a match on its own.  Returns null when there
 * is no name/email to key on.
 */
export async function resolveChannelByBrand(
  tenantId: string,
  hint: ChannelBrandHint,
): Promise<string | null> {
  const name = hint.brandName ?? hint.channelHint ?? null
  if (!name && !hint.email) return null

  const conditions: string[] = ['v.tenant_id = $1']
  const params: unknown[] = [tenantId]
  let idx = 1

  if (hint.platform) {
    idx++
    conditions.push(`v.platform = $${idx}`)
    params.push(hint.platform)
  }

  if (name) {
    idx++
    conditions.push(
      `(lower(btrim(v.channel_name)) = lower(btrim($${idx}))
        OR lower(btrim(c.company)) = lower(btrim($${idx})))`,
    )
    params.push(name)
  } else {
    // Email-only: resolve through the channel's linked customer.
    idx++
    conditions.push(`lower(c.email) = lower($${idx})`)
    params.push(hint.email)
  }

  const rows = await queryRows<{ id: string }>(
    `SELECT v.id
       FROM video_channels v
       LEFT JOIN customers c ON c.id = v.customer_id
      WHERE ${conditions.join(' AND ')}
      LIMIT 2`,
    params,
  )

  return rows.length === 1 ? rows[0]!.id : null
}

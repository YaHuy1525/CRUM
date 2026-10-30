// ── Video billing (Phase 5): database query layer ──────────────────────────
//
// Raw SQL against pg (parameterized, tenant-scoped).  Row types come from
// ./types; the table contract lives in migrations/0014_crum_billing.sql.
//
// Two conventions govern this module:
//   * Tenant isolation: every query filters on tenant_id (mirrors sponsorship
//     and video-queries).
//   * Visibility: reads/writes honour the same rule as documents.docVisibility,
//     aliased per table (`p` for client_billing_profiles, `i` for
//     billing_invoices) — an admin sees all tenant rows; a normal user sees
//     rows whose customer_id belongs to a customer they own or are a team
//     member of.  Both tables require a customer, so there is no
//     "customer_id IS NULL" branch like sponsorship has.
//
// Invoices use a LOCAL lifecycle (draft -> approved -> issued, plus void),
// NOT the governance pending_writes path: pending_writes.commitWithReceipt
// only understands a fixed whitelist of objectTypes, and billing artifacts are
// a different kind of thing (see the migration header).  Nothing here is
// auto-sent; every state change is made by a human through the API.
//
// Money/percentage columns are decimal, so they are coerced numeric->number
// before leaving this layer (the ./types row shapes declare them as
// number|number|null), while raw SQL aggregates keep text where used.

import { getDbClient } from './client'
import { getVideoEarningsByChannel, listVideoChannels } from './video-queries'
import type { TenantRequestContext } from '../mastra/tenant-context'
import type {
  ClientBillingProfile,
  BillingInvoice,
  BillingFeeModel,
  BillingPeriod,
  InvoiceStatus,
} from './types'

// Re-export types so consumers (API routers / other modules) import from here.
export type {
  ClientBillingProfile,
  BillingInvoice,
  BillingFeeModel,
  BillingPeriod,
  InvoiceStatus,
} from './types'

// ── helpers ────────────────────────────────────────────────────────────────

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

async function queryRow<T>(sql: string, params: unknown[]): Promise<T | null> {
  const rows = await queryRows<T>(sql, params)
  return rows[0] ?? null
}

/**
 * pg returns decimal/numeric columns as strings.  The row types declare money
 * as number|number|null, so we coerce on the way out.  A value that is already
 * numeric (or absent) is handled too.
 */
function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/** Non-NULL money columns default to a number (0 when the driver sends null). */
function toNumber(value: string | number | null | undefined, fallback = 0): number {
  const n = toNumberOrNull(value)
  return n ?? fallback
}

/** line_items is jsonb (pg parses it), but guard a raw-string arrival anyway. */
function toJsonItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[]
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * The driver parses `date` columns into a JS Date at LOCAL midnight, so
 * `.toISOString()` would move the calendar day on any non-UTC server
 * (2026-10-01 becomes 2026-09-30T14:00:00.000Z at UTC+10). The row types declare
 * plain 'YYYY-MM-DD' strings, so dates are rendered from their local parts.
 */
function dateText(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0')
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'string') return value.slice(0, 10)
  return value === null || value === undefined ? '' : String(value)
}

function dateTextOrNull(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return dateText(value) || null
}

/** `timestamptz` columns arrive as Dates; UTC ISO is the correct, unambiguous form. */
function isoText(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (value === null || value === undefined) return ''
  return String(value)
}

function isoTextOrNull(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return isoText(value) || null
}

/** Raw row shape from the driver before decimal->number coercion (profiles). */
type ProfileRawRow = Omit<ClientBillingProfile, 'management_fee_pct' | 'flat_amount'> & {
  management_fee_pct: string | number | null
  flat_amount: string | number | null
}

function mapProfileRow(raw: ProfileRawRow): ClientBillingProfile {
  return {
    ...raw,
    management_fee_pct: toNumberOrNull(raw.management_fee_pct),
    flat_amount: toNumberOrNull(raw.flat_amount),
    valid_from: dateText(raw.valid_from),
    valid_to: dateTextOrNull(raw.valid_to),
    created_at: isoText(raw.created_at),
    updated_at: isoText(raw.updated_at),
  }
}

/** Raw row shape from the driver before decimal->number coercion (invoices). */
type InvoiceRawRow = Omit<
  BillingInvoice,
  | 'platform_revenue' | 'sponsorship_revenue' | 'gross_revenue' | 'computed_amount'
  | 'fee_pct' | 'fee_flat_amount' | 'line_items'
> & {
  platform_revenue: string | number | null
  sponsorship_revenue: string | number | null
  gross_revenue: string | number | null
  computed_amount: string | number | null
  fee_pct: string | number | null
  fee_flat_amount: string | number | null
  line_items: unknown
}

function mapInvoiceRow(raw: InvoiceRawRow): BillingInvoice {
  return {
    ...raw,
    channel_ids: Array.isArray(raw.channel_ids) ? raw.channel_ids : [],
    period_start: dateText(raw.period_start),
    period_end: dateText(raw.period_end),
    platform_revenue: toNumber(raw.platform_revenue),
    sponsorship_revenue: toNumber(raw.sponsorship_revenue),
    gross_revenue: toNumber(raw.gross_revenue),
    computed_amount: toNumber(raw.computed_amount),
    fee_pct: toNumberOrNull(raw.fee_pct),
    fee_flat_amount: toNumberOrNull(raw.fee_flat_amount),
    line_items: toJsonItems(raw.line_items),
    issued_at: isoTextOrNull(raw.issued_at),
    created_at: isoText(raw.created_at),
    updated_at: isoText(raw.updated_at),
  }
}

/**
 * Visibility predicate for `client_billing_profiles p`, mirroring
 * documents.docVisibility.  Params align with the `$1`/`$2` placeholders.
 */
function profileVisibility(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'p.tenant_id = $1', params: [context.tenantId] }
  }
  return {
    sql: `p.tenant_id = $1 AND p.customer_id IN (
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )`,
    params: [context.tenantId, context.userId],
  }
}

/** Same rule for `billing_invoices i`, via the linked customer. */
function invoiceVisibility(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'i.tenant_id = $1', params: [context.tenantId] }
  }
  return {
    sql: `i.tenant_id = $1 AND i.customer_id IN (
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )`,
    params: [context.tenantId, context.userId],
  }
}

// ── billing profile writes ─────────────────────────────────────────────────

/** Write input for a billing profile. */
export interface BillingProfileWrite {
  customerId: string
  ownerId?: string | null
  feeModel?: BillingFeeModel
  managementFeePct?: number | null
  flatAmount?: number | null
  currency?: string
  billingPeriod?: BillingPeriod
  billOnSponsorship?: boolean
  notes?: string | null
  /** ISO date; when omitted the DB default (current_date) applies. */
  validFrom?: string
  validTo?: string | null
}

/**
 * Retire any currently-active profile for the customer and insert the new one
 * as active.  The partial unique index uq_billing_profile_active_customer only
 * allows one active row per (tenant, customer), so the retire must land first.
 * getDbClient() exposes a plain pool with no transaction helper (same as the
 * sponsorship/video layers), so this is two awaited queries in order.
 */
export async function upsertActiveBillingProfile(
  tenantId: string,
  data: BillingProfileWrite,
): Promise<ClientBillingProfile> {
  await getDbClient().query(
    `UPDATE client_billing_profiles
        SET active = false, updated_at = now()
      WHERE tenant_id = $1 AND customer_id = $2 AND active`,
    [tenantId, data.customerId],
  )

  const raw = await queryRow<ProfileRawRow>(
    `INSERT INTO client_billing_profiles
       (tenant_id, customer_id, owner_id, fee_model, management_fee_pct, flat_amount,
        currency, billing_period, bill_on_sponsorship, notes, valid_from, valid_to, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::date, current_date), $12::date, true)
     RETURNING *`,
    [
      tenantId,
      data.customerId,
      data.ownerId ?? null,
      data.feeModel ?? 'pct_of_revenue',
      data.managementFeePct ?? null,
      data.flatAmount ?? null,
      data.currency ?? 'USD',
      data.billingPeriod ?? 'monthly',
      data.billOnSponsorship ?? true,
      data.notes ?? null,
      data.validFrom ?? null,
      data.validTo ?? null,
    ],
  )
  if (!raw) throw new Error('client_billing_profiles insert returned no row')
  return mapProfileRow(raw)
}

/** The customer's currently-active profile, or null. */
export async function getActiveBillingProfile(
  tenantId: string,
  customerId: string,
): Promise<ClientBillingProfile | null> {
  const raw = await queryRow<ProfileRawRow>(
    `SELECT * FROM client_billing_profiles
      WHERE tenant_id = $1 AND customer_id = $2 AND active
      LIMIT 1`,
    [tenantId, customerId],
  )
  return raw ? mapProfileRow(raw) : null
}

export interface BillingProfileFilters {
  customerId?: string
  active?: boolean
}

/**
 * List billing profiles visible to `context`, newest first.  Optional filters
 * narrow by customer / active flag.  Money columns are numbers (or null).
 */
export async function listBillingProfiles(
  context: TenantRequestContext,
  filters: BillingProfileFilters = {},
  limit = 50,
): Promise<ClientBillingProfile[]> {
  const vis = profileVisibility(context)
  const conditions: string[] = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`p.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.active !== undefined) {
    idx++
    conditions.push(`p.active = $${idx}`)
    params.push(filters.active)
  }

  idx++
  params.push(limit)

  const rows = await queryRows<ProfileRawRow>(
    `SELECT p.* FROM client_billing_profiles p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${idx}`,
    params,
  )
  return rows.map(mapProfileRow)
}

/**
 * Retire a profile (active = false), scoped by visibility.  Returns the
 * updated row, or null when it is missing or hidden from `context`.
 */
export async function deactivateBillingProfile(
  context: TenantRequestContext,
  id: string,
): Promise<ClientBillingProfile | null> {
  const vis = profileVisibility(context)
  const params = [...vis.params, id]
  const raw = await queryRow<ProfileRawRow>(
    `UPDATE client_billing_profiles AS p
        SET active = false, updated_at = now()
      WHERE p.id = $${params.length} AND ${vis.sql}
      RETURNING p.*`,
    params,
  )
  return raw ? mapProfileRow(raw) : null
}

// ── pure fee math ──────────────────────────────────────────────────────────

export interface FeeBreakdown {
  platformRevenue: number
  sponsorshipRevenue: number
}

export interface FeeResult {
  feeModel: BillingFeeModel
  feePct: number | null
  feeFlatAmount: number | null
  computedAmount: number
  lineItems: Record<string, unknown>[]
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * Deterministic management-fee computation (NO database).  Exported for unit
 * tests and so the workflow layer can preview a fee without writing a draft.
 *
 * basis = platformRevenue + (bill_on_sponsorship ? sponsorshipRevenue : 0),
 * used only by the pct/hybrid components.  fee_pct/fee_flat_amount snapshot
 * the profile's raw parameters for audit; line_items traces the math.
 */
export function computeManagementFee(
  profile: ClientBillingProfile,
  rev: FeeBreakdown,
): FeeResult {
  const feeModel = profile.fee_model
  const feePct = profile.management_fee_pct ?? null
  const feeFlatAmount = profile.flat_amount ?? null
  const currency = profile.currency

  const platform = round2(rev.platformRevenue)
  const sponsorship = round2(rev.sponsorshipRevenue)
  const basis = round2(platform + (profile.bill_on_sponsorship ? sponsorship : 0))

  const usesPct = feeModel === 'pct_of_revenue' || feeModel === 'hybrid'
  const usesFlat = feeModel === 'flat_retainer' || feeModel === 'hybrid'

  let computedAmount: number
  if (feeModel === 'flat_retainer') {
    computedAmount = round2(feeFlatAmount ?? 0)
  } else if (feeModel === 'hybrid') {
    computedAmount = round2((feeFlatAmount ?? 0) + basis * (feePct ?? 0) / 100)
  } else {
    computedAmount = round2(basis * (feePct ?? 0) / 100)
  }

  const lineItems: Record<string, unknown>[] = [
    { label: 'platform_revenue', amount: platform, currency },
  ]
  if (profile.bill_on_sponsorship) {
    lineItems.push({ label: 'sponsorship_revenue', amount: sponsorship, currency })
  }
  if (usesPct) {
    lineItems.push({ label: 'billing_basis', amount: basis, currency })
    lineItems.push({
      label: 'management_fee_pct',
      amount: usesPct ? round2(basis * (feePct ?? 0) / 100) : 0,
      pct: feePct,
      currency,
    })
  }
  if (usesFlat) {
    lineItems.push({ label: 'flat_retainer', amount: feeFlatAmount ?? 0, currency })
  }
  lineItems.push({ label: 'total_fee', amount: computedAmount, currency })

  return { feeModel, feePct, feeFlatAmount, computedAmount, lineItems }
}

// ── invoice generation ─────────────────────────────────────────────────────

export interface GenerateInvoiceParams {
  customerId: string
  /** ISO date strings. */
  periodStart: string
  periodEnd: string
}

export type GenerateInvoiceResult =
  | { ok: true; invoice: BillingInvoice }
  | { ok: false; reason: 'no-active-profile' | 'no-channels' }

/**
 * Generate (or regenerate) a draft invoice for one customer over one period.
 *
 * Reads the customer's active billing profile + the period's revenue
 * aggregates, computes the fee, and upserts billing_invoices keyed on
 * (tenant, customer, period).  The DO UPDATE is guarded with
 * `WHERE billing_invoices.status = 'draft'` so an approved/issued/void
 * invoice is never silently rewritten — regeneration returns the existing row
 * in that case.  Fee parameters are SNAPSHOT onto the row, so later profile
 * edits do not rewrite history.
 */
export async function generateInvoice(
  context: TenantRequestContext,
  params: GenerateInvoiceParams,
): Promise<GenerateInvoiceResult> {
  const tenantId = context.tenantId
  const { customerId, periodStart, periodEnd } = params

  const profile = await getActiveBillingProfile(tenantId, customerId)
  if (!profile) return { ok: false, reason: 'no-active-profile' }

  const channels = await listVideoChannels(tenantId, { customerId, ownership: 'client' })
  if (channels.length === 0) return { ok: false, reason: 'no-channels' }

  // Platform (ad/creator) revenue: sum video_earnings over the period.
  let platformRevenue = 0
  for (const channel of channels) {
    const earnings = await getVideoEarningsByChannel(tenantId, channel.id, {
      start: periodStart,
      end: periodEnd,
    })
    for (const e of earnings) {
      platformRevenue += toNumber(e.estimated_earnings, 0)
    }
  }

  // Confirmed sponsorship income for the customer in the period.  Local
  // aggregate so this module's deps stay limited to ./client, ./video-queries,
  // ./types (sponsorship.ts is deliberately NOT imported here).
  const spSum = await queryRow<{ total: string | number | null }>(
    `SELECT COALESCE(sum(amount), 0)::text AS total
       FROM sponsorship_income
      WHERE tenant_id = $1 AND customer_id = $2 AND status = 'confirmed'
        AND deal_date BETWEEN $3::date AND $4::date`,
    [tenantId, customerId, periodStart, periodEnd],
  )
  const sponsorshipRevenue = toNumber(spSum?.total, 0)

  const grossRevenue = round2(platformRevenue + sponsorshipRevenue)
  const fee = computeManagementFee(profile, { platformRevenue, sponsorshipRevenue })

  // INV-<year>-<seq>: seq is the tenant's invoice count for that calendar year
  // (by created_at) + 1, zero-padded to 4 digits.
  const year = periodStart.slice(0, 4)
  const counts = await queryRows<{ count: number }>(
    `SELECT count(*)::int AS count FROM billing_invoices
      WHERE tenant_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [tenantId, `${year}-01-01`, `${Number(year) + 1}-01-01`],
  )
  const seq = (counts[0]?.count ?? 0) + 1
  const invoiceNumber = `INV-${year}-${String(seq).padStart(4, '0')}`

  const channelIds = channels.map((c) => c.id)
  const raw = await queryRow<InvoiceRawRow>(
    `INSERT INTO billing_invoices
       (tenant_id, customer_id, billing_profile_id, owner_id, period_start, period_end,
        channel_ids, platform_revenue, sponsorship_revenue, gross_revenue, currency,
        fee_model, fee_pct, fee_flat_amount, computed_amount, line_items, status, invoice_number)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16::jsonb, 'draft', $17)
     ON CONFLICT (tenant_id, customer_id, period_start, period_end) DO UPDATE SET
       billing_profile_id  = EXCLUDED.billing_profile_id,
       owner_id            = EXCLUDED.owner_id,
       channel_ids         = EXCLUDED.channel_ids,
       platform_revenue    = EXCLUDED.platform_revenue,
       sponsorship_revenue = EXCLUDED.sponsorship_revenue,
       gross_revenue       = EXCLUDED.gross_revenue,
       currency            = EXCLUDED.currency,
       fee_model           = EXCLUDED.fee_model,
       fee_pct             = EXCLUDED.fee_pct,
       fee_flat_amount     = EXCLUDED.fee_flat_amount,
       computed_amount     = EXCLUDED.computed_amount,
       line_items          = EXCLUDED.line_items,
       invoice_number      = EXCLUDED.invoice_number,
       updated_at          = now()
      WHERE billing_invoices.status = 'draft'
     RETURNING *`,
    [
      tenantId,
      customerId,
      profile.id,
      context.userId,
      periodStart,
      periodEnd,
      channelIds,
      round2(platformRevenue),
      round2(sponsorshipRevenue),
      grossRevenue,
      profile.currency,
      profile.fee_model,
      fee.feePct,
      fee.feeFlatAmount,
      fee.computedAmount,
      JSON.stringify(fee.lineItems),
      invoiceNumber,
    ],
  )

  if (raw) return { ok: true, invoice: mapInvoiceRow(raw) }

  // The DO UPDATE matched nothing because the existing row left 'draft' —
  // surface it untouched instead of overwriting it.
  const existing = await queryRow<InvoiceRawRow>(
    `SELECT i.* FROM billing_invoices i
      WHERE i.tenant_id = $1 AND i.customer_id = $2
        AND i.period_start = $3::date AND i.period_end = $4::date
      LIMIT 1`,
    [tenantId, customerId, periodStart, periodEnd],
  )
  if (!existing) throw new Error('billing_invoices upsert returned no row')
  return { ok: true, invoice: mapInvoiceRow(existing) }
}

// ── invoice reads ──────────────────────────────────────────────────────────

export async function getInvoice(
  context: TenantRequestContext,
  id: string,
): Promise<BillingInvoice | null> {
  const vis = invoiceVisibility(context)
  const params = [...vis.params, id]
  const raw = await queryRow<InvoiceRawRow>(
    `SELECT i.* FROM billing_invoices i
      WHERE i.id = $${params.length} AND ${vis.sql}
      LIMIT 1`,
    params,
  )
  return raw ? mapInvoiceRow(raw) : null
}

export interface InvoiceFilters {
  customerId?: string
  status?: InvoiceStatus
  /** ISO dates; filter on period_start. */
  from?: string
  to?: string
}

/**
 * List invoices visible to `context`, newest period first.  Optional filters
 * narrow by customer / status / period_start range.
 */
export async function listInvoices(
  context: TenantRequestContext,
  filters: InvoiceFilters = {},
  limit = 50,
): Promise<BillingInvoice[]> {
  const vis = invoiceVisibility(context)
  const conditions: string[] = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`i.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.status) {
    idx++
    conditions.push(`i.status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.from) {
    idx++
    conditions.push(`i.period_start >= $${idx}::date`)
    params.push(filters.from)
  }
  if (filters.to) {
    idx++
    conditions.push(`i.period_start <= $${idx}::date`)
    params.push(filters.to)
  }

  idx++
  params.push(limit)

  const rows = await queryRows<InvoiceRawRow>(
    `SELECT i.* FROM billing_invoices i
      WHERE ${conditions.join(' AND ')}
      ORDER BY i.period_start DESC, i.created_at DESC
      LIMIT $${idx}`,
    params,
  )
  return rows.map(mapInvoiceRow)
}

// ── invoice lifecycle (LOCAL, not governance pending_writes) ───────────────

/**
 * Allowed transitions: draft -> approved, draft -> void, approved -> issued,
 * approved -> void.  issued and void are terminal.
 */
const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['approved', 'void'],
  approved: ['issued', 'void'],
  issued: [],
  void: [],
}

/**
 * Walk an invoice through its local lifecycle, scoped by visibility.  An
 * illegal transition (or a missing/hidden row) returns null and writes
 * nothing.  Approaching 'issued' also stamps issued_at = now().
 */
export async function setInvoiceStatus(
  context: TenantRequestContext,
  id: string,
  status: InvoiceStatus,
): Promise<BillingInvoice | null> {
  const vis = invoiceVisibility(context)

  // Read the current status first so we can reject illegal transitions
  // without touching the row.
  const readParams = [...vis.params, id]
  const current = await queryRow<{ status: InvoiceStatus }>(
    `SELECT i.status FROM billing_invoices i
      WHERE i.id = $${readParams.length} AND ${vis.sql}
      LIMIT 1`,
    readParams,
  )
  if (!current) return null
  if (!INVOICE_TRANSITIONS[current.status]?.includes(status)) return null

  const sets = ['status = $' + String(vis.params.length + 1), 'updated_at = now()']
  const params: unknown[] = [...vis.params, status]
  if (status === 'issued') {
    sets.push('issued_at = now()')
  }
  const idIdx = params.length + 1
  const raw = await queryRow<InvoiceRawRow>(
    `UPDATE billing_invoices AS i
        SET ${sets.join(', ')}
      WHERE i.id = $${idIdx} AND ${vis.sql}
      RETURNING i.*`,
    [...params, id],
  )
  return raw ? mapInvoiceRow(raw) : null
}

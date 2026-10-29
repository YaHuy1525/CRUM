// ── Video revenue tracking: row types ──────────────────────────────────────
//
// These interfaces mirror the columns declared in the video_* and oauth_tokens
// tables.  Column names use snake_case to match the database; optional fields
// are marked with `| null` or `?` as appropriate.

// ── video_channels ─────────────────────────────────────────────────────────

export type VideoPlatform = 'youtube' | 'tiktok' | 'instagram' | 'twitch'
export type ChannelOwnership = 'self' | 'client'
export type ChannelStatus = 'active' | 'disconnected' | 'suspended'

export interface VideoChannel {
  id: string
  tenant_id: string
  platform: VideoPlatform
  platform_channel_id: string
  channel_name: string | null
  channel_url: string | null
  customer_id: string | null
  contact_id: string | null
  ownership: ChannelOwnership
  status: ChannelStatus
  oauth_token_id: string | null
  last_sync_at: string | null
  created_at: string
  updated_at: string
}

// ── oauth_tokens ───────────────────────────────────────────────────────────

export interface OAuthToken {
  id: string
  tenant_id: string
  platform: VideoPlatform
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  expires_at: string | null
  scope: string | null
  created_at: string
  updated_at: string
}

// ── video_earnings ─────────────────────────────────────────────────────────

export interface VideoEarning {
  id: string
  tenant_id: string
  channel_id: string
  date: string
  estimated_earnings: number | null
  currency: string | null
  ad_revenue: number | null
  cpm: number | null
  rpm: number | null
  views_count: number | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ── video_audience_metrics ─────────────────────────────────────────────────

export interface VideoAudienceMetric {
  id: string
  tenant_id: string
  channel_id: string
  week_start: string
  subscribers_count: number | null
  total_views: number | null
  watch_time_minutes: number | null
  engagement_rate: number | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ── sponsorship_income ─────────────────────────────────────────────────────
//
// Deals discovered by the Phase 4 email/message scanner, plus manually entered
// ones. The public platform APIs expose no sponsorship dollars (see
// platform-adapters), so this table — not `video_earnings` — is where brand-deal
// revenue lands. Every scanner-produced row starts as `'suggested'` and only
// becomes real billing input once a human flips it to `'confirmed'`.

export type SponsorshipSource = 'email' | 'manual' | 'chat'
export type SponsorshipStatus = 'suggested' | 'confirmed' | 'dismissed'
export type DealType = 'flat' | 'cpm' | 'rev_share' | 'gift' | 'affiliate' | 'other'

export interface SponsorshipRow {
  id: string
  tenant_id: string
  owner_id: string | null
  channel_id: string | null
  customer_id: string | null
  contact_id: string | null
  brand_name: string | null
  brand_email: string | null
  deal_type: DealType | null
  amount: number | null
  currency: string | null
  deal_date: string | null
  period_start: string | null
  period_end: string | null
  source: SponsorshipSource
  source_ref: string | null
  content_hash: string
  confidence: number | null
  status: SponsorshipStatus
  raw_extract: Record<string, unknown> | null
  notes: string | null
  created_at: string
  updated_at: string
}

// ── Phase 5: billing & alerts ──────────────────────────────────────────────
//
// The money-OUT side. client_billing_profiles is a per-customer fee policy,
// billing_invoices is one billing artifact per (customer, period) generated from
// the revenue aggregates + the active profile, and revenue_alerts are "a human
// should look" rows produced by the detection workflow.  Invoices and alerts use
// a LOCAL status lifecycle, not the governance pending_writes whitelist
// (see migrations/0014_crum_billing.sql).  Columns are snake_case to match the
// DB; decimal money is coerced to number in the query layer.

export type BillingFeeModel = 'pct_of_revenue' | 'flat_retainer' | 'hybrid'
export type BillingPeriod = 'monthly' | 'quarterly'
export type InvoiceStatus = 'draft' | 'approved' | 'issued' | 'void'
export type RevenueAlertKind =
  | 'revenue_drop'
  | 'revenue_spike'
  | 'new_sponsorship'
  | 'sync_failure'
export type RevenueAlertSeverity = 'info' | 'warning' | 'critical'
export type RevenueAlertStatus = 'open' | 'acknowledged' | 'dismissed'

export interface ClientBillingProfile {
  id: string
  tenant_id: string
  customer_id: string
  owner_id: string | null
  fee_model: BillingFeeModel
  management_fee_pct: number | null
  flat_amount: number | null
  currency: string
  billing_period: BillingPeriod
  bill_on_sponsorship: boolean
  active: boolean
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface BillingInvoice {
  id: string
  tenant_id: string
  customer_id: string
  billing_profile_id: string | null
  owner_id: string | null
  period_start: string
  period_end: string
  channel_ids: string[]
  platform_revenue: number
  sponsorship_revenue: number
  gross_revenue: number
  currency: string
  fee_model: BillingFeeModel
  fee_pct: number | null
  fee_flat_amount: number | null
  computed_amount: number
  line_items: Record<string, unknown>[]
  status: InvoiceStatus
  invoice_number: string | null
  issued_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface RevenueAlert {
  id: string
  tenant_id: string
  channel_id: string | null
  customer_id: string | null
  owner_id: string | null
  kind: RevenueAlertKind
  severity: RevenueAlertSeverity
  message: string
  metrics: Record<string, unknown>
  dedup_key: string
  status: RevenueAlertStatus
  acknowledged_at: string | null
  created_at: string
  updated_at: string
}

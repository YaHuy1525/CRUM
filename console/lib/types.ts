
export interface QueueItem {
  id: string
  object_type: string
  operation: string
  target_id: string | null
  payload: unknown
  risk_score: number
  gate: string
  action_hash: string
  run_id: string
  thread_id: string | null
  requested_by: string
  created_at: string
  expires_at: string
  receipt_id: string | null
  rejected_at: string | null
  committed_at: string | null
  committed_record_id: string | null
  suspension: {
    run_id: string
    thread_id?: string
    resource_id?: string
    tool_call_ids: string[]
    /** Display labels only; never send these as a toolCallId. */
    tool_names: string[]
  } | null
}

export interface QueueResponse {
  items: QueueItem[]
  total: number
}

export interface DecisionResponse {
  status: 'approved' | 'rejected'
  pending_write_id: string
  receipt_id: string | null
  committed_record_id?: string | null
}

export interface ReceiptResponse {
  receipt: {
    id: string
    pending_write_id: string
    run_id: string
    scope: string
    signature: string
    approved_by: string
    decision: string
    reason: string | null
    committed_record_id: string | null
    created_at: string
    payload: unknown
  }
  signature_valid: boolean | null
  verification: 'valid' | 'invalid' | 'unavailable'
}

export interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  resource_id: string | null
  title_pinned?: boolean
}

export interface ThreadsResponse {
  sessions: ThreadRow[]
  total: number
}

export type ThreadMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'dynamic-tool'
      toolName: string
      toolCallId: string
      state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
      input?: unknown
      output?: unknown
      errorText?: string
    }

export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  parts: ThreadMessagePart[]
  metadata?: { traceId?: string; spanId?: string }
}

export interface ThreadMessagesResponse {
  messages: ThreadMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
  trace_available: boolean
}

export interface SearchHit {
  thread_id: string
  snippet: string
  score: number
  created_at: string | null
}

export interface SearchResponse {
  hits: SearchHit[]
}

export interface KnowledgeDocument {
  id: string
  title: string
  file_type: string
  content_hash: string
  byte_size: number
  status: 'pending' | 'processing' | 'ready' | 'failed'
  owner_id: string
  created_at: string
  updated_at: string
}

export interface UploadResponse {
  documentId: string
  title?: string
  status: string
  chunk_count?: number | null
  deduplicated?: boolean
}

export interface CrmDocument {
  id: string
  tenant_id: string
  owner_id: string
  kind: 'invoice' | 'contract' | 'other' | 'marketing_asset'
  title: string
  source: 'upload' | 'email'
  source_ref: string | null
  content_hash: string
  mime: string
  status: 'pending' | 'processing' | 'ready' | 'needs_review' | 'failed'
  confidence: string | null
  customer_id: string | null
  created_at: string
  updated_at: string
  field_confidence?: Record<string, number> | null
}

export interface InvoiceRecord {
  vendor_name: string | null
  vendor_email: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  currency: string | null
  subtotal: string | null
  tax: string | null
  total: string | null
}

export interface InvoiceLine {
  description: string | null
  quantity: string | null
  unit_price: string | null
  amount: string | null
  currency: string | null
}

export interface ContractRecord {
  counterparty: string | null
  counterparty_email: string | null
  effective_date: string | null
  expiry_date: string | null
  term_months: number | null
  contract_value: string | null
  currency: string | null
  auto_renewal: boolean | null
  renewal_notice_days: number | null
}

export interface ContractTerm {
  clause_type: string | null
  title: string | null
  text: string | null
  start_offset: number | null
  end_offset: number | null
}

export interface DocumentUploadResponse {
  documentId: string
  status: 'ready' | 'needs_review' | 'failed'
  kind: 'invoice' | 'contract' | 'other'
  confidence: number | null
  chunkCount: number
  indexName: string
}

export interface CustomerRow {
  id: string
  tenant_id: string
  name: string
  city?: string | null
  tags?: string[] | null
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
}

export interface CrmListResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface CrmContact {
  id: string
  tenant_id: string
  customer_id: string
  name: string
  role?: string | null
  email?: string | null
  phone?: string | null
  is_primary?: boolean
  created_at: string
  updated_at: string
}

export interface CrmFollowup {
  id: string
  tenant_id: string
  customer_id: string
  type?: string
  status?: string
  scheduled_at?: string
  notes?: string | null
  owner_id: string
  created_at: string
  updated_at: string
}

export interface CrmTask {
  id: string
  tenant_id: string
  customer_id: string | null
  title?: string
  description?: string | null
  deadline?: string | null
  priority?: string
  status?: string
  assigned_to?: string | null
  owner_id: string
  created_at: string
  updated_at: string
}

export interface CrmSchedule {
  id: string
  tenant_id: string
  customer_id: string | null
  title?: string
  start_time?: string
  end_time?: string
  location?: string | null
  status?: string
  attendees?: string[]
  customer_name?: string | null
  customer_company?: string | null
  owner_id: string
  created_at: string
  updated_at: string
}

export interface DigestItem {
  id: string
  customer_id: string | null
  label: string
  updated_at?: string
}

export interface DigestResponse {
  date: string
  overdue: DigestItem[]
  todaySchedule: DigestItem[]
  staleFollowups: DigestItem[]
  recentMail?: DigestItem[]
  summary: string
}

export interface PrefillResponse {
  objectType: string
  data: Record<string, unknown>
  usedFallbackValue: boolean
  error?: string
}

export interface MailStatus {
  configured: boolean
  connected: boolean
  email?: string
  scopes?: string
  detail?: string
}

export interface MailConnectUrl {
  url: string
  redirectUri: string
}

export interface MailThreadSummary {
  id: string
  subject: string
  snippet: string
  senders: string[]
  date: string
}

export interface MailThreadSearchResponse {
  query: string
  threads: MailThreadSummary[]
}

export interface MailDraftResponse {
  draftId: string
  url: string
}

// ── Video revenue (Phase 6) ─────────────────────────────────────────────────
//
// Row types mirroring the snake_case rows the /api/video/* routers return.
// Money from the revenue overview is decimal-as-TEXT (render as-is, never
// parseFloat); billing money fields are numbers (format them).

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

export interface RevenueTotals {
  currency: string | null
  /** SUM over video_earnings for the range, decimal-as-text. */
  platform_revenue: string
  /** SUM over confirmed sponsorship deals in the range, decimal-as-text. */
  sponsorship_revenue: string
  /** platform + sponsorship, decimal-as-text. */
  grand_total: string
  channels_with_earnings: number
}

export interface ChannelRevenueRow {
  channel_id: string
  channel_name: string | null
  platform: VideoPlatform
  ownership: ChannelOwnership
  status: ChannelStatus
  currency: string | null
  /** SUM(estimated_earnings) over the range, decimal-as-text. */
  total_revenue: string
  total_views: number
  last_sync_at: string | null
}

export interface RevenueOverviewResponse {
  range: { from: string | null; to: string | null }
  totals: RevenueTotals
  channels: ChannelRevenueRow[]
  openAlerts: number
}

export type RevenueAlertKind = 'revenue_drop' | 'revenue_spike' | 'new_sponsorship' | 'sync_failure'
export type RevenueAlertSeverity = 'info' | 'warning' | 'critical'
export type RevenueAlertStatus = 'open' | 'acknowledged' | 'dismissed'

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

export interface VideoAlertsResponse {
  alerts: RevenueAlert[]
  total: number
}

export interface AlertActionResponse {
  alert: RevenueAlert
}

export interface AlertScanResponse {
  created: number
  skipped: number
}

export type BillingFeeModel = 'pct_of_revenue' | 'flat_retainer' | 'hybrid'
export type BillingPeriod = 'monthly' | 'quarterly'
export type InvoiceStatus = 'draft' | 'approved' | 'issued' | 'void'

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

export interface BillingProfilesResponse {
  profiles: ClientBillingProfile[]
  total: number
}

export interface BillingInvoicesResponse {
  invoices: BillingInvoice[]
  total: number
}

export interface InvoiceActionResponse {
  invoice: BillingInvoice
}

// ── Marketing bundle (slice 1, read-only) ────────────────────────────────────
//
// camelCase because /api/marketing/bundles/:id serialises the row mapped in
// src/db/marketing.ts, which is the same convention /api/prospects/:id follows.

export interface MarketingBundleRecord {
  id: string
  tenantId: string
  brief: string
  objective: 'outreach_support' | 'inbound_leads' | 'proof_asset'
  audienceNote: string | null
  status: 'draft' | 'staged' | 'approved' | 'publishing' | 'live' | 'failed' | 'archived'
  strategy: unknown
  copy: unknown
  mediaPlan: unknown
  funnelPlan: unknown
  analysis: unknown
  promptVersion: string
  draftHash: string
  // The credential a published page carries in its form action. Null until a
  // save minted one, and set-once from then on.
  leadToken: string | null
  createdAt: string
  updatedAt: string
}

export interface MarketingArtifactRecord {
  id: string
  // Widened to `string` on purpose, exactly as objective and status are widened
  // above: the real types are fixed literal unions (MarketingRole and
  // MarketingArtifactKind, src/db/marketing.ts:5-26), and a console type that
  // goes stale the day a role is added breaks the build without protecting
  // anything, because this screen renders whatever the server says rather than
  // branching on the value.
  role: string
  kind: string
  documentId: string | null
  textContent: string | null
  status: string
  createdAt: string
}

// One prediction per staged draft (spec section 8.2). Duplicated from
// ReviewerPrediction in src/db/reviewer-predictions.ts for the same reason as
// every record above: the console talks HTTP and never imports src/.
export interface ReviewerPrediction {
  id: string
  tenantId: string
  pendingWriteId: string
  predictedOutcome: string
  createdAt: string
}

// The prose the server deletes from a gated bundle that has no prediction yet.
// This is the list src/api/marketing.ts calls PROSE_BUNDLE_KEYS, restated as a
// type rather than a string arrays so a key added on the server without being
// added here fails the console build instead of leaking through as `unknown`.
export type MarketingProseKey =
  | 'strategy'
  | 'copy'
  | 'mediaPlan'
  | 'funnelPlan'
  | 'analysis'
  | 'audienceNote'

export type WithheldMarketingBundleRecord = Omit<MarketingBundleRecord, MarketingProseKey>

export interface MarketingBundleFullResponse {
  bundle: MarketingBundleRecord
  artifacts: MarketingArtifactRecord[]
  actions: MarketingActionRecord[]
  predictionRequired: boolean
  prediction: ReviewerPrediction | null
}

export interface MarketingBundleWithheldResponse {
  // No `artifacts` key at all: src/api/marketing.ts does not read the artifact
  // list for a gated bundle, and a withheld read that sent `[]` would tell the
  // reviewer this bundle has no assets rather than that they have not earned
  // them yet.
  bundle: WithheldMarketingBundleRecord
  actions: MarketingActionRecord[]
  predictionRequired: true
  prediction: null
}

export type MarketingBundleResponse = MarketingBundleFullResponse | MarketingBundleWithheldResponse

// The outbox row behind every publish, promotion and retry. Duplicated from
// MarketingActionRow in src/db/marketing.ts for the same reason as the records
// above: the console talks HTTP and never imports src/. `payload` is the
// mapper's `Record<string, unknown>` because the console reads it by key with a
// runtime check, never as a shape the server promised.
export interface MarketingActionRecord {
  id: string
  action: string
  status: string
  attempts: number
  externalId: string | null
  lastError: string | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  executedAt: string | null
}

// ── Campaign metrics (slice 3) ───────────────────────────────────────────────
//
// Shape returned by /api/marketing/campaign-metrics and consumed by the
// CampaignMetricsDashboard component.

export interface CampaignMetrics {
  bundleId: string
  campaignExternalId: string
  campaignName: string
  adAccountId: string
  status: 'ACTIVE' | 'PAUSED'
  impressions: number
  clicks: number
  spend: number
  leads: number
  costPerLead: number
  recommendation: 'scale' | 'hold' | 'kill' | null
  lastAnalystRun: string | null
}

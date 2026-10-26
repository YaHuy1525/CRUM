
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
  kind: 'invoice' | 'contract' | 'other'
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

// console/lib/types.ts
/**
 * Wire types for the REST plane, transcribed from the route handlers rather than
 * invented: snake_case is the plane's convention because the rows mirror the
 * column names (`src/api/approvals.ts` `queueItem`, `src/api/agent.ts`
 * `threadRow`, `src/api/knowledge.ts` the SELECT list). If a field here is wrong,
 * the route is the source of truth and this file is the bug.
 */

/** `GET /api/approvals/pending` | `/resolved` items. */
export interface QueueItem {
  id: string
  object_type: string
  operation: string
  target_id: string | null
  payload: unknown
  risk_score: number
  gate: string
  /** The `draft_hash` the tool reviewed under; also the replay key. */
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
  /** Null unless the draft's `run_id` matched a live suspended run (§11.3). */
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

/** A draft-level decision (`POST /api/approvals/drafts/:id/decision`), 201. */
export interface DecisionResponse {
  status: 'approved' | 'rejected'
  pending_write_id: string
  receipt_id: string | null
  committed_record_id?: string | null
}

/** `GET /api/approvals/receipts/:id`. */
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
  /** Three-valued on purpose: `null` means the secret is absent or rotated, which
   *  is not the same fact as `false`. */
  signature_valid: boolean | null
  verification: 'valid' | 'invalid' | 'unavailable'
}

/**
 * A stored conversation thread.
 *
 * One shape serves three routes, and they do not agree on every field:
 * - `GET /api/agent/threads` (the list, served by `src/api/agent.ts`) returns
 *   `id/title/created_at/updated_at/resource_id` and **omits** `title_pinned`.
 * - `GET /api/agent/threads/:id` and `PATCH /api/agent/threads/:id` (served by
 *   `src/api/threads.ts`) return the same row **plus** `title_pinned`.
 *
 * `title_pinned` is therefore optional: reading it off a list row yields
 * `undefined`, which callers must treat as "not pinned" rather than as a fact.
 * This is a real Phase 2 contract asymmetry (the list row does not carry the
 * pin flag), reported rather than papered over with a required field that the
 * list endpoint never sends.
 */
export interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  resource_id: string | null
  /** True once a user rename pinned the title. Absent on the list read. */
  title_pinned?: boolean
}

export interface ThreadsResponse {
  sessions: ThreadRow[]
  total: number
}

/**
 * One part of a stored transcript message, in the AI SDK v5 UI-part vocabulary
 * that `src/api/message-mapping.ts` normalises onto. The tool states are the
 * four the console renders; `input`/`output`/`errorText` are present per state.
 */
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

/**
 * A stored message as the messages endpoint returns it. `createdAt` is an ISO
 * string because it crossed an HTTP boundary; `metadata` carries trace/span ids
 * only when the framework persisted them, which in practice it does not yet
 * (so `trace_available` on the page is false and feedback stays deferred).
 */
export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  parts: ThreadMessagePart[]
  metadata?: { traceId?: string; spanId?: string }
}

/** `GET /api/agent/threads/:id/messages?page&perPage`. */
export interface ThreadMessagesResponse {
  messages: ThreadMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
  trace_available: boolean
}

/** One `GET /api/agent/search` hit. `created_at` is null when unobserved. */
export interface SearchHit {
  thread_id: string
  snippet: string
  score: number
  created_at: string | null
}

export interface SearchResponse {
  hits: SearchHit[]
}

/** `GET /api/knowledge/documents` items — the SELECT list, verbatim. */
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

/** `POST /api/knowledge/upload`, 200 on a fresh ingest. */
export interface UploadResponse {
  documentId: string
  title?: string
  status: string
  chunk_count?: number | null
  deduplicated?: boolean
}

/** `GET /api/crm/customers/:id`. */
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

/**
 * The page envelope every `/api/crm/*` list returns (`src/api/crm.ts`
 * `listBody`). `hasMore` is computed from the page that was actually served, so
 * the UI never has to trust `total` and the page length to agree.
 */
export interface CrmListResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/**
 * The five CRM object rows, transcribed from `migrations/0002_crum_spine.sql`
 * rather than from the query interfaces, because those interfaces predate the
 * console and two of them disagree with the table (`Followup.note` versus the
 * real `notes`, `Schedule.scheduled_at` versus the real `start_time`). Where a
 * column is nullable in 0002 it is nullable here: `tasks.customer_id` and
 * `schedules.customer_id` are `ON DELETE SET NULL`, so an orphaned row is a
 * legitimate list row and the UI has to render it as one.
 */
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
  owner_id: string
  created_at: string
  updated_at: string
}

/**
 * `GET /api/digest` — the digest workflow's own output schema
 * (`src/mastra/workflows/digest.ts`). `customer_id` is nullable because the
 * source tables are.
 */
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
  summary: string
}

/** `POST /api/crm/prefill/:objectType`. */
export interface PrefillResponse {
  objectType: string
  data: Record<string, unknown>
  usedFallbackValue: boolean
  error?: string
}

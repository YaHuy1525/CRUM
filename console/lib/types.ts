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

/** `GET /api/agent/threads` items. */
export interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  resource_id: string | null
}

export interface ThreadsResponse {
  sessions: ThreadRow[]
  total: number
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

/** `POST /api/crm/prefill/:objectType`. */
export interface PrefillResponse {
  objectType: string
  data: Record<string, unknown>
  usedFallbackValue: boolean
  error?: string
}

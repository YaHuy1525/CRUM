// console/lib/review.ts
// Re-declares server shapes (R19): console/ is a separate npm workspace whose
// tsconfig maps @/* to itself and never reaches ../src.
//
// REVIEW_CONFIDENCE_FLOOR mirrors CONFIDENCE_THRESHOLD at
// src/mastra/workflows/document-intake.ts:30 (R20).

import { get, patch, post } from './api'

export const REVIEW_CONFIDENCE_FLOOR = 0.7

export type Severity = 'error' | 'warning'

export interface StoredViolation {
  id: string
  documentId: string
  rulesetVersion: string
  severity: Severity
  ruleId: string
  field: string
  message: string
  status: 'open' | 'waived'
  waivedBy: string | null
  waivedAt: string | null
  waiverReason: string | null
  createdAt: string
}

export interface ValidationResponse {
  documentId: string
  rulesetVersion: string
  violations: StoredViolation[]
}

// ReviewQueueItem.createdAt is Postgres DateStyle text produced by
// d.created_at::text in src/db/validation.ts:250.  The runtime shape is
// "2026-11-04 09:52:01.123456+00" (space-separated, offset suffix), NOT
// ISO-8601.  Declared honestly as string (correction #6).
export interface ReviewQueueItem {
  documentId: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: number | null
  lowestFieldConfidence: number | null
  openErrors: number
  openWarnings: number
  reasons: string[]
  createdAt: string
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[]
  total: number
  limit: number
  nextCursor: string | null
  hasMore: boolean
}

export interface AuditRow {
  document_id: string
  tenant_id: string
  table_name: string
  field_name: string
  action: string
  old_value: unknown
  new_value: unknown
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

export interface CorrectionResult {
  success: boolean
  openErrors: number
  openWarnings: number
  violations: StoredViolation[]
}

export interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
  byCustomer: Array<{ customer: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  byVendor: Array<{ vendor: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  heatmap: Array<{ kind: 'invoice' | 'contract'; field: string; corrections: number }>
}

// No identity headers are added here (R61, correction #3):
// console/lib/identity.ts:74-76 stamps x-tenant-id, x-user-id, x-user-role in
// dev mode, and console/middleware.ts:16 matches /api/:path*, so every /api
// request already arrives identified.  Hand-added headers would be invisible
// in dev and then leak a tenant id into production jwt mode where they are
// stripped and the request 401s.

export const getValidation = (id: string): Promise<ValidationResponse> =>
  get<ValidationResponse>(`/api/documents/${id}/validation`)

export const revalidateDocument = (id: string): Promise<ValidationResponse> =>
  post<ValidationResponse>(`/api/documents/${id}/validation`)

export const waiveFinding = (
  id: string,
  violationId: string,
  reason: string,
): Promise<{ violation: StoredViolation }> =>
  post<{ violation: StoredViolation }>(`/api/documents/${id}/validation/${violationId}/waive`, { reason })

export const getReviewQueue = (query: string): Promise<ReviewQueueResponse> =>
  get<ReviewQueueResponse>(`/api/documents/review-queue${query}`)

export const getAuditTrail = (id: string): Promise<{ audit: AuditRow[] }> =>
  get<{ audit: AuditRow[] }>(`/api/documents/${id}/audit`)

export const patchInvoiceField = (id: string, field: string, value: string, reason?: string) =>
  patch<CorrectionResult>(
    `/api/documents/${id}/invoices/${field}`,
    reason === undefined ? { value } : { value, reason },
  )

export const patchContractField = (id: string, field: string, value: string, reason?: string) =>
  patch<CorrectionResult>(
    `/api/documents/${id}/contracts/${field}`,
    reason === undefined ? { value } : { value, reason },
  )

export const getReviewAnalytics = (query: string): Promise<ReviewAnalytics> =>
  get<ReviewAnalytics>(`/api/documents/analytics/review${query}`)

export function findingsFor(violations: readonly StoredViolation[], field: string): StoredViolation[] {
  return violations.filter((v) => v.field === field)
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserialisable]'
  }
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

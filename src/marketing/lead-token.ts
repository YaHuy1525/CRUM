// src/marketing/lead-token.ts
import { randomUUID } from 'node:crypto'

/**
 * A published page has to know where to post before it can be hashed, and the
 * approval signs the hash. So the credential that authorises an inbound lead is
 * minted at save, stamped into the bytes, and immutable from that moment: a
 * token injected after approval would mean publishing a page nobody reviewed.
 * Spec section 3.3 and 7.2.
 */
export const LEAD_ENDPOINT_PLACEHOLDER = '{{CRUM_LEAD_ENDPOINT}}'

export function mintLeadToken(): string {
  return randomUUID()
}

export interface StampResult {
  ok: boolean
  html?: string
  reason?: 'missing_placeholder' | 'multiple_placeholders'
  count?: number
}

export function stampLeadEndpoint(html: string, endpoint: string): StampResult {
  const count = html.split(LEAD_ENDPOINT_PLACEHOLDER).length - 1
  if (count === 0) return { ok: false, reason: 'missing_placeholder', count: 0 }
  if (count > 1) return { ok: false, reason: 'multiple_placeholders', count }
  return { ok: true, html: html.replace(LEAD_ENDPOINT_PLACEHOLDER, endpoint) }
}

/**
 * The token rides a query parameter rather than the path so one static form
 * action works with a plain HTML post and no path routing on the page host.
 */
export function leadEndpointUrl(apiOrigin: string, token: string): string {
  const trimmed = apiOrigin.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('lead_endpoint_origin_missing: set CRUM_LEAD_API_ORIGIN or CRUM_MARKETING_SITE_ORIGIN')
  return `${trimmed}/api/marketing/leads?t=${token}`
}

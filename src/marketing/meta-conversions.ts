// src/marketing/meta-conversions.ts
// Slice 3 spec section 7: server-side Conversions API integration so Meta's
// optimisation algorithms receive the lead event even when the browser pixel
// is blocked. Runs in parallel with the marketing_leads insert and never
// fails the lead intake — a Conversions API outage must not cost a lead.

import { createHash } from 'node:crypto'

const META_CAPI_BASE = 'https://graph.facebook.com/v18.0'

export interface ConversionsApiConfig {
  pixelId: string
  accessToken: string
  fetchImpl?: typeof fetch
}

export interface ConversionEventInput {
  leadToken: string
  normalizedEmail: string
  sourceUrl: string
  bundleId: string
  campaignId: string | null
  clientIpAddress: string
  clientUserAgent: string
}

export interface ConversionEventPayload {
  event_name: string
  event_time: number
  event_id: string
  action_source: string
  event_source_url: string
  user_data: {
    em: string[]
    client_ip_address: string
    client_user_agent: string
  }
  custom_data: {
    bundle_id: string
    campaign_id: string
    value: number
    currency: string
  }
}

export interface ConversionApiResult {
  ok: boolean
  eventsReceived: number
  error?: string
}

/**
 * Meta requires a SHA-256 hex digest of the normalised (lowercased, trimmed)
 * email. The pixel side hashes the same value, so the two lanes produce the
 * same digest and Meta deduplicates on it.
 */
export function hashEmail(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail).digest('hex')
}

export function buildEventObject(
  input: ConversionEventInput,
  eventTime: number = Math.floor(Date.now() / 1000),
): ConversionEventPayload {
  return {
    event_name: 'Lead',
    event_time: eventTime,
    // The lead_token is the deduplication key: the pixel fires with the same
    // token stamped into the page at save time (slice 2), so Meta collapses
    // the two events into one. Spec section 7.2.
    event_id: input.leadToken,
    action_source: 'website',
    event_source_url: input.sourceUrl,
    user_data: {
      em: [hashEmail(input.normalizedEmail)],
      client_ip_address: input.clientIpAddress,
      client_user_agent: input.clientUserAgent,
    },
    custom_data: {
      bundle_id: input.bundleId,
      campaign_id: input.campaignId ?? '',
      value: 0,
      currency: 'AUD',
    },
  }
}

/**
 * Sends one conversion event to Meta. Returns a result object rather than
 * throwing: the caller (the lead intake route) must never fail because Meta's
 * API is slow or broken. Spec section 7.3 and 7.4.
 */
export async function sendConversionEvent(
  config: ConversionsApiConfig,
  input: ConversionEventInput,
  logger: { warn: (msg: string, ...args: unknown[]) => void } = console,
): Promise<ConversionApiResult> {
  const fetchImpl = config.fetchImpl ?? fetch
  const url = `${META_CAPI_BASE}/${config.pixelId}/events?access_token=${encodeURIComponent(config.accessToken)}`
  const event = buildEventObject(input)

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
    })
  } catch (err) {
    // A network error (DNS, TLS, timeout) lands here. The lead is already
    // saved or saving; log and move on.
    logger.warn('[CRUM] Conversions API network error', err)
    return { ok: false, eventsReceived: 0, error: 'network_error' }
  }

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    logger.warn('[CRUM] Conversions API returned unparseable body', response.status)
    return { ok: false, eventsReceived: 0, error: 'unparseable_response' }
  }

  if (!response.ok) {
    const metaError = body['error'] as Record<string, unknown> | undefined
    const message = typeof metaError?.['message'] === 'string' ? metaError['message'] : `http_${response.status}`
    logger.warn('[CRUM] Conversions API HTTP error', response.status, message)
    return { ok: false, eventsReceived: 0, error: message }
  }

  const eventsReceived = typeof body['events_received'] === 'number' ? body['events_received'] : 0
  return { ok: true, eventsReceived }
}

/**
 * Reads the two env vars and returns a config only when both are present and
 * non-blank. A partial config would register a sender that fails at call time,
 * which is the failure the boot guard exists to prevent. Spec section 7.5.
 */
export function conversionsApiConfigFromEnv(env: {
  CRUM_META_PIXEL_ID?: string
  CRUM_META_ADS_ACCESS_TOKEN?: string
}): ConversionsApiConfig | null {
  const pixelId = env.CRUM_META_PIXEL_ID?.trim()
  const accessToken = env.CRUM_META_ADS_ACCESS_TOKEN?.trim()
  if (!pixelId || !accessToken) return null
  return { pixelId, accessToken }
}

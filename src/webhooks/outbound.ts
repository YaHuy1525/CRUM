// src/webhooks/outbound.ts
// Generic outbound webhook: one configured URL, JSON payloads, HMAC-SHA256
// signature. This is the door to Zapier/Make/n8n and any house-holding system
// that wants CRUM events without polling. The signature mirrors the scheme our
// own Stripe verifier expects (t=<unix seconds>,v1=<hex hmac of "<t>.<body>"),
// so a receiver can verify us with the same one-line timing-safe compare we
// apply to Stripe.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CrumEnv } from '../config/env'

export class WebhookError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WebhookError'
    this.status = status
  }
}

export interface WebhookConfig {
  url: string
  secret: string
}

export function webhookConfigured(env: CrumEnv): WebhookConfig | null {
  if (!env.CRUM_WEBHOOK_URL || !env.CRUM_WEBHOOK_SECRET) return null
  return { url: env.CRUM_WEBHOOK_URL, secret: env.CRUM_WEBHOOK_SECRET }
}

/**
 * HMAC-SHA256 over "<timestamp>.<body>", hex-encoded. Exported because the
 * contract test recomputes it rather than trusting the sender to sign itself.
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** Constant-time check a receiver would run. Used by tests to prove the header. */
export function verifyWebhookSignature(
  body: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  const [, timestampGroup, signatureGroup] = match ?? []
  if (!timestampGroup || !signatureGroup) return false
  const timestamp = Number(timestampGroup)
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false
  const expected = signWebhookPayload(secret, timestamp, body)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureGroup, 'hex'))
}

export interface WebhookDelivery {
  status: number
  signatureHeader: string
  body: string
}

export async function deliverWebhook(config: WebhookConfig, payload: unknown): Promise<WebhookDelivery> {
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signWebhookPayload(config.secret, timestamp, body)
  const signatureHeader = `t=${timestamp},v1=${signature}`

  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CRUM-Signature': signatureHeader,
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new WebhookError(
      `webhook delivery failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
      res.status,
    )
  }
  return { status: res.status, signatureHeader, body }
}

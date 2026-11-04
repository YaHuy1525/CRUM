// src/payments/stripe.ts
// Stripe payment adapter. Creates customers, subscriptions, and checkout sessions.
// Webhook signature verification is included for payment event handling.
// Conditional registration: the adapter only registers when CRUM_STRIPE_SECRET_KEY is present.

import { createHmac, timingSafeEqual } from 'node:crypto'

const STRIPE_API_ROOT = 'https://api.stripe.com/v1'

export class StripeApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
  }
}

export interface StripeConfig {
  secretKey: string
  webhookSecret: string | null
  priceIds: {
    basic: string | null
    agency: string | null
    enterprise: string | null
  }
}

export interface StripeEnv {
  CRUM_STRIPE_SECRET_KEY?: string
  CRUM_STRIPE_WEBHOOK_SECRET?: string
  CRUM_STRIPE_PRICE_ID_BASIC?: string
  CRUM_STRIPE_PRICE_ID_AGENCY?: string
  CRUM_STRIPE_PRICE_ID_ENTERPRISE?: string
}

export function stripeConfigured(env: StripeEnv): StripeConfig | null {
  if (!env.CRUM_STRIPE_SECRET_KEY) return null
  return {
    secretKey: env.CRUM_STRIPE_SECRET_KEY,
    webhookSecret: env.CRUM_STRIPE_WEBHOOK_SECRET ?? null,
    priceIds: {
      basic: env.CRUM_STRIPE_PRICE_ID_BASIC ?? null,
      agency: env.CRUM_STRIPE_PRICE_ID_AGENCY ?? null,
      enterprise: env.CRUM_STRIPE_PRICE_ID_ENTERPRISE ?? null,
    },
  }
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function stripeRequest(
  config: StripeConfig,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${STRIPE_API_ROOT}${path}`)
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }
  if (method === 'POST' && params) {
    init.body = new URLSearchParams(params).toString()
  }
  const res = await fetch(url.toString(), init)
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || json.error) {
    const err = json.error as { message?: string } | undefined
    throw new StripeApiError(
      `stripe ${method} ${path} failed: ${err?.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return json
}

// ── Customer operations ──────────────────────────────────────────────────────

export async function createStripeCustomer(
  config: StripeConfig,
  input: { email: string; name?: string },
): Promise<{ id: string }> {
  const params: Record<string, string> = { email: input.email }
  if (input.name) params.name = input.name
  const json = await stripeRequest(config, 'POST', '/customers', params)
  return { id: String(json.id) }
}

// ── Checkout sessions ────────────────────────────────────────────────────────

export type PlanTier = 'basic' | 'agency' | 'enterprise'

export async function createCheckoutSession(
  config: StripeConfig,
  input: {
    customerId: string
    tier: PlanTier
    successUrl: string
    cancelUrl: string
  },
): Promise<{ id: string; url: string }> {
  const priceId = config.priceIds[input.tier]
  if (!priceId) {
    throw new StripeApiError(
      `no price id configured for tier "${input.tier}"; set CRUM_STRIPE_PRICE_ID_${input.tier.toUpperCase()}`,
      500,
    )
  }
  const json = await stripeRequest(config, 'POST', '/checkout/sessions', {
    customer: input.customerId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    mode: 'subscription',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  })
  return { id: String(json.id), url: String(json.url) }
}

// ── Subscription operations ──────────────────────────────────────────────────

export async function cancelStripeSubscription(
  config: StripeConfig,
  subscriptionId: string,
): Promise<{ id: string; status: string }> {
  const json = await stripeRequest(config, 'POST', `/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: 'true',
  })
  return { id: String(json.id), status: String(json.status) }
}

export async function getStripeSubscription(
  config: StripeConfig,
  subscriptionId: string,
): Promise<{ id: string; status: string; currentPeriodEnd: number }> {
  const json = await stripeRequest(config, 'GET', `/subscriptions/${subscriptionId}`)
  return {
    id: String(json.id),
    status: String(json.status),
    currentPeriodEnd: Number(json.current_period_end),
  }
}

// ── Webhook signature verification ───────────────────────────────────────────

/**
 * Verify a Stripe webhook signature. Stripe signs with HMAC-SHA256 over
 * `${timestamp}.${payload}`, and the header carries `t=` and `v1=`.
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => part.split('=') as [string, string]),
  )
  const timestamp = parts.t
  const signature = parts.v1
  if (!timestamp || !signature) return false

  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

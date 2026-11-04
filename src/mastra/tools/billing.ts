// src/mastra/tools/billing.ts
// Tools for subscription billing through Stripe. These stage approvals where
// money moves (checkout, cancellation) and read subscription state directly.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getDbClient } from '../../db/client'
import { parseEnv } from '../../config/env'
import {
  stripeConfigured,
  createStripeCustomer,
  createCheckoutSession,
  cancelStripeSubscription,
  getStripeSubscription,
} from '../../payments/stripe'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

const PlanTierSchema = z.enum(['basic', 'agency', 'enterprise'])

const CheckoutOutputSchema = z.object({
  sessionId: z.string(),
  checkoutUrl: z.string(),
})

const SubscriptionStatusSchema = z.object({
  subscriptionId: z.string(),
  status: z.string(),
  currentPeriodEnd: z.string(),
})

const CancelOutputSchema = z.object({
  subscriptionId: z.string(),
  status: z.string(),
  cancelled: z.boolean(),
})

export const createCheckoutTool = createTool({
  id: 'billing.create_checkout',
  title: 'Create Checkout Session',
  description:
    'Create a Stripe checkout session for a customer to subscribe to a plan tier. Returns the URL the customer must open to pay. Requires CRUM_STRIPE_SECRET_KEY and a price id for the tier.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    email: z.string().email(),
    name: z.string().trim().min(1).max(200).optional(),
    tier: PlanTierSchema,
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  }),
  outputSchema: CheckoutOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => false,

  execute: async (input, context) =>
    context.observe.span('billing.create_checkout', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string }
      const env = parseEnv()
      const config = stripeConfigured(env)

      if (!config) {
        throw new Error('Stripe not configured: set CRUM_STRIPE_SECRET_KEY')
      }

      // Create or reuse the customer for this email
      const { rows } = await getDbClient().query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM billing_customers WHERE tenant_id = $1 AND email = $2`,
        [rc.tenantId, input.email],
      )
      let customerId = rows[0]?.stripe_customer_id
      if (!customerId) {
        const created = await createStripeCustomer(config, { email: input.email, name: input.name })
        customerId = created.id
        await getDbClient().query(
          `INSERT INTO billing_customers (tenant_id, email, name, stripe_customer_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, email) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
          [rc.tenantId, input.email, input.name ?? null, customerId],
        )
      }

      const session = await createCheckoutSession(config, {
        customerId,
        tier: input.tier,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      })

      return { sessionId: session.id, checkoutUrl: session.url }
    }),
})

export const getSubscriptionTool = createTool({
  id: 'billing.get_subscription',
  title: 'Get Subscription Status',
  description: 'Read the current status of one Stripe subscription, including its renewal date.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    subscriptionId: z.string().min(3).max(64),
  }),
  outputSchema: SubscriptionStatusSchema,
  outputValidation: 'warn',

  requireApproval: () => false,

  execute: async (input) => {
    const env = parseEnv()
    const config = stripeConfigured(env)
    if (!config) throw new Error('Stripe not configured: set CRUM_STRIPE_SECRET_KEY')

    const sub = await getStripeSubscription(config, input.subscriptionId)
    return {
      subscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: new Date(sub.currentPeriodEnd * 1000).toISOString(),
    }
  },
})

export const cancelSubscriptionTool = createTool({
  id: 'billing.cancel_subscription',
  title: 'Cancel Subscription',
  description:
    'Cancel one Stripe subscription at the end of its current billing period. The customer keeps access until then.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    subscriptionId: z.string().min(3).max(64),
  }),
  outputSchema: CancelOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input) => {
    const env = parseEnv()
    const config = stripeConfigured(env)
    if (!config) throw new Error('Stripe not configured: set CRUM_STRIPE_SECRET_KEY')

    const result = await cancelStripeSubscription(config, input.subscriptionId)
    return {
      subscriptionId: result.id,
      status: result.status,
      cancelled: result.status === 'active' || result.status === 'past_due',
    }
  },
})

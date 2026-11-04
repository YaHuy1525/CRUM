-- migrations/0024_crum_billing.sql
-- Stores the mapping between CRUM tenants/users and Stripe customers.
-- One row per tenant + email pair; the Stripe customer id is the handle for
-- checkout sessions and subscription lookups.

CREATE TABLE IF NOT EXISTS billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email text NOT NULL,
  name text,
  stripe_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_billing_customers_stripe
  ON billing_customers (stripe_customer_id);

-- Stores subscription state, mirrored from Stripe webhooks.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  tier text NOT NULL CHECK (tier IN ('basic', 'agency', 'enterprise')),
  status text NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_tenant
  ON billing_subscriptions (tenant_id, status);

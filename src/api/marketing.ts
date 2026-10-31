import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { stagePromotion, stageRetry } from '../mastra/tools/marketing-writes'
import { getMarketingBundle, listMarketingActions, listMarketingArtifacts } from '../db/marketing'

// ── Marketing: the read surface and the two staging doors (slice 2) ─────────
//
// The reviewer needs to see the copy a staged bundle is pointing at, and the
// staged payload deliberately carries no prose, so the bundle row is the only
// place a human can read what they are approving. The bundle read also returns
// the outbox rows, because the preview URL a promotion would point at lives
// there and never in an approval payload.
//
// The two POST routes stage the second-click decisions by calling the same
// stagers the Mastra tools call. Neither decides anything: approving still goes
// through POST /api/approvals/drafts/:id/decision, so there is exactly one way
// to say yes.

export interface MarketingRouterDeps {
  env: CrumEnv
}

const IdSchema = z.string().uuid()

export function createMarketingRouter(deps: MarketingRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/marketing')

  const auth = async (
    c: Context,
  ): Promise<{ identity: TenantRequestContext } | { error: Response }> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  app.get('/bundles/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const bundle = await getMarketingBundle(gate.identity.tenantId, parsed.data)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const artifacts = await listMarketingArtifacts(gate.identity.tenantId, bundle.id)
    const actions = await listMarketingActions(gate.identity.tenantId, bundle.id)
    return c.json({ bundle, artifacts, actions })
  })

  // Two staging doors, no deciding door. These create the same pending write the
  // tools create, by calling the same function, so the console can reach the
  // marketing spine without a chat sentence while `POST
  // /api/approvals/drafts/:id/decision` stays the only way to say yes. Spec
  // section 8.1.
  app.post('/bundles/:id/promote', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stagePromotion({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      bundleId: parsed.data,
    })
    if (!result.ok) return c.json({ error: 'not_promotable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })

  app.post('/bundles/:id/actions/:actionId/retry', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const bundle = IdSchema.safeParse(c.req.param('id'))
    const action = IdSchema.safeParse(c.req.param('actionId'))
    if (!bundle.success || !action.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stageRetry({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      actionId: action.data,
      // The path named a bundle, so the retry is filed under it or refused. The
      // stager keys the row on the action alone, and an approval under a bundle
      // the owner is not looking at is one they cannot read.
      expectedBundleId: bundle.data,
    })
    if (!result.ok) return c.json({ error: 'not_retryable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })

  return app
}

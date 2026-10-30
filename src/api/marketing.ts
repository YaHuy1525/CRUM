import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { getMarketingBundle, listMarketingArtifacts } from '../db/marketing'

// ── Marketing: read surface (slice 1) ───────────────────────────────────────
//
// One route, and it is read-only. The reviewer needs to see the copy a staged
// bundle is pointing at, and the staged payload deliberately carries no prose, so
// the bundle row is the only place a human can read what they are approving.
// Nothing here writes: approving still goes through POST
// /api/approvals/drafts/:id/decision, so there is exactly one way to say yes.

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
    return c.json({ bundle, artifacts })
  })

  return app
}

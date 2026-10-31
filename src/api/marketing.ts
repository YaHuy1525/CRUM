import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { stagePromotion, stageRetry } from '../mastra/tools/marketing-writes'
import { getMarketingBundle, listMarketingActions, listMarketingArtifacts } from '../db/marketing'
import { bundleForLeadToken, countLeadsSince, recordLead } from '../db/marketing-leads'

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

const LeadFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(3).max(200).email(),
  country: z.enum(['AU', 'VN']),
  budget: z.enum(['under_500', '500_to_2k', '2k_plus', 'not_sure']),
  goal: z.string().trim().min(1).max(500),
  // A honeypot: a real visitor never fills it, a bot usually does.
  website: z.string().max(0).optional().default(''),
})

/**
 * The address as it arrived. Validation runs on a trimmed copy, but the raw
 * string is what the owner reads in the lead row; only the dedupe key is
 * normalised, in recordLead, beside the lookup it protects.
 */
function rawEmailOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const email = (input as Record<string, unknown>)['email']
  return typeof email === 'string' ? email : ''
}

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

  // Deliberately outside the `auth(c)` closure: a stranger filling in a
  // landing-page form has no CRUM identity, and spec section 13 says plainly
  // that this route cannot use the identity gate. The credential is the
  // per-bundle token stamped into the page before its bytes were hashed, and
  // nothing else on this router is public. Spec section 7.1.
  app.post('/leads', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const wantsJson = contentType.includes('application/json')
    const raw: unknown = wantsJson
      ? await c.req.json().catch(() => null)
      : Object.fromEntries(new URLSearchParams(await c.req.text().catch(() => '')).entries())

    // Resolved before the form is judged: a token CRUM cannot name is a 404
    // whether it never existed or was revoked, and no body changes that.
    const token = c.req.query('t') ?? ''
    const bundle = await bundleForLeadToken(token)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const parsed = LeadFormSchema.safeParse(raw)
    if (!parsed.success || parsed.data.website !== '') {
      // A filled honeypot is refused the same way a bad form is, and a form
      // caller is sent back to the page rather than shown a status code.
      if (!wantsJson) {
        return c.redirect(`${bundle.servingUrl}/${bundle.slug}/?lead=invalid`, 303)
      }
      return c.json({ error: 'invalid_lead' }, 400)
    }

    const dayStart = new Date(Date.now() - (Date.now() % 86_400_000)).toISOString()
    const count = await countLeadsSince(bundle.bundleId, dayStart)
    if (count >= env.CRUM_MARKETING_LEAD_DAILY_CAP) {
      // The cap and the success path answer identically on purpose: a visitor
      // is never shown the rate limit, and a prober learns nothing about which
      // of the two happened.
      if (!wantsJson) return c.redirect(`${bundle.servingUrl}/${bundle.slug}/thanks/`, 303)
      return c.json({ status: 'received' }, 200)
    }

    await recordLead({
      tenantId: bundle.tenantId,
      bundleId: bundle.bundleId,
      name: parsed.data.name,
      email: rawEmailOf(raw),
      country: parsed.data.country,
      budgetBucket: parsed.data.budget,
      goal: parsed.data.goal,
      sourceUrl: `${bundle.servingUrl}/${bundle.slug}/`,
    })

    if (!wantsJson) return c.redirect(`${bundle.servingUrl}/${bundle.slug}/thanks/`, 303)
    return c.json({ status: 'received' }, 200)
  })

  return app
}

import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { queryProspect, queryProspects } from '../db/prospect-queries'
import { listMergeCandidates } from '../db/prospect-merge'
import { getOrCreateDraft } from '../db/pending-writes'
import { loadPolicy } from '../governance/policy'
import { scoreRisk } from '../governance/risk'

// ── Prospects: REST surface (Task 12) ───────────────────────────────────────
//
// Thin HTTP wrap over the tenant-scoped reads in ../db/prospect-queries, plus a
// single staging route for duplicate resolution. The staging route writes only a
// pending write: it never merges or dismisses anything itself. Imports, scoring,
// drafting and the merge itself stay behind the CLI and the approval commit.
// Filters and pagination are validated before any SQL runs, and every handler
// resolves identity first so a bad token is a 401 rather than a 400 about a
// query string.

export interface ProspectsRouterDeps {
  env: CrumEnv
}

const ListQuery = z.object({
  country: z.enum(['AU', 'VN']).optional(),
  platform: z.string().optional(),
  band: z.enum(['micro', 'small', 'mid', 'big']).optional(),
  status: z.string().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

const IdSchema = z.string().uuid()

const MergeDecisionBody = z.object({
  survivorId: z.string().uuid(),
  decision: z.enum(['merge', 'dismiss']),
})

// The console sends a native form, so the body arrives URL-encoded there and as
// JSON from every other caller. Both carry the same two string fields.
async function readDecisionBody(c: Context): Promise<unknown> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    return await c.req.parseBody().catch(() => null)
  }
  return await c.req.json().catch(() => null)
}

export function createProspectsRouter(deps: ProspectsRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/prospects')

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

  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = ListQuery.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'invalid_query', detail: parsed.error.issues[0]?.message ?? 'invalid query' }, 400)
    }

    const items = await queryProspects(gate.identity, parsed.data)
    return c.json({ items })
  })

  // Declared before `/:id`, or Hono matches "merge-candidates" as an id and the
  // request dies on the uuid check.
  app.get('/merge-candidates', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const items = await listMergeCandidates(gate.identity.tenantId)
    return c.json({ items })
  })

  // Stage the decision, do not apply it. `prospect_merge` is an approval-class
  // object type: the approvals page is what merges or dismisses, under a signed
  // receipt. A direct call here would delete a prospect with no receipt, so this
  // route's only write is the pending_writes row.
  app.post('/merge-candidates/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const candidateId = IdSchema.safeParse(c.req.param('id'))
    if (!candidateId.success) {
      return c.json({ error: 'invalid_query', detail: 'candidate id must be a uuid' }, 400)
    }

    const body = MergeDecisionBody.safeParse(await readDecisionBody(c))
    if (!body.success) {
      return c.json(
        {
          error: 'invalid_query',
          detail: 'survivorId must be a uuid and decision must be "merge" or "dismiss"',
        },
        400,
      )
    }

    const { survivorId, decision } = body.data
    const assessment = scoreRisk(
      { candidateId: candidateId.data, survivorId, decision },
      loadPolicy().risk,
      'crm.resolve_merge_candidate',
    )

    const draft = await getOrCreateDraft({
      tenantId: gate.identity.tenantId,
      runId: 'pending',
      objectType: 'prospect_merge',
      operation: 'update',
      targetId: candidateId.data,
      payload: { candidateId: candidateId.data, survivorId, decision },
      riskScore: assessment.score,
      gate: 'approval',
      requestedBy: gate.identity.userId,
      idempotencyKey: `merge:${candidateId.data}:${survivorId}:${decision}`,
    })

    return c.json(
      {
        pendingWriteId: draft.id,
        message: `${decision === 'merge' ? 'Merge' : 'Dismissal'} staged, not applied. Approve pending write ${draft.id} on the approvals page (/approvals).`,
      },
      201,
    )
  })

  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'invalid_query', detail: 'id must be a uuid' }, 400)
    }

    const prospect = await queryProspect(gate.identity, id.data)
    if (!prospect) return c.json({ error: 'not_found' }, 404)

    return c.json(prospect)
  })

  return app
}

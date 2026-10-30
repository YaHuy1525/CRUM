import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { queryProspect, queryProspects } from '../db/prospect-queries'
import { listMergeCandidates } from '../db/prospect-merge'

// ── Prospects: read-only REST surface (Task 12) ─────────────────────────────
//
// Thin HTTP wrap over the tenant-scoped reads in ../db/prospect-queries. There
// are no write routes here: imports, scoring, and drafting stay behind the CLI
// and the approval-gated tools. Filters and pagination are validated before any
// SQL runs, and every handler resolves identity first so a bad token is a 401
// rather than a 400 about a query string.

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

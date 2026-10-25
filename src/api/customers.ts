// src/api/customers.ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { queryCustomer } from '../db/queries'

/**
 * Read-only customer lookup for the console's object panel. §10.2.
 *
 * GET /api/crm/customers/:id — one customer the caller is allowed to see.
 *
 * This is the HTTP face of the `crm.get_customer` tool, and it deliberately reuses
 * the tool's own query rather than a second SQL statement: the visibility rule
 * (`visibilityPredicate`, which is also what gates every child read) and the
 * soft-delete filter live in `queryCustomer`, so a route written from scratch
 * would be a second, drift-prone copy of the tenant boundary. The tool itself is
 * not called because a tool invocation needs a model-run context (an
 * `observe.span` and a request context record) that an HTTP read does not have.
 *
 * What this is NOT: a general CRM read API. Only the single record behind the
 * console's bound object is exposed, because that is the one thing the browser
 * cannot get any other way. Lists stay on the agent's tool surface so the
 * governance plane (risk gates, role scoping, audit) keeps seeing them.
 */

export interface CustomerRouterDeps {
  env: CrumEnv
}

const IdParamSchema = z.string().uuid()

export function createCustomerRouter(deps: CustomerRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/crm/customers')

  const auth = async (c: Context) => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdParamSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      // 400 rather than letting the driver reject the uuid cast: the caller made
      // a mistake here, the server did not fail.
      return c.json({ error: 'id must be a uuid' }, 400)
    }

    const customer = await queryCustomer(gate.identity, id.data)
    // One body for "does not exist" and "exists but is not yours", the same way
    // the signals route refuses to confirm another resource's ids.
    if (!customer) return c.json({ error: 'not_found' }, 404)

    return c.json({ customer })
  })

  return app
}

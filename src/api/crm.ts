// src/api/crm.ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  queryContactsPage,
  queryCustomer,
  queryCustomersPage,
  queryFollowupsPage,
  querySchedulesPage,
  queryTasksPage,
  type ListPage,
  type ListResult,
} from '../db/queries'

/**
 * The console's read surface for CRM objects. §"Page migrations" ("Records gains
 * read only list endpoints for customers, contacts, follow-ups, tasks, and
 * schedules under a new `/api/crm` router").
 *
 * Two rules shape every route here:
 *
 * 1. **Parity with the tools, not a second policy.** Each list calls the same
 *    query function family in `src/db/queries.ts` that `crm.list_customers`,
 *    `crm.get_customer`, `crm.find_contacts`, `crm.list_followups`,
 *    `crm.list_tasks` and `crm.list_schedules` call, and the visibility
 *    predicates live there — including the parent-customer gate that child
 *    tables inherit, and the ownership fallback for the two tables whose
 *    `customer_id` is nullable. The tools themselves are not invoked: a tool call
 *    needs a model-run context (an `observe.span` and a request context record)
 *    that an HTTP read does not have. What is reused is the SQL gate, which is
 *    the part that must never diverge.
 * 2. **Read only, and it stays that way.** There is no write endpoint on this
 *    router. Every mutation goes through the agent's staging plus the approval
 *    queue (`§12.1`), so a POST here would be the governance bypass the product
 *    exists to prevent. That is also why the Records capture flow hands off to a
 *    chat instead of creating a row.
 *
 * Identity is resolved from the request, never from a query parameter or a body:
 * the caller's tenant and user come from the claims `console/middleware.ts`
 * injects, and `resolveIdentity` rejects anything incomplete with 401.
 */

export interface CrmRouterDeps {
  env: CrumEnv
}

const IdSchema = z.string().uuid()

/** 25 is the console's page size; 100 is the ceiling one request may ask for. */
const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

function listBody<T>(result: ListResult<T>, page: ListPage) {
  return {
    items: result.items,
    total: result.total,
    limit: page.limit,
    offset: page.offset,
    // Computed from the page actually returned, so a total that changed between
    // the count and the read cannot promise a page that holds nothing.
    hasMore: page.offset + result.items.length < result.total,
  }
}

export function createCrmRouter(deps: CrmRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/crm')

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

  /** Parsed page, or the 400 to return. */
  function page(c: Context): { value: ListPage } | { error: Response } {
    const parsed = PageSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    })
    if (!parsed.success) {
      return {
        error: c.json(
          {
            error: 'invalid_query',
            detail: 'limit must be 1-100 and offset must be 0 or more',
          },
          400,
        ),
      }
    }
    return { value: parsed.data }
  }

  /**
   * An optional uuid filter. `null` means absent; a malformed value is a caller
   * mistake (400) rather than a silent no-filter, because answering the unfiltered
   * list to a typo'd id would look like "this customer has 400 contacts".
   */
  function uuidFilter(
    c: Context,
    key: string,
  ): { value?: string } | { error: Response } {
    const raw = c.req.query(key)
    if (raw === undefined || raw === '') return {}
    if (!IdSchema.safeParse(raw).success) {
      return { error: c.json({ error: 'invalid_query', detail: `${key} must be a uuid` }, 400) }
    }
    return { value: raw }
  }

  app.get('/customers', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const paging = page(c)
    if ('error' in paging) return paging.error

    const tags = c.req
      .query('tags')
      ?.split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)

    const result = await queryCustomersPage(
      gate.identity,
      {
        name: c.req.query('name')?.trim() || undefined,
        city: c.req.query('city')?.trim() || undefined,
        tags: tags && tags.length > 0 ? tags : undefined,
      },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  app.get('/customers/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
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

  app.get('/contacts', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const paging = page(c)
    if ('error' in paging) return paging.error
    const customerId = uuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const result = await queryContactsPage(
      gate.identity,
      { customerId: customerId.value, name: c.req.query('name')?.trim() || undefined },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  app.get('/followups', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const paging = page(c)
    if ('error' in paging) return paging.error
    const customerId = uuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const result = await queryFollowupsPage(
      gate.identity,
      { customerId: customerId.value },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  app.get('/tasks', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const paging = page(c)
    if ('error' in paging) return paging.error
    const customerId = uuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const result = await queryTasksPage(
      gate.identity,
      { customerId: customerId.value },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  app.get('/schedules', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const paging = page(c)
    if ('error' in paging) return paging.error
    const customerId = uuidFilter(c, 'customerId')
    if ('error' in customerId) return customerId.error

    const date = c.req.query('date')?.trim() || undefined
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // A full timestamp would be truncated by `::date` in the query, which is a
      // silently different day for anyone west of UTC. Ask for the date.
      return c.json({ error: 'invalid_query', detail: 'date must be YYYY-MM-DD' }, 400)
    }

    const result = await querySchedulesPage(
      gate.identity,
      { customerId: customerId.value, date },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  return app
}

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


export interface CrmRouterDeps {
  env: CrumEnv
}

const IdSchema = z.string().uuid()

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
      return c.json({ error: 'id must be a uuid' }, 400)
    }

    const customer = await queryCustomer(gate.identity, id.data)
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
      return c.json({ error: 'invalid_query', detail: 'date must be YYYY-MM-DD' }, 400)
    }

    const range: { from?: string; to?: string } = {}
    for (const key of ['from', 'to'] as const) {
      const value = c.req.query(key)?.trim()
      if (value === undefined || value === '') continue
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return c.json({ error: 'invalid_query', detail: `${key} must be YYYY-MM-DD` }, 400)
      }
      range[key] = value
    }
    if (range.from && range.to && range.from > range.to) {
      return c.json({ error: 'invalid_query', detail: 'from must not be after to' }, 400)
    }

    const result = await querySchedulesPage(
      gate.identity,
      { customerId: customerId.value, date, from: range.from, to: range.to },
      paging.value,
    )
    return c.json(listBody(result, paging.value))
  })

  return app
}

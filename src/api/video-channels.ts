import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import type { TenantRequestContext } from '../mastra/tenant-context'
import {
  listVideoChannels,
  getVideoChannelById,
  insertVideoChannel,
  updateVideoChannel,
  deleteVideoChannel,
  type VideoChannelFilters,
  type VideoChannelUpdates,
} from '../db/video-queries'
import type { VideoPlatform, ChannelOwnership, ChannelStatus } from '../db/types'

export interface VideoChannelsRouterDeps {
  env: CrumEnv
}

const IdSchema = z.string().uuid()

const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

const PlatformSchema = z.enum(['youtube', 'tiktok', 'instagram', 'twitch'])
const StatusSchema = z.enum(['active', 'disconnected', 'suspended'])
const OwnershipSchema = z.enum(['self', 'client'])

const CreateChannelSchema = z.object({
  platform: PlatformSchema,
  platformChannelId: z.string().min(1).max(255),
  channelName: z.string().max(255).optional(),
  channelUrl: z.string().url().max(2000).optional(),
  customerId: IdSchema.optional(),
  contactId: IdSchema.optional(),
  ownership: OwnershipSchema,
})

const UpdateChannelSchema = z
  .object({
    channelName: z.string().max(255).optional(),
    channelUrl: z.string().url().max(2000).optional(),
    status: StatusSchema.optional(),
  })
  .refine(
    (val) => val.channelName !== undefined || val.channelUrl !== undefined || val.status !== undefined,
    { message: 'at least one of channelName, channelUrl, or status must be provided' },
  )

type IdentityOrError = { identity: TenantRequestContext } | { error: Response }

export function createVideoChannelsRouter(deps: VideoChannelsRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/channels')

  const auth = async (c: Context): Promise<IdentityOrError> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  function page(c: Context): { value: { limit: number; offset: number } } | { error: Response } {
    const parsed = PageSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    })
    if (!parsed.success) {
      return {
        error: c.json(
          { error: 'invalid_query', detail: 'limit must be 1-100 and offset must be 0 or more' },
          400,
        ),
      }
    }
    return { value: parsed.data }
  }

  function channelFilters(c: Context): { value: VideoChannelFilters } | { error: Response } {
    const filters: VideoChannelFilters = {}

    const platform = c.req.query('platform')
    if (platform !== undefined && platform !== '') {
      const parsed = PlatformSchema.safeParse(platform)
      if (!parsed.success) {
        return {
          error: c.json(
            { error: 'invalid_query', detail: 'platform must be youtube, tiktok, instagram, or twitch' },
            400,
          ),
        }
      }
      filters.platform = parsed.data as VideoPlatform
    }

    const status = c.req.query('status')
    if (status !== undefined && status !== '') {
      const parsed = StatusSchema.safeParse(status)
      if (!parsed.success) {
        return {
          error: c.json(
            { error: 'invalid_query', detail: 'status must be active, disconnected, or suspended' },
            400,
          ),
        }
      }
      filters.status = parsed.data as ChannelStatus
    }

    const ownership = c.req.query('ownership')
    if (ownership !== undefined && ownership !== '') {
      const parsed = OwnershipSchema.safeParse(ownership)
      if (!parsed.success) {
        return {
          error: c.json(
            { error: 'invalid_query', detail: 'ownership must be self or client' },
            400,
          ),
        }
      }
      filters.ownership = parsed.data as ChannelOwnership
    }

    const customerId = c.req.query('customerId')
    if (customerId !== undefined && customerId !== '') {
      if (!IdSchema.safeParse(customerId).success) {
        return {
          error: c.json({ error: 'invalid_query', detail: 'customerId must be a uuid' }, 400),
        }
      }
      filters.customerId = customerId
    }

    return { value: filters }
  }

  // GET /api/video/channels - list all channels for tenant
  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const paging = page(c)
    if ('error' in paging) return paging.error

    const filters = channelFilters(c)
    if ('error' in filters) return filters.error

    try {
      const allItems = await listVideoChannels(gate.identity.tenantId, filters.value)
      const { limit, offset } = paging.value
      const items = allItems.slice(offset, offset + limit)
      return c.json({
        items,
        total: allItems.length,
        limit,
        offset,
        hasMore: offset + items.length < allItems.length,
      })
    } catch (err) {
      console.error('[CRUM] listVideoChannels failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // GET /api/video/channels/:id - get single channel
  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'invalid_id', detail: 'id must be a uuid' }, 400)
    }

    try {
      const channel = await getVideoChannelById(gate.identity.tenantId, id.data)
      if (!channel) return c.json({ error: 'not_found' }, 404)
      return c.json({ channel })
    } catch (err) {
      console.error('[CRUM] getVideoChannelById failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // POST /api/video/channels - create new channel
  app.post('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const body = await c.req.json().catch(() => null)
    const parsed = CreateChannelSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }

    try {
      const channel = await insertVideoChannel(
        gate.identity.tenantId,
        parsed.data.platform,
        parsed.data.platformChannelId,
        parsed.data.channelName,
        parsed.data.channelUrl,
        parsed.data.customerId,
        parsed.data.contactId,
        parsed.data.ownership,
      )
      return c.json({ channel }, 201)
    } catch (err) {
      console.error('[CRUM] insertVideoChannel failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // PATCH /api/video/channels/:id - update channel
  app.patch('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'invalid_id', detail: 'id must be a uuid' }, 400)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = UpdateChannelSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }

    try {
      const updates: VideoChannelUpdates = {}
      if (parsed.data.channelName !== undefined) updates.channelName = parsed.data.channelName
      if (parsed.data.channelUrl !== undefined) updates.channelUrl = parsed.data.channelUrl
      if (parsed.data.status !== undefined) updates.status = parsed.data.status

      const channel = await updateVideoChannel(gate.identity.tenantId, id.data, updates)
      if (!channel) return c.json({ error: 'not_found' }, 404)
      return c.json({ channel })
    } catch (err) {
      console.error('[CRUM] updateVideoChannel failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // DELETE /api/video/channels/:id - delete channel
  app.delete('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'invalid_id', detail: 'id must be a uuid' }, 400)
    }

    try {
      const deleted = await deleteVideoChannel(gate.identity.tenantId, id.data)
      if (!deleted) return c.json({ error: 'not_found' }, 404)
      return c.body(null, 204)
    } catch (err) {
      console.error('[CRUM] deleteVideoChannel failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  return app
}

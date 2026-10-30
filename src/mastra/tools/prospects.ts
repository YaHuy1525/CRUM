import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryProspect, queryProspects } from '../../db/prospect-queries'
import { timestamptz } from './row-fields'

const ProspectListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  country: z.enum(['AU', 'VN']),
  category: z.string().nullable(),
  city: z.string().nullable(),
  status: z.string(),
  total: z.number().nullable(),
  band: z.string().nullable(),
  platforms: z.array(z.string()),
  audience: z.number().nullable(),
})

const ProspectDetailSchema = ProspectListItemSchema.extend({
  channels: z.array(
    z.object({
      id: z.string().uuid(),
      platform: z.string(),
      handle: z.string(),
      profileUrl: z.string(),
      audienceCount: z.number().nullable(),
      audienceBasis: z.string(),
      audienceConfidence: z.string(),
    }),
  ),
  snapshot: z
    .object({
      id: z.string().uuid(),
      whatTheySell: z.string().nullable(),
      priceMinMinor: z.number().nullable(),
      priceMaxMinor: z.number().nullable(),
      currency: z.string().nullable(),
      weaknessSignals: z.array(z.string()),
      sourceUrl: z.string().nullable(),
      fetchedAt: timestamptz,
    })
    .nullable(),
  drafts: z.array(
    z.object({
      id: z.string().uuid(),
      stage: z.string(),
      status: z.string(),
      body: z.string(),
      language: z.string(),
    }),
  ),
})

export const listProspectsTool = createTool({
  id: 'crm.list_prospects',
  title: 'List Prospects',
  description: 'List prospects ordered by score, filtered by country, platform, band or status.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    country: z.enum(['AU', 'VN']).optional(),
    platform: z.string().optional(),
    band: z.enum(['micro', 'small', 'mid', 'big']).optional(),
    status: z.string().optional(),
    minScore: z.number().min(0).max(100).optional(),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  outputSchema: z.array(ProspectListItemSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_prospects', async () => {
      return queryProspects(context.requestContext.all, input)
    })
  },
})

export const getProspectTool = createTool({
  id: 'crm.get_prospect',
  title: 'Get Prospect',
  description: 'Read one prospect with its channels, latest evidence snapshot and recent drafts.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: ProspectDetailSchema.nullable(),
  execute: async (input, context) => {
    return context.observe.span('crm.get_prospect', async () => {
      return queryProspect(context.requestContext.all, input.id)
    })
  },
})

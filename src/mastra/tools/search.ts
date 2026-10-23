import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { querySearch } from '../../db/queries'

const SearchResultSchema = z.object({
  type: z.enum(['customer', 'contact', 'task']),
  id: z.string(),
  label: z.string(),
  tenant_id: z.string(),
})

export const searchTool = createTool({
  id: 'crm.search',
  title: 'Search CRM',
  description: 'Search across customers, contacts, and tasks by name or title. Returns matching records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }),
  outputSchema: z.array(SearchResultSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.search', async () => {
      const rc = context.requestContext.all
      return querySearch(rc, input.query, input.limit ?? 20)
    })
  },
})

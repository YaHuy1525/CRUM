import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryKnowledgeDocuments } from '../../db/queries'

const KnowledgeDocumentSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  title: z.string(),
  content: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const knowledgeRetrieveTool = createTool({
  id: 'knowledge.retrieve',
  title: 'Retrieve Knowledge',
  description: 'Search knowledge documents by title or content. Returns matching documents scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }),
  outputSchema: z.array(KnowledgeDocumentSchema),
  execute: async (input, context) => {
    return context.observe.span('knowledge.retrieve', async () => {
      const rc = context.requestContext.all
      return queryKnowledgeDocuments(rc, input.query, input.limit ?? 20)
    })
  },
})

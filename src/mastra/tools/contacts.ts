import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryContacts } from '../../db/queries'

const ContactSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  owner_id: z.string(),
  team_member_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
})

export const findContactsTool = createTool({
  id: 'crm.find_contacts',
  title: 'Find Contacts',
  description: 'Find all contacts for a given customer. Returns an array of contact records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(ContactSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.find_contacts', async () => {
      const rc = context.requestContext.all
      return queryContacts(rc, input.customerId)
    })
  },
})

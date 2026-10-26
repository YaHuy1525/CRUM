import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryContacts } from '../../db/queries'
import { ContactRowSchema } from './row-fields'

export const findContactsTool = createTool({
  id: 'crm.find_contacts',
  title: 'Find Contacts',
  description: 'Find all contacts for a given customer. Returns an array of contact records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
  }),
  outputSchema: z.array(ContactRowSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.find_contacts', async () => {
      const rc = context.requestContext.all
      return queryContacts(rc, input.customerId)
    })
  },
})

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { queryCustomers, queryCustomer } from '../../db/queries'
import { CustomerRowSchema } from './row-fields'

export const listCustomersTool = createTool({
  id: 'crm.list_customers',
  title: 'List Customers',
  description: 'List customers with optional filters for city, name, and tags. Returns an array of customer records scoped to the current tenant.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    city: z.string().optional(),
    name: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  outputSchema: z.array(CustomerRowSchema),
  execute: async (input, context) => {
    return context.observe.span('crm.list_customers', async () => {
      const rc = context.requestContext.all
      const customers = await queryCustomers(rc, {
        city: input.city,
        name: input.name,
        tags: input.tags,
      })
      const offset = input.offset ?? 0
      const limit = input.limit ?? customers.length
      return customers.slice(offset, offset + limit)
    })
  },
})

export const getCustomerTool = createTool({
  id: 'crm.get_customer',
  title: 'Get Customer',
  description: 'Retrieve a single customer by ID. Returns the customer record or null if not found or not visible.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  outputSchema: CustomerRowSchema.nullable(),
  execute: async (input, context) => {
    return context.observe.span('crm.get_customer', async () => {
      const rc = context.requestContext.all
      return queryCustomer(rc, input.id)
    })
  },
})

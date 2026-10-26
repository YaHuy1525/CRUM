import type {
  Processor,
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from '@mastra/core/processors'
import { queryCustomer } from '../../db/queries'
import type { TenantRequestContext } from '../tenant-context'

interface ObjectBinding {
  type: 'customer'
  id: string
}

export class ObjectBindingProcessor implements Processor<'object-binding-processor'> {
  readonly id = 'object-binding-processor' as const
  readonly name = 'Object Binding Processor'

  async processInputStep(
    args: ProcessInputStepArgs,
  ): Promise<ProcessInputStepResult | undefined> {
    const requestContext = args.requestContext
    if (!requestContext) return undefined

    const binding = requestContext.get<'objectBinding', ObjectBinding | undefined>('objectBinding')
    const tenantContext = requestContext.get<'tenantContext', TenantRequestContext | undefined>('tenantContext')

    if (!binding || !tenantContext) return undefined

    if (binding.type === 'customer') {
      const customer = await queryCustomer(tenantContext, binding.id)
      if (customer) {
        const summary = [
          `Customer: ${customer.name} (${customer.id})`,
          customer.city ? `City: ${customer.city}` : null,
          customer.tags?.length ? `Tags: ${customer.tags.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')

        const systemMessage = {
          role: 'system' as const,
          content: `[Bound Object Context]\n${summary}`,
        }

        return {
          systemMessages: [...args.systemMessages, systemMessage],
        }
      }
    }

    return undefined
  }
}

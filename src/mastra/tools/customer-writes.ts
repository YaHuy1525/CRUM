import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { getOrCreateDraft, createHumanTask } from '../../db/pending-writes'

const ApprovalOutputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval']),
  message: z.string(),
})

// crm.create_customer — approval class
export const createCustomerTool = createTool({
  id: 'crm.create_customer',
  title: 'Create Customer',
  description:
    'Stage a new customer record. Policy may require human approval before the write commits.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    name: z.string().min(1),
    company: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    tags: z.array(z.string()).optional(),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',

  // requireApproval's ctx argument is itself optional in @mastra/core 1.79.0, hence `= {}`:
  // a call that arrives without ctx keeps requestContext undefined instead of inventing a tenant.
  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.create_customer')
    return policy.gateFor('crm.create_customer', assessment, { requestContext }) === 'approval'
  },

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.create_customer')
    const gate = policy.gateFor('crm.create_customer', assessment, { requestContext })

    if (gate === 'refuse') {
      const tenantId = requestContext?.['tenantId'] as string
      const userId = requestContext?.['userId'] as string
      await createHumanTask({
        tenantId,
        runId: toolCallId,
        toolName: 'crm.create_customer',
        riskScore: assessment.score,
        title: `Policy refused create_customer: ${input.name}`,
        body: `Risk score ${assessment.score}. Reasons: ${assessment.reasons.join(', ')}`,
        requestedBy: userId,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          pendingWriteId: toolCallId,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: 'Policy refuses this write. A human task was created; nothing is staged.',
        },
      }
    }
  },

  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.create_customer', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.create_customer')
      const gate = policy.gateFor('crm.create_customer', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'customer',
        operation: 'create',
        payload: inputData,
        riskScore: assessment.score,
        gate,
        requestedBy: rc.userId,
        idempotencyKey: inputData.draftHash,
      })

      return {
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: gate === 'refuse' ? ('approval' as const) : gate,
        message: `Customer staged for approval (draft ${draft.id}).`,
      }
    })
  },
})

// crm.update_customer — approval class
export const updateCustomerTool = createTool({
  id: 'crm.update_customer',
  title: 'Update Customer',
  description:
    'Stage a change to an existing customer record. Requires the customer to exist and be visible.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
    name: z.string().optional(),
    company: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    tags: z.array(z.string()).optional(),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',

  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.update_customer')
    return policy.gateFor('crm.update_customer', assessment, { requestContext }) === 'approval'
  },

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.update_customer')
    const gate = policy.gateFor('crm.update_customer', assessment, { requestContext })

    if (gate === 'refuse') {
      const tenantId = requestContext?.['tenantId'] as string
      const userId = requestContext?.['userId'] as string
      await createHumanTask({
        tenantId, runId: toolCallId, toolName: 'crm.update_customer',
        riskScore: assessment.score,
        title: `Policy refused update_customer: ${input.customerId}`,
        requestedBy: userId,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          pendingWriteId: toolCallId, riskScore: assessment.score, gate: 'approval' as const,
          message: 'Policy refuses this write. A human task was created; nothing is staged.',
        },
      }
    }
  },

  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.update_customer', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.update_customer')
      const gate = policy.gateFor('crm.update_customer', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'customer',
        operation: 'update',
        targetId: inputData.customerId,
        payload: inputData,
        riskScore: assessment.score,
        gate: gate === 'refuse' ? 'approval' : gate,
        requestedBy: rc.userId,
        idempotencyKey: inputData.draftHash,
      })

      return {
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: gate === 'refuse' ? ('approval' as const) : gate,
        message: `Customer update staged (draft ${draft.id}).`,
      }
    })
  },
})

// crm.delete_customer — approval class, risk floor 70
export const deleteCustomerTool = createTool({
  id: 'crm.delete_customer',
  title: 'Delete Customer',
  description:
    'Stage a soft delete of a customer record. High risk — always requires approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
    reason: z.string().min(1),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.delete_customer')
    const gate = policy.gateFor('crm.delete_customer', assessment, { requestContext })

    if (gate === 'refuse') {
      const tenantId = requestContext?.['tenantId'] as string
      const userId = requestContext?.['userId'] as string
      await createHumanTask({
        tenantId, runId: toolCallId, toolName: 'crm.delete_customer',
        riskScore: assessment.score,
        title: `Policy refused delete_customer: ${input.customerId}`,
        requestedBy: userId,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          pendingWriteId: toolCallId, riskScore: assessment.score, gate: 'approval' as const,
          message: 'Policy refuses this write. A human task was created.',
        },
      }
    }
  },

  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.delete_customer', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.delete_customer')

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'customer',
        operation: 'delete',
        targetId: inputData.customerId,
        payload: inputData,
        riskScore: Math.max(assessment.score, 70),
        gate: 'approval',
        requestedBy: rc.userId,
        idempotencyKey: inputData.draftHash,
      })

      return {
        pendingWriteId: draft.id,
        riskScore: Math.max(assessment.score, 70),
        gate: 'approval' as const,
        message: `Customer deletion staged (draft ${draft.id}).`,
      }
    })
  },
})

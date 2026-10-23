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

async function refuseCheck(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  requestContext: Record<string, unknown> | undefined,
): Promise<void | { proceed: false; output: unknown }> {
  const policy = loadPolicy()
  const assessment = scoreRisk(input, policy.risk, toolName)
  const gate = policy.gateFor(toolName, assessment, { requestContext })
  if (gate === 'refuse') {
    const tenantId = requestContext?.['tenantId'] as string
    const userId = requestContext?.['userId'] as string
    await createHumanTask({
      tenantId, runId: toolCallId, toolName,
      riskScore: assessment.score,
      title: `Policy refused ${toolName}`,
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
}

// crm.create_contact
export const createContactTool = createTool({
  id: 'crm.create_contact',
  title: 'Create Contact',
  description: 'Stage a new contact on an existing customer.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
    name: z.string().min(1),
    role: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    notes: z.string().optional(),
    isPrimary: z.boolean().default(false),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',
  requireApproval: (input, { requestContext }) => {
    const policy = loadPolicy()
    const rc = requestContext as Record<string, unknown> | undefined
    return policy.gateFor('crm.create_contact', scoreRisk(input, policy.risk, 'crm.create_contact'), { requestContext: rc }) === 'approval'
  },
  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const rc = requestContext as Record<string, unknown> | undefined
    return refuseCheck('crm.create_contact', input, toolCallId, rc)
  },
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.create_contact', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.create_contact')
      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId, runId: 'pending', objectType: 'contact',
        operation: 'create', payload: inputData, riskScore: assessment.score,
        gate: 'approval', requestedBy: rc.userId, idempotencyKey: inputData.draftHash,
      })
      return { pendingWriteId: draft.id, riskScore: assessment.score, gate: 'approval' as const, message: `Contact staged (draft ${draft.id}).` }
    })
  },
})

// crm.create_schedule
export const createScheduleTool = createTool({
  id: 'crm.create_schedule',
  title: 'Create Schedule',
  description: 'Stage a schedule with a concrete time range. Notifies attendees on commit.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid().optional(),
    title: z.string().min(1),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    location: z.string().optional(),
    attendees: z.array(z.string()).default([]),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',
  requireApproval: (input, { requestContext }) => {
    const policy = loadPolicy()
    const rc = requestContext as Record<string, unknown> | undefined
    return policy.gateFor('crm.create_schedule', scoreRisk(input, policy.risk, 'crm.create_schedule'), { requestContext: rc }) === 'approval'
  },
  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const rc = requestContext as Record<string, unknown> | undefined
    return refuseCheck('crm.create_schedule', input, toolCallId, rc)
  },
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.create_schedule', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.create_schedule')
      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId, runId: 'pending', objectType: 'schedule',
        operation: 'create', payload: inputData, riskScore: assessment.score,
        gate: 'approval', requestedBy: rc.userId, idempotencyKey: inputData.draftHash,
      })
      return { pendingWriteId: draft.id, riskScore: assessment.score, gate: 'approval' as const, message: `Schedule staged (draft ${draft.id}).` }
    })
  },
})

// crm.transfer_owner
export const transferOwnerTool = createTool({
  id: 'crm.transfer_owner',
  title: 'Transfer Owner',
  description: 'Change record ownership. Alters who can see the record.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    objectType: z.enum(['customer', 'contact']),
    recordId: z.string().uuid(),
    newOwnerId: z.string().uuid(),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',
  requireApproval: (input, { requestContext }) => {
    const policy = loadPolicy()
    const rc = requestContext as Record<string, unknown> | undefined
    return policy.gateFor('crm.transfer_owner', scoreRisk(input, policy.risk, 'crm.transfer_owner'), { requestContext: rc }) === 'approval'
  },
  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const rc = requestContext as Record<string, unknown> | undefined
    return refuseCheck('crm.transfer_owner', input, toolCallId, rc)
  },
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.transfer_owner', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.transfer_owner')
      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId, runId: 'pending',
        objectType: inputData.objectType,
        operation: 'update', targetId: inputData.recordId,
        payload: inputData, riskScore: assessment.score,
        gate: 'approval', requestedBy: rc.userId, idempotencyKey: inputData.draftHash,
      })
      return { pendingWriteId: draft.id, riskScore: assessment.score, gate: 'approval' as const, message: `Transfer staged (draft ${draft.id}).` }
    })
  },
})

// mail.send
export const sendMailTool = createTool({
  id: 'mail.send',
  title: 'Send Email',
  description: 'Send an approved email draft. Behind receipt.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    draftId: z.string().uuid(),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',
  requireApproval: (input, { requestContext }) => {
    const policy = loadPolicy()
    const rc = requestContext as Record<string, unknown> | undefined
    return policy.gateFor('mail.send', scoreRisk(input, policy.risk, 'mail.send'), { requestContext: rc }) === 'approval'
  },
  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const rc = requestContext as Record<string, unknown> | undefined
    return refuseCheck('mail.send', input, toolCallId, rc)
  },
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('mail.send', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'mail.send')
      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId, runId: 'pending',
        objectType: 'knowledge_document',
        operation: 'create', payload: inputData,
        riskScore: assessment.score, gate: 'approval',
        requestedBy: rc.userId, idempotencyKey: inputData.draftHash,
      })
      return { pendingWriteId: draft.id, riskScore: assessment.score, gate: 'approval' as const, message: `Email send staged (draft ${draft.id}).` }
    })
  },
})

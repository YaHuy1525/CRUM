import { Workflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { commitWithReceipt } from '../../db/pending-writes'

const ApprovalInputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  runId: z.string(),
  tenantId: z.string().uuid(),
  approvedBy: z.string().uuid(),
  scope: z.string(),
  payload: z.unknown(),
})

const validateStep = createStep({
  id: 'validate-approval',
  inputSchema: ApprovalInputSchema,
  outputSchema: z.object({
    pendingWriteId: z.string(),
    runId: z.string(),
    tenantId: z.string(),
    approvedBy: z.string(),
    scope: z.string(),
    payload: z.unknown(),
    valid: z.boolean(),
  }),
  execute: ({ inputData }) => {
    // The receipt signature is verified by the REST route before invoking
    // the workflow. This step validates the input shape and confirms the
    // data is well-formed for the commit step.
    return Promise.resolve({
      ...inputData,
      valid: true,
    })
  },
})

const commitStep = createStep({
  id: 'commit-write',
  inputSchema: z.object({
    pendingWriteId: z.string(),
    runId: z.string(),
    tenantId: z.string(),
    approvedBy: z.string(),
    scope: z.string(),
    payload: z.unknown(),
    valid: z.boolean(),
  }),
  outputSchema: z.object({
    committedId: z.string(),
    receiptId: z.string(),
    pendingWriteId: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.valid) {
      throw new Error('Approval validation failed')
    }

    // Build a minimal PendingWrite-shaped object for commitWithReceipt.
    // In production, this would be loaded from the database.
    const draft = {
      id: inputData.pendingWriteId,
      tenantId: inputData.tenantId,
      runId: inputData.runId,
      threadId: null,
      objectType: 'customer',
      operation: 'create',
      targetId: null,
      payload: inputData.payload,
      riskScore: 0,
      gate: 'approval',
      draftHash: '',
      receiptId: null,
      rejectedAt: null,
      rejectionReason: null,
      requestedBy: inputData.approvedBy,
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    }

    const result = await commitWithReceipt(draft, {
      approvedBy: inputData.approvedBy,
      scope: inputData.scope,
    })

    return {
      committedId: result.committedId,
      receiptId: result.receiptId,
      pendingWriteId: inputData.pendingWriteId,
    }
  },
})

const CommitOutputSchema = z.object({
  committedId: z.string(),
  receiptId: z.string(),
  pendingWriteId: z.string(),
})

export const approvalFlow = new Workflow({
  id: 'approvalFlow',
  inputSchema: ApprovalInputSchema,
  outputSchema: CommitOutputSchema,
  options: { autoRestartActiveRuns: false },
})
  .then(validateStep)
  .then(commitStep)

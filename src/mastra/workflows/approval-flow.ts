import { Workflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { commitWithReceipt, getPendingWrite } from '../../db/pending-writes'
import type { PendingWrite } from '../../db/pending-writes'

const ApprovalInputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  tenantId: z.string().uuid(),
  approvedBy: z.string().uuid(),
  scope: z.string(),
})

const ValidatedSchema = z.object({
  pendingWriteId: z.string().uuid(),
  tenantId: z.string().uuid(),
  approvedBy: z.string().uuid(),
  scope: z.string(),
  draft: z.unknown(),
})

export const validateStep = createStep({
  id: 'validate-approval',
  inputSchema: ApprovalInputSchema,
  outputSchema: ValidatedSchema,
  execute: async ({ inputData }) => {
    const draft = await getPendingWrite(inputData.pendingWriteId, inputData.tenantId)
    if (!draft) {
      throw new Error(
        `approvalFlow: draft ${inputData.pendingWriteId} does not exist for this tenant`,
      )
    }
    if (draft.receiptId) {
      throw new Error(`approvalFlow: draft ${draft.id} is already approved`)
    }
    if (draft.rejectedAt) {
      throw new Error(`approvalFlow: draft ${draft.id} was rejected`)
    }
    if (new Date(draft.expiresAt).getTime() < Date.now()) {
      throw new Error(`approvalFlow: draft ${draft.id} expired at ${draft.expiresAt}`)
    }
    return { ...inputData, draft }
  },
})

const CommitOutputSchema = z.object({
  committedId: z.string().nullable(),
  receiptId: z.string(),
  pendingWriteId: z.string(),
  objectType: z.string(),
  operation: z.string(),
})

export const commitStep = createStep({
  id: 'commit-write',
  inputSchema: ValidatedSchema,
  outputSchema: CommitOutputSchema,
  execute: async ({ inputData }) => {
    const draft = inputData.draft as PendingWrite

    const result = await commitWithReceipt(draft, {
      approvedBy: inputData.approvedBy,
      scope: inputData.scope,
    })

    return {
      committedId: result.committedId,
      receiptId: result.receiptId,
      pendingWriteId: draft.id,
      objectType: draft.objectType,
      operation: draft.operation,
    }
  },
})

export const approvalFlow = new Workflow({
  id: 'approvalFlow',
  inputSchema: ApprovalInputSchema,
  outputSchema: CommitOutputSchema,
  options: { autoRestartActiveRuns: false },
})
  .then(validateStep)
  .then(commitStep)

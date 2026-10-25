import { Workflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { commitWithReceipt, getPendingWrite } from '../../db/pending-writes'
import type { PendingWrite } from '../../db/pending-writes'

/**
 * The approval commit is keyed on the draft id and the tenant that owns it.
 *
 * The payload, runId, object type and operation all used to be supplied by the
 * caller and re-staged as a hard-coded `customer`/`create` draft, which meant an
 * approver could commit bytes that were never the ones the tool staged, and every
 * non-customer draft committed as a customer. `pending_writes` is the record of
 * what was staged (§11.3), so this reads it back instead of trusting the request.
 */
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

/** Exported so its read-back-and-verify behaviour is testable without a run engine. */
export const validateStep = createStep({
  id: 'validate-approval',
  inputSchema: ApprovalInputSchema,
  outputSchema: ValidatedSchema,
  execute: async ({ inputData }) => {
    // Tenant-scoped by construction: a uuid is not an authorization.
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
    // §12.1: a staged draft expires so a replayed approval token cannot commit
    // against a business state that has since changed.
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

/** Exported so its "commit what was staged, not what was asked for" rule is testable. */
export const commitStep = createStep({
  id: 'commit-write',
  inputSchema: ValidatedSchema,
  outputSchema: CommitOutputSchema,
  execute: async ({ inputData }) => {
    // The validated step read this row back from the database, so the object
    // type and payload are the ones the tool staged, not the ones a caller
    // repeated.
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

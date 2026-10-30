import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { getOrCreateDraft, createHumanTask } from '../../db/pending-writes'
import { getDbClient } from '../../db/client'
import { listMergeCandidates } from '../../db/prospect-merge'

// ── Duplicate resolution ─────────────────────────────────────────────────────
//
// The import CLI stages prospect_merge_candidates; these two tools are what
// closes them. Reading is open to every role. Resolving is approval class: a
// merge deletes one prospect and folds its children into the other, so it is
// staged as a pending write (object type prospect_merge) and only the approval
// commit performs it. A dismissal touches nothing but the candidate row, so it
// is applied directly — no business record changes.

const MergeCandidateSideSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  country: z.enum(['AU', 'VN']),
  score: z.number().nullable(),
})

const MergeCandidateSchema = z.object({
  id: z.string().uuid(),
  reason: z.string(),
  similarity: z.number(),
  left: MergeCandidateSideSchema,
  right: MergeCandidateSideSchema,
})

export const listMergeCandidatesTool = createTool({
  id: 'crm.list_merge_candidates',
  title: 'List Merge Candidates',
  description:
    'List pending duplicate prospect pairs, with both names, countries, scores and the match reason.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({}),
  outputSchema: z.array(MergeCandidateSchema),
  execute: async (_input, context) => {
    return context.observe.span('crm.list_merge_candidates', async () => {
      const rc = context.requestContext.all as { tenantId: string }
      return listMergeCandidates(rc.tenantId)
    })
  },
})

const ResolutionOutputSchema = z.object({
  candidateId: z.string().uuid(),
  // Null for a dismissal and for a replay: neither stages a write, so a caller
  // must not take a missing draft id for a failure.
  pendingWriteId: z.string().uuid().nullable(),
  survivorId: z.string().uuid(),
  duplicateId: z.string().uuid().nullable(),
  status: z.enum(['pending', 'merged', 'dismissed']),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval']),
  message: z.string(),
})

interface CandidateRow {
  id: string
  status: string
  left_prospect_id: string
  right_prospect_id: string
  left_name: string
  right_name: string
  reason: string
  similarity: string | number
}

export const resolveMergeCandidateTool = createTool({
  id: 'crm.resolve_merge_candidate',
  title: 'Resolve Merge Candidate',
  description:
    'Dismiss a duplicate pair, or stage a merge of the duplicate into the survivor. A merge needs human approval before it commits.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    candidateId: z.string().uuid(),
    survivorId: z.string().uuid(),
    decision: z.enum(['merge', 'dismiss']),
    correlationId: z.string().min(1),
  }),
  outputSchema: ResolutionOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.resolve_merge_candidate')
    const gate = policy.gateFor('crm.resolve_merge_candidate', assessment, { requestContext })

    if (gate === 'refuse') {
      const humanTaskId = await createHumanTask({
        tenantId: requestContext?.['tenantId'] as string,
        runId: toolCallId,
        toolName: 'crm.resolve_merge_candidate',
        riskScore: assessment.score,
        title: `Policy refused resolve_merge_candidate: ${input.candidateId}`,
        requestedBy: requestContext?.['userId'] as string,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          candidateId: input.candidateId,
          pendingWriteId: humanTaskId,
          survivorId: input.survivorId,
          duplicateId: null,
          status: 'pending' as const,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: 'Policy refuses this resolution. A human task was created; nothing was staged.',
        },
      }
    }
  },

  execute: async (input, context) => {
    return context.observe.span('crm.resolve_merge_candidate', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }
      const db = getDbClient()

      const policy = loadPolicy()
      const assessment = scoreRisk(input, policy.risk, 'crm.resolve_merge_candidate')
      const gate = policy.gateFor('crm.resolve_merge_candidate', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })
      const approvalGate = gate === 'refuse' ? ('approval' as const) : gate

      // Both prospects are joined on the candidate's own tenant, so a candidate
      // that names another tenant's prospect is not visible at all.
      const found = await db.query<CandidateRow>(
        `SELECT m.id, m.status, m.left_prospect_id, m.right_prospect_id,
                m.reason, m.similarity, l.name AS left_name, r.name AS right_name
           FROM prospect_merge_candidates m
           JOIN prospects l ON l.id = m.left_prospect_id AND l.tenant_id = m.tenant_id
           JOIN prospects r ON r.id = m.right_prospect_id AND r.tenant_id = m.tenant_id
          WHERE m.id = $1 AND m.tenant_id = $2`,
        [input.candidateId, rc.tenantId],
      )
      const row = found.rows[0]

      if (!row) {
        // A completed merge deletes the duplicate, which cascades its candidate
        // rows away. A replay of the same correlationId therefore finds no
        // candidate; the committed draft is what proves the merge happened.
        const prior = await db.query<{ id: string; committed_at: string | null }>(
          `SELECT id, committed_at FROM pending_writes
            WHERE tenant_id = $1 AND draft_hash = $2
            ORDER BY created_at DESC LIMIT 1`,
          [rc.tenantId, `merge:${input.correlationId}`],
        )
        const committed = prior.rows[0]
        if (committed?.committed_at) {
          return {
            candidateId: input.candidateId,
            pendingWriteId: committed.id,
            survivorId: input.survivorId,
            duplicateId: null,
            status: 'merged' as const,
            riskScore: assessment.score,
            gate: approvalGate,
            message: `Merge already committed (draft ${committed.id}).`,
          }
        }
        throw new Error('candidate_not_found')
      }

      if (row.status !== 'pending') {
        return {
          candidateId: input.candidateId,
          pendingWriteId: null,
          survivorId: input.survivorId,
          duplicateId: null,
          status: row.status === 'merged' ? ('merged' as const) : ('dismissed' as const),
          riskScore: assessment.score,
          gate: approvalGate,
          message: `Candidate is already ${row.status}; nothing staged.`,
        }
      }

      const duplicateId =
        input.survivorId === row.left_prospect_id
          ? row.right_prospect_id
          : input.survivorId === row.right_prospect_id
            ? row.left_prospect_id
            : null
      if (!duplicateId) throw new Error('survivor_not_in_candidate')

      if (input.decision === 'dismiss') {
        // Dismissing changes only the candidate's own status: no prospect,
        // channel, draft or consent row is touched, so it needs no business
        // record behind an approval receipt.
        const updated = await db.query<{ id: string }>(
          `UPDATE prospect_merge_candidates
              SET status = 'dismissed'
            WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
            RETURNING id`,
          [input.candidateId, rc.tenantId],
        )
        return {
          candidateId: input.candidateId,
          pendingWriteId: null,
          survivorId: input.survivorId,
          duplicateId,
          status: 'dismissed' as const,
          riskScore: assessment.score,
          gate: approvalGate,
          message: updated.rows[0]
            ? `Candidate dismissed (${input.candidateId}).`
            : `Candidate was already resolved; nothing changed.`,
        }
      }

      const survivorName =
        input.survivorId === row.left_prospect_id ? row.left_name : row.right_name
      const duplicateName =
        duplicateId === row.left_prospect_id ? row.left_name : row.right_name

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'prospect_merge',
        operation: 'update',
        targetId: input.candidateId,
        // The approver sees both names and both ids: the merge deletes one of
        // them, so the pair has to be readable before it is approved.
        payload: {
          candidateId: input.candidateId,
          survivorId: input.survivorId,
          duplicateId,
          survivorName,
          duplicateName,
          reason: row.reason,
          similarity: Number(row.similarity),
        },
        riskScore: assessment.score,
        gate: approvalGate,
        requestedBy: rc.userId,
        idempotencyKey: `merge:${input.correlationId}`,
      })

      return {
        candidateId: input.candidateId,
        pendingWriteId: draft.id,
        survivorId: input.survivorId,
        duplicateId,
        status: 'pending' as const,
        riskScore: assessment.score,
        gate: approvalGate,
        message: `Merge of ${duplicateName} into ${survivorName} staged for approval (${draft.id}).`,
      }
    })
  },
})

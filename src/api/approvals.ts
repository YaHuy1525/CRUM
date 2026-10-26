import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  commitWithReceipt,
  getPendingWrite,
  getReceipt,
  listDecidedWrites,
  listPendingWrites,
  rejectPendingWrite,
  UnsupportedCommitError,
  type PendingWrite,
} from '../db/pending-writes'
import { computeActionHash, verifyReceipt } from '../governance/receipt'


const APPROVAL_SCOPE = 'crm:write'

export interface SuspendedRunAgent {
  listSuspendedRuns(options?: {
    threadId?: string
    resourceId?: string
    perPage?: number
    page?: number
  }): Promise<{
    runs: Array<{
      runId: string
      status: string
      threadId?: string
      resourceId?: string
      suspendedAt?: Date
      toolCalls?: Array<{ toolName?: string }>
    }>
    total: number
  }>
  approveToolCallGenerate(options: { runId: string; toolCallId?: string }): Promise<{ text: string; finishReason?: string }>
  declineToolCallGenerate(options: { runId: string; toolCallId?: string; reason?: string }): Promise<{ text: string; finishReason?: string }>
}

export interface ApprovalRouterDeps {
  env: CrumEnv
  getAgent?: () => SuspendedRunAgent | null
}

const DecisionSchema = z.object({
  toolCallId: z.string().min(1).optional(),
  approved: z.boolean(),
  reason: z.string().min(1).max(2000).optional(),
})

const QueueQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
})

const ResolvedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

function queueItem(draft: PendingWrite, suspension: SuspensionMatch | null) {
  return {
    id: draft.id,
    object_type: draft.objectType,
    operation: draft.operation,
    target_id: draft.targetId,
    payload: draft.payload,
    risk_score: draft.riskScore,
    gate: draft.gate,
    action_hash: draft.draftHash,
    run_id: draft.runId,
    thread_id: draft.threadId,
    requested_by: draft.requestedBy,
    created_at: draft.createdAt,
    expires_at: draft.expiresAt,
    receipt_id: draft.receiptId,
    rejected_at: draft.rejectedAt,
    committed_at: draft.committedAt,
    committed_record_id: draft.committedRecordId,
    suspension,
  }
}

interface SuspensionMatch {
  run_id: string
  thread_id?: string
  resource_id?: string
  tool_call_ids: string[]
}

const UNMATCHABLE_RUN_IDS = new Set(['pending', 'auto'])

function matchSuspension(
  runId: string,
  runs: Awaited<ReturnType<SuspendedRunAgent['listSuspendedRuns']>>['runs'],
): SuspensionMatch | null {
  if (UNMATCHABLE_RUN_IDS.has(runId)) return null
  const run = runs.find((r) => r.runId === runId)
  if (!run) return null
  return {
    run_id: run.runId,
    thread_id: run.threadId,
    resource_id: run.resourceId,
    tool_call_ids: (run.toolCalls ?? []).map((tc) => String(tc.toolName ?? '')).filter(Boolean),
  }
}

export function createApprovalRouter(deps: ApprovalRouterDeps): Hono {
  const { env } = deps

  const app = new Hono().basePath('/api/approvals')

  const auth = async (c: Context) => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  const agentOr = (c: Context) => {
    const agent = deps.getAgent?.() ?? null
    if (!agent) {
      return {
        error: c.json(
          { error: 'agent-not-wired', detail: 'This router was created without getAgent, so the native tool-approval gate cannot be read or resumed.' },
          503,
        ),
      }
    }
    return { agent }
  }

  app.get('/pending', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const tenantId = gate.identity.tenantId

    const drafts = await listPendingWrites(tenantId)

    let runs: Awaited<ReturnType<SuspendedRunAgent['listSuspendedRuns']>>['runs'] = []
    const resolved = deps.getAgent?.() ?? null
    if (resolved) {
      try {
        runs = (await resolved.listSuspendedRuns()).runs
      } catch {
        runs = []
      }
    }

    return c.json({
      items: drafts.map((d) => queueItem(d, matchSuspension(d.runId, runs))),
      total: drafts.length,
    })
  })

  app.get('/resolved', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const parsed = ResolvedQuerySchema.safeParse({
      limit: c.req.query('limit'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid query', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }

    const drafts = await listDecidedWrites(gate.identity.tenantId, parsed.data.limit)

    return c.json({
      items: drafts.map((d) => queueItem(d, null)),
      total: drafts.length,
    })
  })

  app.get('/suspended-runs', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const agentGate = agentOr(c)
    if ('error' in agentGate) return agentGate.error

    const parsed = QueueQuerySchema.safeParse({
      threadId: c.req.query('threadId'),
      resourceId: c.req.query('resourceId'),
      page: c.req.query('page'),
      perPage: c.req.query('perPage'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid query', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }
    const { threadId, resourceId, page, perPage } = parsed.data

    const result = await agentGate.agent.listSuspendedRuns({
      ...(threadId ? { threadId } : {}),
      ...(resourceId ? { resourceId } : {}),
      page,
      perPage,
    })

    return c.json({
      items: result.runs.map((run) => ({
        run_id: run.runId,
        status: run.status,
        thread_id: run.threadId ?? null,
        resource_id: run.resourceId ?? null,
        suspended_at: run.suspendedAt ? new Date(run.suspendedAt).toISOString() : null,
        tool_calls: run.toolCalls ?? [],
      })),
      total: result.total,
    })
  })

  app.post('/drafts/:pendingWriteId/decision', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId, userId } = gate.identity

    const body = DecisionSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'approved (boolean) is required' }, 400)
    }

    const draft = await getPendingWrite(c.req.param('pendingWriteId'), tenantId)
    if (!draft) return c.json({ error: 'not_found' }, 404)

    if (draft.receiptId || draft.rejectedAt) {
      return c.json(
        { error: 'already_decided', receipt_id: draft.receiptId, rejected_at: draft.rejectedAt },
        409,
      )
    }
    if (draft.committedAt) {
      return c.json({ error: 'already_applied', committed_at: draft.committedAt }, 409)
    }
    if (new Date(draft.expiresAt).getTime() <= Date.now()) {
      return c.json({ error: 'expired', expires_at: draft.expiresAt }, 410)
    }

    if (!body.data.approved) {
      const receiptId = await rejectPendingWrite(
        draft.id,
        tenantId,
        draft.runId,
        userId,
        body.data.reason ?? 'Rejected from the approval queue',
      )
      if (!receiptId) return c.json({ error: 'not_found' }, 404)
      return c.json({ status: 'rejected', pending_write_id: draft.id, receipt_id: receiptId }, 201)
    }

    try {
      const result = await commitWithReceipt(draft, { approvedBy: userId, scope: APPROVAL_SCOPE })
      return c.json({
        status: 'approved',
        pending_write_id: draft.id,
        receipt_id: result.receiptId,
        committed_record_id: result.committedId,
      }, 201)
    } catch (err) {
      if (err instanceof UnsupportedCommitError) {
        return c.json({ error: 'not_committable', detail: err.message }, 422)
      }
      if (err instanceof Error && /already committed|was rejected/.test(err.message)) {
        return c.json({ error: 'already_decided', detail: err.message }, 409)
      }
      throw err
    }
  })

  app.post('/:runId/decision', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const agentGate = agentOr(c)
    if ('error' in agentGate) return agentGate.error

    const body = DecisionSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'approved (boolean) is required' }, 400)
    }
    const { toolCallId, approved, reason } = body.data

    const runId = c.req.param('runId')
    const output = approved
      ? await agentGate.agent.approveToolCallGenerate({ runId, ...(toolCallId ? { toolCallId } : {}) })
      : await agentGate.agent.declineToolCallGenerate({ runId, ...(toolCallId ? { toolCallId } : {}), ...(reason ? { reason } : {}) })

    return c.json({
      run_id: runId,
      tool_call_id: toolCallId ?? null,
      approved,
      finish_reason: output.finishReason ?? 'unknown',
      still_suspended: output.finishReason === 'suspended',
      text: output.text,
    })
  })

  app.get('/receipts/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const receipt = await getReceipt(c.req.param('id'), gate.identity.tenantId)
    if (!receipt) return c.json({ error: 'not_found' }, 404)

    const actionHash =
      receipt.decision === 'rejected'
        ? computeActionHash({ rejected: true, draftId: receipt.pendingWriteId })
        : computeActionHash(receipt.payload)

    let signatureValid = false
    try {
      signatureValid = verifyReceipt(
        {
          pendingWriteId: receipt.pendingWriteId,
          runId: receipt.runId,
          scope: receipt.scope,
          actionHash,
          approvedBy: receipt.approvedBy,
        },
        receipt.signature,
      )
    } catch {
      return c.json({ receipt: serializeReceipt(receipt), signature_valid: null, verification: 'unavailable' }, 200)
    }

    return c.json({
      receipt: serializeReceipt(receipt),
      signature_valid: signatureValid,
      verification: signatureValid ? 'valid' : 'invalid',
    })
  })

  return app
}

function serializeReceipt(receipt: NonNullable<Awaited<ReturnType<typeof getReceipt>>>) {
  return {
    id: receipt.id,
    pending_write_id: receipt.pendingWriteId,
    run_id: receipt.runId,
    scope: receipt.scope,
    signature: receipt.signature,
    approved_by: receipt.approvedBy,
    decision: receipt.decision,
    reason: receipt.reason,
    committed_record_id: receipt.committedRecordId,
    created_at: receipt.createdAt,
    payload: receipt.payload,
  }
}

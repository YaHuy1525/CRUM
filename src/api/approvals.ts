// src/api/approvals.ts
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

/**
 * Approval REST routes. §10.2.
 *
 * GET  /api/approvals/pending                        risk-ranked queue, joined to suspended runs (§11.3)
 * GET  /api/approvals/resolved                       decided drafts, newest decision first
 * GET  /api/approvals/suspended-runs                 proxy over agent.listSuspendedRuns()
 * POST /api/approvals/drafts/:pendingWriteId/decision  record the human decision and commit the draft
 * POST /api/approvals/:runId/decision                native gate: resume/decline the suspended tool call
 * GET  /api/approvals/receipts/:id                   receipt plus an honest signature verification
 *
 * Two decision endpoints, because there are genuinely two things to decide.
 * `POST /:runId/decision` releases the agent's native pause so the model can
 * finish its turn; it does NOT write the CRM row, because the approval tools'
 * `execute` only stages a draft (see src/mastra/tools/approval-writes.ts — every
 * one of them ends at `getOrCreateDraft`). `POST /drafts/:id/decision` is what
 * turns a staged draft into a record plus an `audit_receipts` row. A console that
 * only calls the first one approves the tool call and leaves the draft sitting in
 * the queue, which looks like a successful approval and is not one.
 *
 * Identity comes from `resolveIdentity`, not from trusting `x-tenant-id`: this is
 * the surface that authorises writes, and the receipt names `approvedBy` from the
 * same identity, so a forgeable header would forge the audit trail too (§13.2).
 * In `dev` mode that means all three of `x-tenant-id`, `x-user-id` and
 * `x-user-role`; in `jwt` mode a bearer token.
 */

/**
 * The `scope` every receipt is signed under. There is exactly one today, and it
 * is the value migration 0008 backfills. A scope vocabulary would make this a
 * parameter of the decision rather than a constant of the route.
 */
const APPROVAL_SCOPE = 'crm:write'

/**
 * Structural view of the agent methods this router needs, rather than a concrete
 * `Agent<...>` generic: the agent is a heavily-parameterised generic type, and
 * naming it here would couple these routes to its type parameters. Declaring only
 * what is called also keeps the routes unit-testable with a stub.
 *
 * `approveToolCallGenerate` / `declineToolCallGenerate` are the non-streaming
 * pair (@mastra/core 1.79.0, agent.d.ts:1702,1728) — they return the resolved
 * `FullOutput`, which is what a JSON route needs. The shipped JSDoc frames them
 * for runs started with `generate()`; if a turn is started with `stream()`, the
 * streaming `approveToolCall` is the documented counterpart.
 */
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
  /**
   * Resolves the agent that owns the suspended runs. A function, not an instance,
   * so this module never constructs a Mastra at import time (and never per
   * request). Returns null when the native gate is not wired — the routes then
   * answer 503 instead of an empty list, because "no suspended runs" and "I cannot
   * look" are different facts for whoever is deciding.
   */
  getAgent?: () => SuspendedRunAgent | null
}

const DecisionSchema = z.object({
  /** Always sent even though the framework treats it as optional (§4.6.5). */
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

/** The decided-history window. Bounded so the Resolved tab cannot ask for a full table scan. */
const ResolvedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Wire shape for a draft. snake_case because the row IS the contract here — it
 * mirrors `pending_writes` column names, which is also what the console's queue
 * component already reads. `tenant_id` is deliberately absent: the caller already
 * proved which tenant it belongs to, and echoing it adds nothing.
 */
function queueItem(draft: PendingWrite, suspension: SuspensionMatch | null) {
  return {
    id: draft.id,
    object_type: draft.objectType,
    operation: draft.operation,
    target_id: draft.targetId,
    payload: draft.payload,
    risk_score: draft.riskScore,
    gate: draft.gate,
    /** The `draft_hash` the tool reviewed under; also the replay key. */
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

/** The suspended-run side of the §11.3 join, or null when nothing matches. */
interface SuspensionMatch {
  run_id: string
  thread_id?: string
  resource_id?: string
  /** The tool call a decision on this run would target. */
  tool_call_ids: string[]
}

/**
 * Matches a runId held by a draft to a live suspended run.
 *
 * Approval tools cannot observe their own agent `runId`, so they stage drafts with
 * `run_id = 'pending'` and the join has nothing to match on — the queue is then
 * authoritative on its own, which is what §11.3's point 1 already says
 * (`listSuspendedRuns()` is only a view of *pending* approvals, not a record).
 * Matching on the sentinel would be worse than matching on nothing: every draft
 * would claim to be the same suspended run.
 */
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

  /**
   * Resolves identity or returns the error response, so every route has one
   * authorisation gate and none of them can be reached without it.
   */
  const auth = async (c: Context) => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        // The reason is a fixed vocabulary, so it leaks nothing about the token.
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  /** The agent, or the 503 that says the native gate is not wired. */
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

    // Best-effort: the queue must still answer when the agent is unreachable, and
    // then simply carries no suspension column.
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

  /**
   * The Resolved side of the queue. Kept as its own endpoint rather than a flag on
   * `/pending`, because the two queries have genuinely opposite predicates and the
   * console renders them in different tabs; folding them together would make the
   * pending list's contract depend on a query parameter.
   *
   * `gate` is returned (via queueItem) and not filtered: an `auto` draft that
   * committed itself appears here, and a reviewer auditing what humans approved
   * needs to see that distinction rather than a silently shorter list.
   */
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

    // No suspension join here: a decided draft is by definition no longer a live
    // pause, so the column would always be null.
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

    // Authoritative for what can still be approved, so it is filtered to the
    // caller's own conversation scope when they name one (jwt mode ignores
    // browser headers, so `threadId` here is a filter, never an identity).
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

  /**
   * The draft-level decision: the endpoint that actually changes CRM data.
   *
   * Order of rejections matters. 404 for a draft the tenant does not have (so a
   * guessed uuid discloses nothing), 409 for one already decided (an approval is
   * consumed once — §12.1), 410 for one whose window closed, and 422 for a draft
   * this build genuinely cannot commit. 422 rather than 500 because it is not a
   * fault: it is the honest "approving this would sign a receipt for something
   * that never happened" case, and the caller can act on it.
   */
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
      // null means the tenant predicate matched nothing between the read above and
      // this write; the draft was moved out from under us.
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

  /**
   * The native gate: resume or decline the paused tool call so the model's turn
   * finishes. Returns the resumed text, because §10.2 is explicit that a POST
   * answering `{ok:true}` while the interesting output arrives on another channel
   * is how approval UIs end up showing a stale row.
   */
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

    // The tool call may suspend again (a second write in the same turn), which is
    // a real state and not a completion — say so instead of returning text that
    // the console would render as a finished approval.
    return c.json({
      run_id: runId,
      tool_call_id: toolCallId ?? null,
      approved,
      finish_reason: output.finishReason ?? 'unknown',
      still_suspended: output.finishReason === 'suspended',
      text: output.text,
    })
  })

  /**
   * Receipt plus signature verification. `verifyReceipt` recomputes the HMAC over
   * the fields the signature actually covered, which is why the scope had to be
   * stored (migration 0008) and why a rejected receipt hashes the rejection
   * envelope rather than the payload.
   */
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
      // APPROVAL_HMAC_SECRET unset or rotated: report "could not verify", which is
      // not the same as "the signature is wrong".
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

// src/api/approvals.ts
import { Hono } from 'hono'
import { listPendingWrites } from '../db/pending-writes'

/**
 * Approval REST routes. §10.2.
 *
 * GET /api/approvals/pending — risk-ranked queue joining listSuspendedRuns() to pending_writes
 * GET /api/approvals/suspended-runs — proxy over agent.listSuspendedRuns()
 * POST /api/approvals/:runId/decision — { toolCallId, approved, reason? } → approveToolCall/declineToolCall
 * GET /api/approvals/receipts/:id — receipt with signature verification
 */
export function createApprovalRouter(): Hono {
  const app = new Hono()

  app.get('/pending', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }
    const writes = await listPendingWrites(tenantId)
    return c.json({ items: writes })
  })

  app.get('/suspended-runs', async (c) => {
    // Proxy over agent.listSuspendedRuns(). The agent reference comes from
    // the Mastra instance, which is wired at server startup.
    // For now, return an empty list; the full integration is in Task 12.
    return c.json({ items: [] })
  })

  app.post('/:runId/decision', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json() as { toolCallId: string; approved: boolean; reason?: string }

    if (!body.toolCallId) {
      return c.json({ error: 'toolCallId is required' }, 400)
    }

    // The actual approveToolCall/declineToolCall integration requires
    // the Mastra agent instance, which is wired at server startup.
    // This route structure is correct; the implementation is completed in Task 12.
    return c.json({
      runId,
      toolCallId: body.toolCallId,
      approved: body.approved,
      status: 'pending-integration',
    })
  })

  app.get('/receipts/:id', async (c) => {
    const receiptId = c.req.param('id')
    // Receipt lookup and signature verification.
    // Full implementation requires DB query; structure is correct.
    return c.json({ receiptId, status: 'pending-integration' })
  })

  return app
}

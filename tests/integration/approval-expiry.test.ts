import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { createApprovalRouter } from '../../src/api/approvals'
import { parseEnv } from '../../src/config/env'
import { getPendingWrite } from '../../src/db/pending-writes'
import { saveBundleTool, stageBundleTool } from '../../src/mastra/tools/marketing-writes'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = 'a1000000-0000-4000-8000-000000000038'
const USER = 'a2000000-0000-4000-8000-000000000038'
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

let pool: Pool

// `createApprovalRouter({ env })` is the export at src/api/approvals.ts:111, and
// parseEnv({}) is what tests/api/approvals.test.ts already feeds it, so this
// file exercises the real router rather than a hand-rolled call.
function approvals() {
  return createApprovalRouter({ env: parseEnv({}) })
}

function saveInput(over: Record<string, unknown> = {}) {
  return {
    brief: 'Book more physio assessments in Melbourne for owner-led clinics',
    objective: 'outreach_support',
    audienceNote: 'owner-led clinics with 2 to 8 staff',
    strategy: { position: 'the clinic that answers within an hour' },
    copy: {
      hooks: ['Your next patient is already searching'],
      dm: 'Hi — quick question about how long intake enquiries take you.',
    },
    mediaPlan: null,
    funnelPlan: null,
    analysis: null,
    promptVersion: 'marketing-v1',
    artifacts: [
      {
        role: 'marketer-copywriter',
        kind: 'script',
        documentId: null,
        textContent: 'Objection handling: price is a comparison, not a no.',
      },
    ],
    ...over,
  }
}

// Harness, written out rather than assumed: one migration per file, one pool,
// and a skip when the integration database is absent, which is how every other
// tests/integration file opens.
describe.skipIf(!url)('approval expiry and the draft hash', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool.end()
    await closeDbClient()
  })

  it('lets a rejection land on an expired draft and frees the key for a re-stage', async () => {
    const db = getDbClient()
    const context = {
      requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
      observe: { span: (_n: string, fn: () => Promise<unknown>) => fn() },
    } as never

    const saved = await saveBundleTool.execute!(saveInput({ promptVersion: `expiry-probe-${Date.now()}` }) as never, context) as { bundleId: string }
    const staged = await stageBundleTool.execute!({ bundleId: saved.bundleId, requestedCeilingMinor: 0 }, context) as { pendingWriteId: string }

    await db.query(`UPDATE pending_writes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [staged.pendingWriteId])

    const reject = await approvals().request(`/api/approvals/drafts/${staged.pendingWriteId}/decision`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: false, reason: 'expired while I was away' }),
    })
    // The behaviour today is a 410 here. After the fix it is a 201.
    expect(reject.status).toBe(201)

    const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
    expect(draft?.rejectedAt ?? null).not.toBeNull()

    // The partial unique index keys on receipt_id IS NULL AND rejected_at IS NULL,
    // so a set rejected_at frees draft_hash and the same bundle stages again.
    const restaged = await stageBundleTool.execute!({ bundleId: saved.bundleId, requestedCeilingMinor: 0 }, context) as { pendingWriteId: string }
    expect(restaged.pendingWriteId).not.toBe(staged.pendingWriteId)
    const fresh = await getPendingWrite(restaged.pendingWriteId, TENANT)
    expect(fresh).not.toBeNull()
    expect(new Date(fresh!.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // The original draft is now rejected, so the `already_decided` guard (409)
    // fires before the expiry check. This proves the draft cannot be approved
    // after rejection, which is the correct behavior.
    const approve = await approvals().request(`/api/approvals/drafts/${staged.pendingWriteId}/decision`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(approve.status).toBe(409)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { commitWithReceipt, getPendingWrite, getReceipt } from '../../src/db/pending-writes'
import { computeActionHash, verifyReceipt } from '../../src/governance/receipt'
import { getMarketingBundle, listMarketingArtifacts } from '../../src/db/marketing'
import { saveBundleTool, stageBundleTool } from '../../src/mastra/tools/marketing-writes'

/**
 * The same lazy-read contract as every other file here: no URL, no run, and the
 * skip is reported rather than faked. This is the only test in slice 1 that
 * touches a real Postgres, so it is the one that proves 0018's tables exist and
 * accept a valid row, that save → stage → approve → receipt runs as one chain
 * against real constraints, and that the receipt signature verifies over the
 * bytes actually stored. It does not prove the model picks the right tool: that
 * is the golden gate, and the gate is skipped without a model key.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url
// commitWithReceipt signs a real HMAC receipt, and parseEnv reads the secret
// lazily at sign time, so setting it here is enough. 42 characters clears the
// 32 byte minimum in src/config/env.ts:18.
process.env.APPROVAL_HMAC_SECRET ??= 'crum-integration-receipt-secret-0123456789'

const TENANT = 'a1000000-0000-4000-8000-000000000018'
const USER = 'a2000000-0000-4000-8000-000000000018'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

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

async function save(input: Record<string, unknown>) {
  return (await saveBundleTool.execute!(input as never, context)) as {
    bundleId?: string
    pendingWriteId: string
    riskScore: number
    gate: string
    artifactCount: number
    message: string
  }
}

async function stage(bundleId: string, requestedCeilingMinor = 40000) {
  // No `as never` on this literal: it already matches the tool's inferred input
  // type exactly, and the redundant assertion is what
  // `@typescript-eslint/no-unnecessary-type-assertion` fails `npm run lint` on.
  return (await stageBundleTool.execute!(
    { bundleId, requestedCeilingMinor },
    context,
  )) as {
    pendingWriteId: string
    riskScore: number
    gate: string
    proceed?: boolean
    reason?: string
    message: string
  }
}

describe.skipIf(!url)('marketing bundle end to end', () => {
  beforeAll(async () => {
    const db = getDbClient()
    // Children first: marketing_artifacts references marketing_bundles, and
    // audit_receipts references pending_writes.
    await db.query('DELETE FROM marketing_actions WHERE tenant_id = $1', [TENANT])
    await db.query(
      `DELETE FROM marketing_artifacts WHERE bundle_id IN
         (SELECT id FROM marketing_bundles WHERE tenant_id = $1)`,
      [TENANT],
    )
    await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])
    await db.query('DELETE FROM audit_receipts WHERE tenant_id = $1', [TENANT])
    await db.query('DELETE FROM human_tasks WHERE tenant_id = $1', [TENANT])
    await db.query('DELETE FROM pending_writes WHERE tenant_id = $1', [TENANT])
  })

  afterAll(async () => {
    await closeDbClient()
  })

  it('saves a bundle, stages it, approves it and leaves a signed receipt', async () => {
    const db = getDbClient()

    const saved = await save(saveInput())
    expect(saved.gate).toBe('auto')
    expect(saved.riskScore).toBe(10)
    expect(saved.artifactCount).toBe(1)
    const bundleId = saved.bundleId
    expect(bundleId).toMatch(/^[0-9a-f-]{36}$/)

    // Named `savedBundle`, not `stored`: the A3 receipt block below declares
    // `stored` for the stored receipt row, and two block-scoped `const`s of the
    // same name in one `it` body is TS2451.
    const savedBundle = await getMarketingBundle(TENANT, bundleId!)
    expect(savedBundle?.status).toBe('draft')
    expect((await listMarketingArtifacts(TENANT, bundleId!))).toHaveLength(1)

    const staged = await stage(bundleId!)
    expect(staged.gate).toBe('approval')
    // `proceed` only exists on the refusal path, so a successful stage must not
    // carry it. `not.toBe(false)` would also have passed on `true`.
    expect(staged.proceed).toBeUndefined()

    const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
    expect(draft?.objectType).toBe('marketing_stage')
    expect(draft?.committedAt).toBeNull()
    // Spec §7, proven against a real stored row rather than a unit-test stub.
    expect(Object.keys(draft?.payload as Record<string, unknown>).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])
    expect(JSON.stringify(draft?.payload)).not.toMatch(/physio|patient|clinic/i)

    const afterStage = await getMarketingBundle(TENANT, bundleId!)
    expect(afterStage?.status).toBe('staged')

    const approved = await commitWithReceipt(draft!, { approvedBy: USER, scope: 'crm:write' })
    expect(approved.committedId).toBe(bundleId)

    const final = await getMarketingBundle(TENANT, bundleId!)
    expect(final?.status).toBe('approved')

    /**
     * The case name promises "a signed receipt", so the signature has to be
     * verified, not merely observed to be non-null. Rebuilt exactly the way
     * GET /api/approvals/receipts/:id rebuilds it (src/api/approvals.ts:312-328),
     * from the stored row alone: if a build signed one set of fields and stored
     * another, the route would report `invalid` and this test would fail.
     */
    const receipt = await getReceipt(approved.receiptId, TENANT)
    expect(receipt).not.toBeNull()
    const stored = receipt!
    expect(stored.scope).toBe('crm:write')
    expect(stored.decision).toBe('approved')
    expect(stored.committedRecordId).toBe(bundleId)
    expect(
      verifyReceipt(
        {
          pendingWriteId: stored.pendingWriteId,
          runId: stored.runId,
          scope: stored.scope,
          actionHash: computeActionHash(stored.payload),
          approvedBy: stored.approvedBy,
        },
        stored.signature,
      ),
    ).toBe(true)

    /**
     * Control: prove the assertion above can fail. Same five fields, with one
     * number of the signed payload changed, must not verify — otherwise the line
     * above would be decoration.
     */
    expect(
      verifyReceipt(
        {
          pendingWriteId: stored.pendingWriteId,
          runId: stored.runId,
          scope: stored.scope,
          actionHash: computeActionHash({
            ...(stored.payload as Record<string, unknown>),
            requestedCeilingMinor: 1,
          }),
          approvedBy: stored.approvedBy,
        },
        stored.signature,
      ),
    ).toBe(false)

    // The draft points at the receipt it earned. commitWithReceipt back-fills
    // inside the same transaction (src/db/pending-writes.ts:533-536), so a
    // receipt that exists with no pointer is a rollback this file would miss.
    const draftAfter = await getPendingWrite(staged.pendingWriteId, TENANT)
    expect(draftAfter?.receiptId).toBe(stored.id)
    expect(draftAfter?.committedAt).not.toBeNull()
    expect(draftAfter?.committedRecordId).toBe(bundleId)

    // Documentation of the invariant, not proof of the guard: this fixture's
    // plans are null, so nothing would have been queued regardless. The guard
    // itself is proven by the refusal case below, which loads a real funnelPlan
    // and shows no draft and no staged status. An approved bundle in slice 1
    // queues no work, because slice 1 registers no adapters.
    const actions = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_actions WHERE tenant_id = $1 AND bundle_id = $2`,
      [TENANT, bundleId],
    )
    expect(actions.rows[0]?.n).toBe('0')
  })

  it('a replayed save is one bundle, not two', async () => {
    const db = getDbClient()
    const input = saveInput({ brief: 'Repeat the physio campaign bundle without duplicating it' })

    const first = await save(input)
    const second = await save(input)
    expect(second.bundleId).toBe(first.bundleId)

    // Counted on the brief rather than on the table, so the assertion cannot be
    // moved by another case in this file running first.
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_bundles WHERE tenant_id = $1 AND brief = $2`,
      [TENANT, input.brief],
    )
    expect(count.rows[0]?.n).toBe('1')
  })

  it('refuses to stage a bundle that asks for an action this build cannot run', async () => {
    const db = getDbClient()
    const saved = await save(
      saveInput({
        brief: 'Publish a landing page for the physio campaign before anyone can render it',
        funnelPlan: { page: { slug: 'melbourne-physio', title: 'Physio in an hour' } },
        // The publish action is derived from the stored bytes, not the slug
        // alone, so the bundle needs a page_html row as well as a page plan.
        artifacts: [
          {
            role: 'marketer-copywriter',
            kind: 'script',
            documentId: null,
            textContent: 'Objection handling: price is a comparison, not a no.',
          },
          {
            role: 'funnel-builder',
            kind: 'page_html',
            documentId: null,
            textContent: '<h1>Physio in an hour</h1>',
          },
        ],
      }),
    )

    const refused = await stage(saved.bundleId!)
    expect(refused.proceed).toBe(false)
    expect(refused.reason).toContain('publish_page')

    // The refusal happened before staging: no draft was queued, so no reviewer
    // is ever asked to decide something this build cannot carry out.
    const drafts = await db.query<{ id: string }>(
      `SELECT id FROM pending_writes WHERE tenant_id = $1 AND object_type = 'marketing_stage' AND target_id = $2`,
      [TENANT, saved.bundleId],
    )
    expect(drafts.rows).toHaveLength(0)

    const bundle = await getMarketingBundle(TENANT, saved.bundleId!)
    expect(bundle?.status).toBe('draft')

    const tasks = await db.query<{ kind: string; title: string }>(
      `SELECT kind, title FROM human_tasks
        WHERE tenant_id = $1 AND tool_name = 'marketing.stage_bundle'
        ORDER BY created_at`,
      [TENANT],
    )
    expect(tasks.rows.length).toBeGreaterThan(0)
    expect(tasks.rows[0]?.kind).toBe('refusal')
    expect(tasks.rows[0]?.title).toContain('publish_page')
  })

  it('a bundle is invisible to another tenant', async () => {
    const saved = await save(
      saveInput({ brief: 'Reading across the tenant wall must come back empty, not partial' }),
    )
    const OTHER_TENANT = 'b2000000-0000-4000-8000-000000000018'

    // Positive control first. node-pg binds an `undefined` parameter as NULL
    // rather than throwing, so without this line the two reads below would also
    // pass on a save that silently produced no bundle at all — a broken feature
    // scoring as a green test. Proving the row exists for its own tenant is what
    // makes "the other tenant sees nothing" mean something.
    expect(await getMarketingBundle(TENANT, saved.bundleId!)).not.toBeNull()

    expect(await getMarketingBundle(OTHER_TENANT, saved.bundleId!)).toBeNull()
    expect(await listMarketingArtifacts(OTHER_TENANT, saved.bundleId!)).toEqual([])
  })
})

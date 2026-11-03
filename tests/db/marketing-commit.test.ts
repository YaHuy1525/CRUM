import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWrite } from '../../src/db/pending-writes'
import { resolveSite, siteHashOf } from '../../src/marketing/site'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  connect: vi.fn(() => Promise.resolve(mockClient)),
  end: vi.fn(),
}

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
    // commitWithReceipt signs the receipt, and signReceipt refuses to run
    // without this. Without it the two happy-path commits below throw at the
    // signature, before they ever reach the audit insert or the pending_writes
    // update, so the assertions would test nothing.
    APPROVAL_HMAC_SECRET: 'test-secret',
  }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
// The id the queued marketing_actions row answers with, and the id the receipt
// row answers with, both in this file's id style.
const ACTION = '88888888-8888-4888-8888-888888888888'
const RECEIPT = '99999999-9999-4999-8999-999999999999'

// The one-page fixture the page-bundle drafts below stage against, and the hash
// a stage would have recorded for those bytes. Since the approval compares
// unconditionally, a draft for a bundle that has a page must carry this value;
// null would mean the payload identified no page, and the approval refuses.
const PAGE_TEXT = '<h1>Free scan</h1>'
const PAGE_HASH = siteHashOf(
  resolveSite('free-scan', [{ id: 'a1', kind: 'page_html', textContent: PAGE_TEXT }]),
)

function stubQueries(handlers: Record<string, Record<string, unknown>[]>) {
  mockQuery.mockImplementation((sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return Promise.resolve({ rows: [] })
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function stageDraft(payload: Record<string, unknown>): PendingWrite {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT,
    runId: 'pending',
    threadId: null,
    objectType: 'marketing_stage',
    operation: 'update',
    targetId: BUNDLE,
    payload,
    riskScore: 10,
    gate: 'approval',
    draftHash: 'stage-key',
    receiptId: null,
    rejectedAt: null,
    rejectionReason: null,
    committedAt: null,
    committedRecordId: null,
    requestedBy: APPROVER,
    createdAt: '2026-10-30T00:00:00.000Z',
    expiresAt: '2026-10-30T01:00:00.000Z',
  }
}

// A Meta campaign id. It is a decimal string, not a uuid, which is why the draft
// carries it in payload.campaignId and target_id holds Task 15's derived uuid.
const CAMPAIGN = '23842653876'

/**
 * A draft as `stageCampaignStatusChange` now writes it: the object type the
 * analyst cron stages, the `update` operation the branch requires, and the
 * derived target id. The branch never reads target_id — the campaign lives at
 * Meta and the payload names it — so the value here is scenery.
 */
function statusDraft(payload: Record<string, unknown>): PendingWrite {
  return {
    ...stageDraft(payload),
    objectType: 'marketing_set_campaign_status',
    operation: 'update',
    targetId: '77777777-7777-4777-8777-777777777777',
  }
}

// Same helper as Task 2's marketing.test.ts fix: the stubs below answer a
// matched fragment with a fixed row for ANY params, so a stub's return value
// proves nothing about what a write actually scoped by. Read the recorded call
// and assert its SQL text and its real parameter array instead.
function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

interface CommitFixture {
  bundle: Record<string, unknown>
  artifacts: Record<string, unknown>[]
}

/**
 * A client for the commit alone, without the pg pool above: the two reads it
 * makes before it decides, and an empty answer for the write a refused case must
 * never reach. The commit's client type is generic over the row shape, so the
 * fake hands back `T[]` for whichever T the caller asked for; the rows are the
 * real shapes for the SQL branch they answer.
 */
function clientWith(fixture: CommitFixture) {
  return {
    query: <T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
      const rows: unknown[] = sql.includes('FROM marketing_bundles')
        ? [fixture.bundle]
        : sql.includes('FROM marketing_artifacts')
          ? fixture.artifacts
          : []
      return Promise.resolve({ rows: rows as T[] })
    },
  }
}

// No auditRow helper here: all three tests stub 'INSERT INTO audit_receipts' by
// SQL fragment, so a full receipt row is never constructed, and an unused helper
// function is an `@typescript-eslint/no-unused-vars` error (eslint.config.js:47).

beforeEach(() => {
  mockQuery.mockReset()
})

describe('approving a marketing stage draft', () => {
  it('refuses a bundle whose plan asks for an unadapted action, and signs nothing', async () => {
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
      'FROM marketing_bundles': [
        { id: BUNDLE, status: 'staged', objective: 'inbound_leads', funnel_plan: { page: { slug: 'free-scan' } }, media_plan: null },
      ],
      // The publish action is derived from the stored bytes now, so the bundle
      // needs a page artifact as well as a slug to ask for one.
      'FROM marketing_artifacts': [
        { id: 'a1', kind: 'page_html', text_content: PAGE_TEXT },
      ],
    })
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    await expect(
      commitWithReceipt(stageDraft({ bundleId: BUNDLE, siteHash: PAGE_HASH }), { approvedBy: APPROVER, scope: 'crm:write' }),
    ).rejects.toThrow(UnsupportedCommitError)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO audit_receipts'))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('ROLLBACK'))).toBe(true)
    // The guard's promise is stronger than "no receipt was signed": the bundle was
    // never even marked approved. Naming the write states that, and it holds even if
    // a later version of this case stubs the UPDATE the way the approval case does.
    expect(calls("UPDATE marketing_bundles SET status = 'approved'")).toEqual([])
  })

  it('refuses a staged draft whose plan names a slug the site cannot publish', async () => {
    // Slice 1 fixtures wrote slugs like '/free-scan', which SLUG_PATTERN
    // refuses, so this is reachable stored data rather than a hypothetical.
    // resolveSite throws SlugProblemError on it, and an untranslated throw would
    // leave this approval as a 500 instead of the refusal applyDraft reports.
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
      'FROM marketing_bundles': [
        { id: BUNDLE, status: 'staged', objective: 'inbound_leads', funnel_plan: { page: { slug: '/free-scan' } }, media_plan: null },
      ],
      'FROM marketing_artifacts': [],
    })
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    const attempt = commitWithReceipt(stageDraft({ bundleId: BUNDLE }), {
      approvedBy: APPROVER,
      scope: 'crm:write',
    })
    await expect(attempt).rejects.toThrow(UnsupportedCommitError)
    // The refusal carries the slug sentence, so the reviewer learns which path
    // is unusable rather than reading a generic commit failure.
    await expect(attempt).rejects.toThrow(/slug_.*cannot be published/)
    await expect(attempt).rejects.toThrow(/free-scan/)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO audit_receipts'))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('ROLLBACK'))).toBe(true)
  })

  it('approves a content-only bundle and writes the receipt against the bundle id', async () => {
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
      'FROM marketing_bundles': [
        { id: BUNDLE, status: 'staged', objective: 'outreach_support', funnel_plan: null, media_plan: null },
      ],
      'FROM marketing_artifacts': [],
      "UPDATE marketing_bundles SET status = 'approved'": [{ id: BUNDLE }],
      'INSERT INTO audit_receipts': [{ id: 'receipt-1' }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const { commitWithReceipt } = await import('../../src/db/pending-writes')
    const result = await commitWithReceipt(stageDraft({ bundleId: BUNDLE }), {
      approvedBy: APPROVER,
      scope: 'crm:write',
    })
    expect(result.committedId).toBe(BUNDLE)
    expect(result.receiptId).toBe('receipt-1')
    // The 'approved' stub above hands back [{ id: BUNDLE }] whatever the params
    // are, so committedId/receiptId never prove the write was tenant-scoped.
    // Read the UPDATE the code actually issued: its SQL must carry the tenant
    // predicate and RETURNING id, and its params must be the caller's
    // [bundleId, tenantId] in that order. Drop `AND tenant_id = $2` from
    // commitBundleApproval's UPDATE and this assertion is what fails.
    const [update] = calls("UPDATE marketing_bundles SET status = 'approved'")
    expect(update?.sql).toContain('tenant_id = $2')
    expect(update?.sql).toContain('RETURNING id')
    expect(update?.params).toEqual([BUNDLE, TENANT])
  })

  it('passes a null receipt id to the outbox, because the receipt does not exist yet', async () => {
    // A content-only bundle derives no actions, so its receiptId is never
    // observable. To see the value the branch actually passes, the bundle must
    // ask for an action and an adapter must exist, or commitBundleApproval
    // refuses before it reaches the INSERT.
    const { registerActionAdapter } = await import('../../src/marketing/outbox')
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'unused' }),
    })
    try {
      stubQueries({
        'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [{ receipt_id: null, rejected_at: null, committed_at: null }],
        'FROM marketing_bundles': [
          { id: BUNDLE, status: 'staged', objective: 'inbound_leads', funnel_plan: { page: { slug: 'free-scan' } }, media_plan: null },
        ],
        'FROM marketing_artifacts': [
          { id: 'a1', kind: 'page_html', text_content: PAGE_TEXT },
        ],
        "UPDATE marketing_bundles SET status = 'approved'": [{ id: BUNDLE }],
        'INSERT INTO marketing_actions': [{ id: 'action-1' }],
        'INSERT INTO audit_receipts': [{ id: 'receipt-1' }],
        'UPDATE pending_writes SET receipt_id': [],
      })
      const { commitWithReceipt } = await import('../../src/db/pending-writes')
      await commitWithReceipt(stageDraft({ bundleId: BUNDLE, siteHash: PAGE_HASH }), {
        approvedBy: APPROVER,
        scope: 'crm:write',
      })
      const [enqueue] = calls('INSERT INTO marketing_actions')
      expect(enqueue).toBeDefined()
      // ['queued', receipt_id] is the tail. The last param is the receipt id the
      // branch hands over, and it must be null: commitWithReceipt signs its
      // receipt only after applyDraft returns, so no real id exists to write.
      // The payload is the one the approval re-derived under the lock: the same
      // hash the stage payload carried for these bytes. PAGE_HASH is computed
      // from site.ts rather than pasted, so a commit that enqueued a slug or a
      // constant fails.
      const expectedPayload = {
        bundleId: BUNDLE,
        slug: 'free-scan',
        siteHash: PAGE_HASH,
      }
      expect(enqueue?.params).toEqual([
        TENANT,
        BUNDLE,
        'publish_page',
        JSON.stringify(expectedPayload),
        null,
      ])
    } finally {
      unregister()
    }
  })
})

describe('the review-to-commit byte re-check', () => {
  it('refuses to approve when the bytes moved after staging', async () => {
    const client = clientWith({
      bundle: { id: 'b1', status: 'staged', funnel_plan: { page: { slug: 's' } }, media_plan: null },
      artifacts: [{ id: 'a1', kind: 'page_html', text_content: '<h1>changed</h1>' }],
    })
    const { commitBundleApproval } = await import('../../src/marketing/outbox')
    await expect(
      commitBundleApproval(client, {
        tenantId: TENANT,
        bundleId: 'b1',
        receiptId: null,
        expectedSiteHash: '0'.repeat(64),
      }),
    ).rejects.toThrow(/no longer hashes/)
  })

  it('refuses to approve a page the staged payload never identified', async () => {
    // The other direction the null guard used to let through: the bundle had no
    // page when it was staged, so the payload identified no bytes, and a
    // page_html arrived before approval. There is nothing to compare, and a
    // commit over bytes the reviewer never saw is the failure the re-check
    // exists to prevent, so the only safe answer is to refuse.
    const client = clientWith({
      bundle: { id: 'b1', status: 'staged', funnel_plan: { page: { slug: 's' } }, media_plan: null },
      artifacts: [{ id: 'a1', kind: 'page_html', text_content: '<h1>added later</h1>' }],
    })
    const { commitBundleApproval } = await import('../../src/marketing/outbox')
    const attempt = commitBundleApproval(client, {
      tenantId: TENANT,
      bundleId: 'b1',
      receiptId: null,
      expectedSiteHash: null,
    })
    await expect(attempt).rejects.toThrow(/no longer hashes/)
    // The staged side must say what it has, not print the word `null`.
    await expect(attempt).rejects.toThrow(/nothing staged/)
  })

  it('refuses to approve a page that was deleted after staging', async () => {
    // The mirror of the case above, and the direction the last fix left
    // untested: the payload carried the hash of a page the reviewer saw, and the
    // page_html row is gone by approval. The plan still names a slug, so a
    // derivation that trusted the plan alone would enqueue a publish over a file
    // set that is now empty. The live side must read 'nothing', not a hash.
    const client = clientWith({
      bundle: { id: 'b1', status: 'staged', funnel_plan: { page: { slug: 'free-scan' } }, media_plan: null },
      artifacts: [],
    })
    const { commitBundleApproval } = await import('../../src/marketing/outbox')
    const attempt = commitBundleApproval(client, {
      tenantId: TENANT,
      bundleId: 'b1',
      receiptId: null,
      expectedSiteHash: PAGE_HASH,
    })
    await expect(attempt).rejects.toThrow(/no longer hashes/)
    await expect(attempt).rejects.toThrow(/nothing now/)
  })
})

/**
 * Approving a `marketing_set_campaign_status` draft has to queue the work order
 * instead of 500ing. Until Task 16 the type fell through every branch of
 * applyDraft into `requireTarget`, which throws `UnsupportedCommitError` for
 * 'no CRM table commits object_type', so the owner's click failed and the
 * campaign never changed. These cases are what the new branch answers, and the
 * last assertion in each is the one that matters: a refusal that signs a receipt
 * is not a refusal.
 *
 * Stub-ordering note for every case below: `status = 'succeeded'` appears in
 * both the create_campaign existence read and the latest-status read, so
 * keying on it would let the first handler answer both. `stubQueries` matches
 * in insertion order, so these use the fragments that differ —
 * `"action = 'create_campaign'"` for the origin read, `"action = 'set_campaign_status'"`
 * for the latest-status read, and the INSERT last.
 */
describe('approving a campaign status draft', () => {
  it('refuses a status draft that is not an update', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
    })
    const draft = { ...statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }), operation: 'create' as const }
    const attempt = commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:status' })
    await expect(attempt).rejects.toThrow(UnsupportedCommitError)
    // The refusal says which operation it wants, so the reviewer learns the
    // draft is the wrong shape rather than reading a generic commit failure.
    await expect(attempt).rejects.toThrow(/update/)
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })

  it('refuses a status draft whose payload asks for a status this lane does not stage', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
    })
    const attempt = commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ARCHIVED' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    await expect(attempt).rejects.toThrow(UnsupportedCommitError)
    // The value it was given has to be in the sentence. ARCHIVED is a status Meta
    // itself recognises, which is the point of the case: the refusal is about what
    // this lane is allowed to stage, not about what the provider would accept, so
    // a reader has to be able to see which value the draft actually carried.
    await expect(attempt).rejects.toThrow(/ARCHIVED/)
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })

  it('refuses a status draft whose payload names no campaign', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
    })
    // No caller can produce either draft today: stageCampaignStatusChange always
    // writes a non-empty campaignId (src/mastra/tools/marketing-writes.ts:957), and
    // an empty one would also fail the existence read below. The guard is still
    // pinned, because the adapter addresses Meta from this field alone, so the next
    // caller, Task 17's tool most likely, inherits the shape of what is staged here.
    const empty = commitWithReceipt(
      statusDraft({ campaignId: '', status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    await expect(empty).rejects.toThrow(UnsupportedCommitError)
    await expect(empty).rejects.toThrow(/must name a campaign/)
    const absent = commitWithReceipt(
      statusDraft({ status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    await expect(absent).rejects.toThrow(UnsupportedCommitError)
    // Both halves of one guard: the key missing entirely, and above it the key
    // present but empty. A wrong-type value lands on the same typeof test, so it
    // needs no third case, and the message is the same sentence either way.
    await expect(absent).rejects.toThrow(/must name a campaign/)
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })

  it('refuses a status draft for a campaign this tenant never created', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      // The origin read finds no succeeded create_campaign for this id.
      "action = 'create_campaign'": [],
    })
    const attempt = commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    await expect(attempt).rejects.toThrow(UnsupportedCommitError)
    await expect(attempt).rejects.toThrow(new RegExp(CAMPAIGN))
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })

  it('refuses a status draft that repeats the last succeeded status change', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      "action = 'create_campaign'": [{ bundle_id: BUNDLE }],
      // The campaign is already ACTIVE as far as CRUM knows, so approving this
      // would queue a work order that changes nothing.
      "action = 'set_campaign_status'": [{ status: 'ACTIVE' }],
    })
    const attempt = commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    await expect(attempt).rejects.toThrow(UnsupportedCommitError)
    await expect(attempt).rejects.toThrow(new RegExp(CAMPAIGN))
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })

  it('queues the work order and returns the action row as the committed record', async () => {
    const { commitWithReceipt } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      "action = 'create_campaign'": [{ bundle_id: BUNDLE }],
      "action = 'set_campaign_status'": [],
      'INSERT INTO marketing_actions': [{ id: ACTION }],
      'INSERT INTO audit_receipts': [{ id: RECEIPT }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const result = await commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    expect(result.committedId).toBe(ACTION)
    expect(result.receiptId).toBe(RECEIPT)
    const insert = calls('INSERT INTO marketing_actions').at(-1)!
    expect(insert.sql).toContain(`'set_campaign_status'`)
    // The bundle comes from the origin row, not the payload, and the params are
    // what proves it: a fragment stub answers any params, so read the call.
    expect(insert.params[0]).toBe(TENANT)
    expect(insert.params[1]).toBe(BUNDLE)
    expect(JSON.parse(insert.params[2] as string)).toEqual({ campaignId: CAMPAIGN, status: 'ACTIVE' })
    // NULL, not draft.receiptId: the receipt does not exist at this instant.
    expect(insert.sql).toMatch(/'queued', NULL\)/)
    // The receipt has to point at the row it signed, or a reviewer cannot trace
    // an approval to the work order it authorised. committed_record_id is sixth
    // in the INSERT column list at src/db/pending-writes.ts:693.
    const receipt = calls('INSERT INTO audit_receipts').at(-1)!
    expect(receipt.params[5]).toBe(ACTION)
  })
})

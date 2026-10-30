import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  // commitAutoWrite runs the apply inside a transaction, so the pool has to hand
  // back a client that answers from the same query stub.
  connect: vi.fn(() => Promise.resolve(mockClient)),
  end: vi.fn(),
}

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const rc = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  userRole: 'admin' as const,
}

const PROSPECT_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555'
const SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666'
const PENDING_ID = '77777777-7777-4777-8777-777777777777'
const HUMAN_TASK_ID = '88888888-8888-4888-8888-888888888888'

type Row = Record<string, unknown>

function stubQueries(handlers: Record<string, Row[]>): void {
  mockQuery.mockImplementation((sql: string) => {
    // commitAutoWrite applies the write inside a transaction; the control
    // statements return no rows and never need a per-test handler.
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return Promise.resolve({ rows: [] })
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function queryCall(fragment: string): { sql: string; params: unknown[] } | undefined {
  for (const call of mockQuery.mock.calls as unknown[][]) {
    const sql = call[0] as string
    if (sql.includes(fragment)) return { sql, params: (call[1] ?? []) as unknown[] }
  }
  return undefined
}

/** The JSON payload handed to getOrCreateDraft, as pending_writes stores it. */
function stagedPayload(): Record<string, unknown> {
  const insert = queryCall('INSERT INTO pending_writes')
  if (!insert) throw new Error('no pending_writes insert was issued')
  return JSON.parse(insert.params[6] as string) as Record<string, unknown>
}

function toolContext(): unknown {
  return {
    requestContext: { all: rc },
    observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
  }
}

interface StagedResult {
  pendingWriteId: string
  proceed?: boolean
  reason?: string
}

type ExecuteFn = (input: Record<string, unknown>, context: unknown) => Promise<StagedResult>

async function runSend(input: Record<string, unknown>): Promise<StagedResult> {
  const { sendOutreachTool } = await import('../../src/mastra/tools/prospect-writes')
  const execute = sendOutreachTool.execute as unknown as ExecuteFn
  return execute(input, toolContext())
}

async function runDraft(input: Record<string, unknown>): Promise<StagedResult> {
  const { draftOutreachTool } = await import('../../src/mastra/tools/prospect-writes')
  const execute = draftOutreachTool.execute as unknown as ExecuteFn
  return execute(input, toolContext())
}

function sendInput(): Record<string, unknown> {
  return { draftId: DRAFT_ID, channel: 'instagram', actionHash: 'caller-supplied-hash' }
}

function draftInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prospectId: PROSPECT_ID,
    channelId: CHANNEL_ID,
    stage: 'first_touch',
    channel: 'dm',
    body: 'Saw your Sydney studio and the course page.',
    language: 'en',
    angle: 'funnel_gap',
    evidenceSnapshotId: null,
    promptVersion: 'v1',
    draftHash: 'draft-hash-1',
    ...overrides,
  }
}

const DRAFT_BODY = 'Saw your Sydney studio and the course page.'
const CHANNEL_HANDLE = '@sydneystudio'

function draftRow(status: string): Row {
  return {
    id: DRAFT_ID,
    prospect_id: PROSPECT_ID,
    channel_id: CHANNEL_ID,
    status,
    body: DRAFT_BODY,
    language: 'en',
    country: 'AU',
  }
}

/** A committed-or-not pending_writes row, as RETURNING * hands it back. */
function pendingWriteRow(overrides: Row = {}): Row {
  return {
    id: PENDING_ID,
    tenant_id: rc.tenantId,
    run_id: 'pending',
    thread_id: null,
    object_type: 'outreach_draft',
    operation: 'create',
    target_id: null,
    payload: {},
    risk_score: 10,
    gate: 'auto',
    draft_hash: 'draft:draft-hash-1',
    receipt_id: null,
    rejected_at: null,
    committed_at: null,
    committed_record_id: null,
    requested_by: rc.userId,
    created_at: '2026-11-03T12:00:00.000Z',
    expires_at: '2026-11-03T13:00:00.000Z',
    ...overrides,
  }
}

// The cap engine reads the wall clock, so pin it to a weekday daytime hour in a
// fixed zone (city quiet hours are 20:00-08:00): otherwise these tests would
// refuse with quiet_hours and the consent/cap assertions would never be reached.
beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'))
  process.env.PROSPECT_TIMEZONE = 'UTC'
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.PROSPECT_TIMEZONE
})

describe('crm.send_outreach safety checks', () => {
  it('throws already_sent when replaying a draft that is already sent', async () => {
    stubQueries({
      'p.country': [draftRow('sent')],
    })

    await expect(runSend(sendInput())).rejects.toThrow('already_sent')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('throws not_approved for a draft that was never approved', async () => {
    stubQueries({
      'p.country': [draftRow('drafted')],
    })

    await expect(runSend(sendInput())).rejects.toThrow('not_approved')
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses an email send with no consent row', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [{ platform: 'email', handle: 'a@b.co' }],
      'FROM prospect_consents': [],
      'JOIN prospect_channels c': [],
      'INSERT INTO human_tasks': [{ id: HUMAN_TASK_ID }],
    })

    const result = await runSend({ ...sendInput(), channel: 'email' })

    expect(result.proceed).toBe(false)
    expect(result.reason).toBe('no_consent')
    expect(queryCall('INSERT INTO human_tasks')?.params[3]).toBe('refusal')
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses when the daily DM cap is already spent', async () => {
    const ledger = Array.from({ length: 20 }, (_, i) => ({
      prospect_id: PROSPECT_ID,
      platform: 'instagram',
      sent_at: `2026-11-03T11:${String(i).padStart(2, '0')}:00Z`,
    }))
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [
        { platform: 'instagram', handle: CHANNEL_HANDLE },
      ],
      'FROM prospect_consents': [{ '?column?': 1 }],
      'JOIN prospect_channels c': ledger,
      'INSERT INTO human_tasks': [{ id: HUMAN_TASK_ID }],
    })

    const result = await runSend(sendInput())

    expect(result.proceed).toBe(false)
    expect(result.reason).toBe('daily_cap')
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('keys the staged send on the draft id, not the caller actionHash', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [
        { platform: 'linkedin', handle: 'in/sydneystudio' },
      ],
      'FROM prospect_consents': [],
      'JOIN prospect_channels c': [],
      'INSERT INTO pending_writes': [{ id: PENDING_ID }],
    })

    const result = await runSend({ ...sendInput(), channel: 'linkedin' })

    expect(result.pendingWriteId).toBe(PENDING_ID)
    expect(queryCall('INSERT INTO pending_writes')?.params[9]).toBe(`send:${DRAFT_ID}`)
  })

  // The approver used to see only `{ status: 'sent', sentAt }`, which hid both
  // who the message goes to and what it says.
  it('stages the body and handle the approver needs, read from the stored rows', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [
        { platform: 'instagram', handle: CHANNEL_HANDLE },
      ],
      'FROM prospect_consents': [],
      'JOIN prospect_channels c': [],
      'INSERT INTO pending_writes': [{ id: PENDING_ID }],
    })

    await runSend(sendInput())

    const staged = stagedPayload()
    expect(staged).toMatchObject({
      status: 'sent',
      prospectId: PROSPECT_ID,
      platform: 'instagram',
      handle: CHANNEL_HANDLE,
      body: DRAFT_BODY,
      language: 'en',
    })
  })

  it('scopes the channel lookup to the draft prospect, not just the tenant', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      // The channel id exists in the tenant but belongs to another prospect, so
      // the prospect-scoped query matches nothing.
      'SELECT platform, handle FROM prospect_channels': [],
    })

    await expect(runSend(sendInput())).rejects.toThrow('channel_not_found')
    const lookup = queryCall('SELECT platform, handle FROM prospect_channels')
    expect(lookup?.sql).toContain('prospect_id = $3')
    expect(lookup?.params).toEqual([CHANNEL_ID, rc.tenantId, PROSPECT_ID])
  })

  it('throws unsupported_channel for a website channel that cannot be messaged', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [
        { platform: 'website', handle: 'sydneystudio.com' },
      ],
    })

    await expect(runSend(sendInput())).rejects.toThrow('unsupported_channel')
    expect(queryCall('FROM prospect_consents')).toBeUndefined()
    expect(queryCall('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('returns the human task id, not the draft id, when caps refuse a send', async () => {
    stubQueries({
      'p.country': [draftRow('approved')],
      'SELECT platform, handle FROM prospect_channels': [{ platform: 'email', handle: 'a@b.co' }],
      'FROM prospect_consents': [],
      'JOIN prospect_channels c': [],
      'INSERT INTO human_tasks': [{ id: HUMAN_TASK_ID }],
    })

    const result = await runSend({ ...sendInput(), channel: 'email' })

    expect(result.pendingWriteId).toBe(HUMAN_TASK_ID)
    expect(result.pendingWriteId).not.toBe(DRAFT_ID)
  })
})

describe('crm.draft_outreach safety checks', () => {
  it('throws channel_mismatch when the declared channel contradicts the platform', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [{ platform: 'instagram' }],
    })

    await expect(runDraft(draftInput({ channel: 'email' }))).rejects.toThrow('channel_mismatch')
  })

  it('throws not_found when the channel belongs to another tenant', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [],
    })

    await expect(runDraft(draftInput())).rejects.toThrow('not_found')
  })

  it('throws not_found when the channel belongs to another prospect in the tenant', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      // Same tenant, other prospect: the prospect-scoped query matches nothing.
      'SELECT platform FROM prospect_channels': [],
    })

    await expect(
      runDraft(draftInput({ prospectId: PROSPECT_ID, channelId: CHANNEL_ID })),
    ).rejects.toThrow('not_found')
    const lookup = queryCall('SELECT platform FROM prospect_channels')
    expect(lookup?.sql).toContain('prospect_id = $3')
    expect(lookup?.params).toEqual([CHANNEL_ID, rc.tenantId, PROSPECT_ID])
  })

  it('throws not_found when the evidence snapshot belongs to another prospect', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [{ platform: 'instagram' }],
      'FROM prospect_snapshots': [],
    })

    await expect(
      runDraft(draftInput({ evidenceSnapshotId: SNAPSHOT_ID })),
    ).rejects.toThrow('not_found')
    const lookup = queryCall('FROM prospect_snapshots')
    expect(lookup?.sql).toContain('prospect_id = $3')
    expect(lookup?.params).toEqual([SNAPSHOT_ID, rc.tenantId, PROSPECT_ID])
  })

  // Drafting is an `auto` class tool, so a staged-only draft left
  // outreach_drafts empty and send_outreach with no id to act on.
  it('commits an auto draft and returns the committed outreach_drafts id', async () => {
    const payload = {
      prospectId: PROSPECT_ID,
      channelId: CHANNEL_ID,
      stage: 'first_touch',
      body: DRAFT_BODY,
      language: 'en',
      angle: 'funnel_gap',
      status: 'approved',
      evidenceSnapshotId: SNAPSHOT_ID,
      promptVersion: 'v1',
      draftHash: 'draft-hash-1',
    }
    const staged = pendingWriteRow({ payload })
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [{ platform: 'instagram' }],
      'FROM prospect_snapshots': [{ id: SNAPSHOT_ID }],
      'SELECT * FROM pending_writes': [staged],
      'INSERT INTO pending_writes': [staged],
      'INSERT INTO outreach_drafts': [{ id: DRAFT_ID }],
      'UPDATE pending_writes SET committed_at': [],
    })

    const result = await runDraft(draftInput({ evidenceSnapshotId: SNAPSHOT_ID }))

    expect(result.pendingWriteId).toBe(DRAFT_ID)
    // Committing the draft row is the content approval send_outreach relies on.
    expect(stagedPayload().status).toBe('approved')
    const insert = queryCall('INSERT INTO outreach_drafts')
    expect(insert).toBeDefined()
    expect(insert?.params[0]).toBe(rc.tenantId)
    // Auto writes commit without a receipt: there is no approval to sign.
    expect(queryCall('INSERT INTO audit_receipts')).toBeUndefined()
  })

  it('namespaces the idempotency key so a caller cannot collide with a send key', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [{ platform: 'instagram' }],
      'FROM prospect_snapshots': [{ id: SNAPSHOT_ID }],
      'INSERT INTO pending_writes': [{ id: PENDING_ID }],
    })

    const result = await runDraft(
      draftInput({ evidenceSnapshotId: SNAPSHOT_ID, draftHash: 'send:00000000-0000-4000-8000-000000000000' }),
    )

    // The `send` token in the hash also escalates the risk score, so this one
    // correctly stays staged as a pending write rather than committing.
    expect(result.pendingWriteId).toBe(PENDING_ID)
    expect(queryCall('INSERT INTO pending_writes')?.params[9]).toBe(
      'draft:send:00000000-0000-4000-8000-000000000000',
    )
  })

  it('throws stage_order when a follow-up has no sent draft behind it', async () => {
    stubQueries({
      'FROM prospects WHERE id': [{ id: PROSPECT_ID }],
      'SELECT platform FROM prospect_channels': [{ platform: 'instagram' }],
      'FROM prospect_snapshots': [{ id: SNAPSHOT_ID }],
      'LIMIT 1': [],
    })

    await expect(
      runDraft(draftInput({ stage: 'followup_1', evidenceSnapshotId: SNAPSHOT_ID })),
    ).rejects.toThrow('stage_order')
  })
})

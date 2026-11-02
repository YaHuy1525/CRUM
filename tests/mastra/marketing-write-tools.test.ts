import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBundleHash } from '../../src/marketing/hash'
import { LEAD_ENDPOINT_PLACEHOLDER } from '../../src/marketing/lead-token'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { resolveSite, siteHashOf } from '@/marketing/site'

const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = {
  query: mockQuery,
  // commitAutoWrite applies inside a transaction, so the client answers from
  // the same stub.
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

const TENANT = rc.tenantId
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555'
// The credential a bundle carries once its page has been published: a uuid,
// because gen_random_uuid() is the column default and a mint has to match it.
const LEAD_TOKEN = '88888888-8888-4888-8888-888888888888'

type Row = Record<string, unknown>

function pendingWriteRow(over: Row = {}): Row {
  return {
    id: DRAFT_ID,
    tenant_id: TENANT,
    run_id: 'auto',
    thread_id: null,
    object_type: 'marketing_bundle',
    operation: 'create',
    target_id: null,
    payload: {},
    risk_score: 10,
    gate: 'auto',
    draft_hash: 'hash',
    receipt_id: null,
    rejected_at: null,
    // committed_at null: commitAutoWrite returns early on a committed draft.
    committed_at: null,
    committed_record_id: null,
    requested_by: rc.userId,
    created_at: '2026-10-30T00:00:00.000Z',
    expires_at: '2026-10-30T01:00:00.000Z',
    ...over,
  }
}

function stubQueries(handlers: Record<string, Row[]>): void {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return Promise.resolve({ rows: [] })
    // A real `INSERT ... RETURNING *` hands back the row it wrote, payload and
    // all, and commitAutoWrite applies the write from that row. The fixture
    // therefore echoes the staged payload (params[6], jsonb parsed the way
    // node-pg returns it) instead of the placeholder `payload: {}` on
    // pendingWriteRow: otherwise the bundle insert would map an empty payload
    // and the test would assert on fixture data rather than tool data.
    if (sql.includes('INSERT INTO pending_writes') && handlers['INSERT INTO pending_writes']) {
      const staged = params?.[6]
      const rows = handlers['INSERT INTO pending_writes'].map((row) => ({
        ...row,
        // A fixture that sets its own payload is simulating the ON CONFLICT no-op:
        // an open draft is handed back with the numbers it was created with, which
        // is the one thing this tool cannot reproduce from its own input. Every
        // existing fixture leaves payload as {} and still gets the echo.
        payload:
          row.payload && Object.keys(row.payload).length > 0
            ? row.payload
            : typeof staged === 'string'
              ? (JSON.parse(staged) as Row)
              : row.payload,
      }))
      return Promise.resolve({ rows })
    }
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (sql.includes(fragment)) return Promise.resolve({ rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

function call(fragment: string): { sql: string; params: unknown[] } | undefined {
  for (const raw of mockQuery.mock.calls as unknown[][]) {
    const sql = raw[0] as string
    if (sql.includes(fragment)) return { sql, params: (raw[1] ?? []) as unknown[] }
  }
  return undefined
}

function toolContext(): unknown {
  return {
    requestContext: { all: rc },
    observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
  }
}

function bundleInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief: 'Book more assessment calls with Melbourne physio clinics',
    objective: 'outreach_support',
    audienceNote: 'owner-led clinics, two to eight practitioners',
    strategy: { position: 'the clinic that answers within the hour' },
    copy: { hooks: ['Your next patient is already searching'], dm: 'Hello' },
    mediaPlan: null,
    funnelPlan: null,
    analysis: null,
    promptVersion: 'marketing-v1',
    artifacts: [],
    ...over,
  }
}

interface SaveResult {
  pendingWriteId: string
  bundleId?: string
  riskScore: number
  gate: string
  artifactCount: number
  message: string
}

type ExecuteFn = (input: Record<string, unknown>, context: unknown) => Promise<SaveResult>

async function save(input: Record<string, unknown>): Promise<SaveResult> {
  const { saveBundleTool } = await import('../../src/mastra/tools/marketing-writes')
  const execute = saveBundleTool.execute as unknown as ExecuteFn
  return execute(input, toolContext())
}

function bundleRow(over: Row = {}): Row {
  return {
    id: BUNDLE_ID,
    tenant_id: TENANT,
    brief: 'Book more assessment calls with Melbourne physio clinics',
    objective: 'outreach_support',
    audience_note: 'owner-led clinics',
    status: 'draft',
    strategy: { position: 'the clinic that answers within the hour' },
    copy: { hooks: ['Your next patient is already searching'] },
    media_plan: null,
    funnel_plan: null,
    analysis: null,
    prompt_version: 'marketing-v1',
    draft_hash: 'saved-hash',
    lead_token: null,
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    ...over,
  }
}

function stagedInsert(): Record<string, unknown> {
  const insert = call('INSERT INTO pending_writes')
  if (!insert) throw new Error('no pending_writes insert was issued')
  return JSON.parse(insert.params[6] as string) as Record<string, unknown>
}

/**
 * One stored artifact row, shaped as listMarketingArtifacts selects it. The
 * stage tool reads rows rather than a count, so every stage fixture needs the
 * select answered, and a page fixture needs a page_html to derive a publish from.
 */
function artifactRow(over: Row = {}): Row {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    role: 'funnel-builder',
    kind: 'page_html',
    document_id: null,
    text_content: '<h1>Physio in an hour</h1>',
    status: 'active',
    created_at: '2026-10-30T00:00:00.000Z',
    ...over,
  }
}

interface StageResult {
  pendingWriteId: string
  riskScore: number
  gate: string
  proceed?: boolean
  reason?: string
  assetsUnreferenced?: string[]
  message: string
}

type StageExecuteFn = (input: Record<string, unknown>, context: unknown) => Promise<StageResult>

async function stage(input: Record<string, unknown>) {
  const { stageBundleTool } = await import('../../src/mastra/tools/marketing-writes')
  const execute = stageBundleTool.execute as unknown as StageExecuteFn
  return execute(input, toolContext())
}

beforeEach(() => {
  mockQuery.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('marketing.save_bundle', () => {
  it('commits the bundle row in the same call, because drafting is auto class', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
    })
    const result = await save(bundleInput())
    const insert = call('INSERT INTO marketing_bundles')
    expect(insert?.sql).toContain('tenant_id')
    expect(result).toMatchObject({ bundleId: BUNDLE_ID, gate: 'auto', artifactCount: 0 })
  })

  it('writes each jsonb column as JSON text, not a Postgres array literal', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
    })
    await save(bundleInput())
    const insert = call('INSERT INTO marketing_bundles')
    const serialized = JSON.stringify((insert?.params ?? []).find((p) => typeof p === 'string' && p.startsWith('{')))
    expect(serialized).toContain('position')
  })

  /**
   * The `columns` object the tool feeds to computeBundleHash and the `payload`
   * object it hands to getOrCreateDraft are hand-written twins: the first keys
   * the draft, the second is committed as the marketing_bundles row. The type
   * system does not tie them, so a lane dropped from either would quietly desync
   * the hash from the stored bundle. Recomputing the hash from the staged payload
   * and requiring it to equal the staged idempotency key turns that desync into a
   * failing test: remove `mediaPlan` (or any lane) from one object and the two
   * hashes differ here.
   */
  it('keeps the hashed columns and the committed payload describing one bundle', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
    })
    await save(bundleInput())

    const staged = call('INSERT INTO pending_writes')!
    // getOrCreateDraft JSON.stringifies the payload object into param 6 and the
    // `bundle:<hash>` key into param 9; both come straight from the tool.
    const payload = JSON.parse(String(staged.params[6])) as Record<string, unknown>
    // The commit path stores each jsonb lane as JSON text (or null), so read a
    // string lane back to the shape the hash path saw before recomputing.
    const lane = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)
    const recomputed = computeBundleHash({
      brief: payload.brief as string,
      objective: payload.objective as string,
      audienceNote: (payload.audienceNote ?? null) as string | null,
      strategy: lane(payload.strategy),
      copy: lane(payload.copy),
      mediaPlan: lane(payload.mediaPlan),
      funnelPlan: lane(payload.funnelPlan),
      analysis: lane(payload.analysis),
      promptVersion: payload.promptVersion as string,
    })
    expect(String(staged.params[9])).toBe(`bundle:${recomputed}`)
  })

  /**
   * The regression the spec's section 7 exists for. Marketing prose says
   * ordinary sales things: 'send' is irreversible and 'every' is high blast, so
   * scoring the payload itself would put this tool at 90 and refuse a good
   * bundle before it was ever stored.
   */
  it('stays auto when the copy contains an irreversible term and a high-blast term', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
    })
    const result = await save(
      bundleInput({ copy: { hooks: ['We send a quote to every homeowner the same day'] } }),
    )
    const staged = call('INSERT INTO pending_writes')
    expect(result).toMatchObject({ gate: 'auto', riskScore: 10 })
    expect(staged?.params[8]).toBe('auto')
    expect(String(staged?.params[7])).toBe('10')
  })

  it('keys the draft on the content hash, so a replayed save is one bundle', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
    })
    await save(bundleInput())
    const key = String(call('INSERT INTO pending_writes')?.params[9])
    expect(key).toMatch(/^bundle:[0-9a-f]{64}$/)
  })

  /**
   * Task 11's end-to-end proof leans on replaying a save producing one bundle.
   * When the `INSERT ... RETURNING *` row already carries committed_at and
   * committed_record_id, commitAutoWrite takes its early return before it ever
   * opens a transaction, so the apply never runs: the tool re-derives the same
   * bundleId and issues no second INSERT INTO marketing_bundles. Only that
   * insert is stubbed away here — if the guard were gone, the harness's
   * unexpected-query error would fire instead. The sibling test above proves the
   * insert DOES happen on an uncommitted draft.
   */
  it('reuses the committed bundle on replay without inserting it again', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [
        pendingWriteRow({
          committed_at: '2026-10-30T00:30:00.000Z',
          committed_record_id: BUNDLE_ID,
        }),
      ],
    })
    const result = await save(bundleInput())
    expect(result).toMatchObject({ bundleId: BUNDLE_ID, gate: 'auto' })
    expect(call('INSERT INTO marketing_bundles')).toBeUndefined()
  })

  it('stores artifacts against the committed bundle id', async () => {
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
      'INSERT INTO marketing_artifacts': [{ id: 'a' }],
    })
    const result = await save(
      bundleInput({
        artifacts: [
          { role: 'marketer-copywriter', kind: 'script', documentId: null, textContent: 'objection handling' },
        ],
      }),
    )
    const artifact = call('INSERT INTO marketing_artifacts')
    expect(result).toMatchObject({ artifactCount: 1 })
    expect(artifact?.params[1]).toBe(TENANT)
    expect(artifact?.params[2]).toBe(BUNDLE_ID)
  })

  it('refuses an image artifact that names no document, before staging anything', async () => {
    await expect(
      save(bundleInput({ artifacts: [{ role: 'creative-designer', kind: 'image', documentId: null, textContent: null }] })),
    ).rejects.toThrow(/artifact_shape/)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a non-image artifact that carries no text, before staging anything', async () => {
    await expect(
      save(bundleInput({ artifacts: [{ role: 'funnel-builder', kind: 'page_html', documentId: null, textContent: null }] })),
    ).rejects.toThrow(/artifact_shape/)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a document id that is not this tenant\'s', async () => {
    stubQueries({ 'SELECT id FROM documents': [] })
    await expect(
      save(bundleInput({ artifacts: [{ role: 'creative-designer', kind: 'image', documentId: DOCUMENT_ID, textContent: null }] })),
    ).rejects.toThrow(/document_not_found/)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  /**
   * The counterpart to the two 'stages nothing' guard assertions: when the
   * documents probe itself faults, assertDocumentsVisible runs before
   * getOrCreateDraft, so the original error surfaces unwrapped and no pending
   * write is staged. toBe on the captured error is the point — a wrapped copy
   * would be a different object and fail this identity assertion.
   */
  it('propagates a documents probe failure and stages nothing', async () => {
    const dbFault = new Error('db_unreachable')
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM documents')) return Promise.reject(dbFault)
      throw new Error(`unexpected query: ${sql}`)
    })
    await expect(
      save(
        bundleInput({
          artifacts: [
            { role: 'creative-designer', kind: 'image', documentId: DOCUMENT_ID, textContent: null },
          ],
        }),
      ),
    ).rejects.toBe(dbFault)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  /**
   * The lead credential at save. An inbound bundle without a page has no form
   * to post the credential to, a page without the placeholder would publish a
   * dead form, and a page with the placeholder gets one minted endpoint written
   * into the bytes that are stored and later hashed. The last two cases are the
   * one-way door: the credential is set once, per bundle, and a re-save of one
   * that already has it is refused before it can write a second page.
   */
  it('refuses an inbound_leads bundle with no landing page, before staging anything', async () => {
    await expect(save(bundleInput({ objective: 'inbound_leads' }))).rejects.toThrow(/needs_page_html/)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a landing page whose form holds no lead placeholder, before staging anything', async () => {
    vi.stubEnv('CRUM_LEAD_API_ORIGIN', 'https://api.example.test')
    await expect(
      save(
        bundleInput({
          objective: 'inbound_leads',
          artifacts: [
            {
              role: 'funnel-builder',
              kind: 'page_html',
              documentId: null,
              textContent: '<form action="/nowhere" method="post"></form>',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/lead_endpoint_missing_placeholder/)
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
    expect(call('INSERT INTO marketing_artifacts')).toBeUndefined()
  })

  it('stamps the minted endpoint into the stored page and stores that same token on the bundle', async () => {
    vi.stubEnv('CRUM_LEAD_API_ORIGIN', 'https://api.example.test/')
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
      // The early read after the commit: a row that carries no credential yet is
      // the first save of this bundle, so the stamp and the insert go ahead.
      'FROM marketing_bundles': [bundleRow()],
      'INSERT INTO marketing_artifacts': [{ id: 'a' }],
      'SET lead_token': [{ id: BUNDLE_ID }],
    })
    await save(
      bundleInput({
        objective: 'inbound_leads',
        artifacts: [
          {
            role: 'funnel-builder',
            kind: 'page_html',
            documentId: null,
            textContent: `<form action="${LEAD_ENDPOINT_PLACEHOLDER}" method="post"><input name="email"></form>`,
          },
        ],
      }),
    )

    const tokenUpdate = call('SET lead_token')
    const token = String(tokenUpdate?.params[2])
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(tokenUpdate?.params).toEqual([BUNDLE_ID, TENANT, token])
    // Set-once: the predicate is what makes a token immutable, not the caller.
    expect(tokenUpdate?.sql).toContain('lead_token IS NULL')

    // The endpoint in the stored bytes carries the token the row now holds, so
    // the page and its credential are one save, not two writes that agree.
    const artifact = call('INSERT INTO marketing_artifacts')
    const storedHtml = String(artifact?.params[6])
    expect(artifact?.params.slice(1, 6)).toEqual([TENANT, BUNDLE_ID, 'funnel-builder', 'page_html', null])
    expect(storedHtml).toContain(`https://api.example.test/api/marketing/leads?t=${token}`)
    expect(storedHtml).not.toContain(LEAD_ENDPOINT_PLACEHOLDER)
  })

  /**
   * A replay of the same role columns lands on the same bundle id, and a second
   * save mints a second token, which stamps different bytes and derives a
   * different content-addressed page id. Writing the artifacts first left the
   * bundle holding two page_html rows while the set-once UPDATE then refused the
   * save: `slotProblemCheck` will not derive a page from an ambiguous slot, so
   * that bundle could never be staged again without manual SQL. The refusal
   * therefore comes from a read after the commit and before the insert.
   */
  it('refuses a re-save of a credentialed bundle before it writes a second page', async () => {
    vi.stubEnv('CRUM_LEAD_API_ORIGIN', 'https://api.example.test')
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
      'FROM marketing_bundles': [bundleRow({ lead_token: LEAD_TOKEN })],
    })
    await expect(
      save(
        bundleInput({
          objective: 'inbound_leads',
          artifacts: [
            {
              role: 'funnel-builder',
              kind: 'page_html',
              documentId: null,
              textContent: `<form action="${LEAD_ENDPOINT_PLACEHOLDER}" method="post"></form>`,
            },
          ],
        }),
      ),
    ).rejects.toThrow(/lead_token_locked/)
    // The assertion that makes this "before it writes", not merely "it threw":
    // the harness answers an unhandled statement with its own error, so asserting
    // only on the rejection would pass just as well for a late refusal. Neither
    // the artifact insert nor the token update was issued at all.
    expect(call('INSERT INTO marketing_artifacts')).toBeUndefined()
    expect(call('SET lead_token')).toBeUndefined()
  })

  /**
   * The read narrows the window but cannot close it: two saves can both see a
   * null lead_token and both reach the update. The predicate on the UPDATE is
   * what makes the credential set-once, so a false return still has to surface
   * rather than leave a caller believing a second credential was minted.
   */
  it('refuses the save whose set-once update lost the race', async () => {
    vi.stubEnv('CRUM_LEAD_API_ORIGIN', 'https://api.example.test')
    stubQueries({
      'INSERT INTO pending_writes': [pendingWriteRow()],
      'SELECT * FROM pending_writes': [],
      'INSERT INTO marketing_bundles': [{ id: BUNDLE_ID }],
      'UPDATE pending_writes SET committed_at': [{ id: DRAFT_ID }],
      // Null at read time: the other save had not committed its token yet.
      'FROM marketing_bundles': [bundleRow()],
      'INSERT INTO marketing_artifacts': [{ id: 'a' }],
      'SET lead_token': [],
    })
    await expect(
      save(
        bundleInput({
          objective: 'inbound_leads',
          artifacts: [
            {
              role: 'funnel-builder',
              kind: 'page_html',
              documentId: null,
              textContent: `<form action="${LEAD_ENDPOINT_PLACEHOLDER}" method="post"></form>`,
            },
          ],
        }),
      ),
    ).rejects.toThrow(/lead_token_locked/)
  })
})

async function saveSchema() {
  const { saveBundleTool } = await import('../../src/mastra/tools/marketing-writes')
  const schema = saveBundleTool.inputSchema
  if (!schema) throw new Error('marketing.save_bundle has no input schema')
  return schema
}

describe('marketing.save_bundle input schema', () => {
  /**
   * `execute` below is called directly in every other case, so none of them runs
   * the tool's zod input schema. This is the one place the kind enum is asked,
   * and it is the question that matters: migration 0019 admits a thank-you
   * artifact, so a schema built from a stale list would reject every one.
   */
  it('admits a thank-you artifact, the seventh kind migration 0019 allows', async () => {
    const schema = await saveSchema()
    const result = await schema['~standard'].validate(
      bundleInput({
        artifacts: [
          { role: 'funnel-builder', kind: 'thank_you_html', documentId: null, textContent: '<p>thanks</p>' },
        ],
      }),
    )
    expect(result.issues).toBeUndefined()
  })

  it('still refuses a kind the artifact table does not admit', async () => {
    const schema = await saveSchema()
    const result = await schema['~standard'].validate(
      bundleInput({
        artifacts: [
          { role: 'funnel-builder', kind: 'landing_html', documentId: null, textContent: '<p>hi</p>' },
        ],
      }),
    )
    expect(result.issues).toBeDefined()
  })
})

describe('marketing.stage_bundle', () => {
  const stageHandlers = (row: Row, artifacts: Row[] = []): Record<string, Row[]> => ({
    'FROM marketing_bundles': [row],
    'FROM marketing_artifacts': artifacts,
    'INSERT INTO pending_writes': [pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' })],
    'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
  })

  it('stages exactly the identifier payload and nothing else', async () => {
    stubQueries(stageHandlers(bundleRow()))
    await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(Object.keys(stagedInsert()).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])
    expect(stagedInsert().requestedCeilingMinor).toBe(2500)
    expect(stagedInsert().actionCount).toBe(0)
    expect(stagedInsert().objective).toBe('outreach_support')
    // An empty artifact list: no rows, so no bytes to hash and nothing to
    // publish. This case is about the key set, and siteHash's null branch is the
    // one a bundle with no page records.
    expect(stagedInsert().artifactCount).toBe(0)
    expect(stagedInsert().siteHash).toBeNull()
  })

  it('counts the artifact rows it read, rather than echoing zero', async () => {
    // The count used to come from countMarketingArtifacts; it is artifacts.length
    // now. Three rows that claim no site slot keep siteHash null while making the
    // number impossible to pass with a constant.
    stubQueries(
      stageHandlers(bundleRow(), [
        artifactRow({ id: 'a1', kind: 'script', text_content: 'Objection handling: price is a comparison' }),
        artifactRow({ id: 'a2', role: 'campaign-analyst', kind: 'report', text_content: 'Week one results' }),
        artifactRow({ id: 'a3', kind: 'script', text_content: 'Follow-up call script' }),
      ]),
    )
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(stagedInsert().artifactCount).toBe(3)
    expect(stagedInsert().siteHash).toBeNull()
    // The number the reviewer is told comes from the same rows the hash would
    // cover, so the payload and the message cannot disagree.
    expect(result.message).toContain('3 asset(s)')
  })

  it('keys the draft on the bundle id and the hash recomputed from the stored row', async () => {
    stubQueries(stageHandlers(bundleRow()))
    await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    // Both sides go through String() because the staged payload is parsed jsonb,
    // so its values are `unknown` by construction: the assertion compares the
    // hash the tool recomputed from the stored row, not the row's own draft_hash.
    const staged = stagedInsert()
    expect(String(call('INSERT INTO pending_writes')?.params[9])).toBe(
      `stage:${BUNDLE_ID}:${String(staged.draftHash)}`,
    )
    // The fixture row's stored draft_hash is the decoy 'saved-hash', so these two
    // are what make the assertion above about provenance rather than about
    // self-consistency: an echo of the column, an empty hash, and a constant all
    // fail here and pass without them.
    expect(String(staged.draftHash)).not.toBe('saved-hash')
    expect(String(staged.draftHash)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a bundle whose plan asks for something nothing can execute, and stages nothing', async () => {
    stubQueries({
      'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
      // A publishable slug is not enough on its own any more: the action is only
      // derived when there are bytes to publish, so the refusal is only about the
      // adapter when a page_html row exists.
      'FROM marketing_artifacts': [artifactRow()],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('publish_page')
    const refusalTask = call('INSERT INTO human_tasks')
    expect(refusalTask).toBeDefined()
    expect(String(refusalTask?.params[3])).toBe('refusal')
    expect(String(refusalTask?.params[4])).toContain('Refused stage_bundle')
    expect(String(refusalTask?.params[6])).toBe('marketing.stage_bundle')
    expect(String(refusalTask?.params[4])).toContain('publish_page')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
    expect(call('UPDATE marketing_bundles')).toBeUndefined()
  })

  /**
   * The same refusal, from the other half of the guard: a plan that is present but
   * unreadable derives zero actions, so without this check a page object that lost
   * its slug would stage as "nothing to do" and read back as a clean approval.
   */
  it('refuses a plan it cannot read, before it reports an action count of zero', async () => {
    stubQueries({
      'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { title: 'Free scan' } }, objective: 'inbound_leads' })],
      'FROM marketing_artifacts': [],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('unreadable funnel_plan')
    const refusalTask = call('INSERT INTO human_tasks')
    expect(refusalTask).toBeDefined()
    expect(String(refusalTask?.params[3])).toBe('refusal')
    expect(String(refusalTask?.params[4])).toContain('Refused stage_bundle')
    expect(String(refusalTask?.params[6])).toBe('marketing.stage_bundle')
    expect(String(refusalTask?.params[4])).toContain('unreadable funnel_plan')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  /**
   * The other half of the derivation: a readable media plan that asks for a
   * campaign must be refused by the tool, not only by outbox's own unit tests,
   * because "an action nothing can execute never reaches a reviewer" is a claim
   * about this tool's behaviour.
   */
  it('refuses a readable media plan that asks for a campaign', async () => {
    stubQueries({
      'FROM marketing_bundles': [
        bundleRow({ media_plan: { campaigns: [{ name: 'melbourne-physio-awareness' }] }, objective: 'inbound_leads' }),
      ],
      'FROM marketing_artifacts': [],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('create_campaign')
    expect(String(call('INSERT INTO human_tasks')?.params[4])).toContain('create_campaign')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
    expect(call('UPDATE marketing_bundles')).toBeUndefined()
  })

  /**
   * deriveActions throws SlugProblemError on a slug the site cannot publish, and a
   * throw inside an agent turn is not a refusal a human can act on. The queue entry
   * is, so the tool asks slugProblem first and never hands the bad slug to
   * derivation.
   */
  it('refuses an unusable page slug as a queue entry, not as a throw', async () => {
    stubQueries({
      'FROM marketing_bundles': [
        bundleRow({ funnel_plan: { page: { slug: 'Free Quote' } }, objective: 'inbound_leads' }),
      ],
      'FROM marketing_artifacts': [artifactRow()],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('unusable page slug')
    expect(String(result.reason)).toContain('Free Quote')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a slot two artifacts claim, before anything is hashed', async () => {
    stubQueries({
      'FROM marketing_bundles': [
        bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' }),
      ],
      'FROM marketing_artifacts': [artifactRow({ id: 'a1' }), artifactRow({ id: 'a2' })],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('ambiguous page slot')
    expect(String(result.reason)).toContain('page_html')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses a page that names a picture the bundle does not have', async () => {
    stubQueries({
      'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
      'FROM marketing_artifacts': [artifactRow({ text_content: '<img src="{{ASSET:hero}}">' })],
      'INSERT INTO human_tasks': [{ id: '66666466-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    expect(String(result.reason)).toContain('asset_name_missing')
    expect(String(result.reason)).toContain('hero')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('refuses two pictures that answer one placeholder', async () => {
    stubQueries({
      // First, because `listImageAssetStatuses`'s SQL contains both fragments below
      // and `stubQueries` answers from the first match in insertion order and throws
      // on a query nothing matches. Both pictures are `ready` so the only thing that
      // can refuse this bundle is the ambiguity: with the statuses left out of the
      // fixture the unreviewed arm has an answer too, and the case no longer shows
      // which arm the chain reached first.
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' },
        { document_id: '88888888-8888-4888-8888-888888888888', title: 'hero', status: 'ready', kind: 'marketing_asset' },
      ],
      'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
      'FROM marketing_artifacts': [
        artifactRow({ text_content: '<img src="{{ASSET:hero}}">' }),
        artifactRow({ id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png' }),
        artifactRow({ id: 'a3', kind: 'image', text_content: null, document_id: '88888888-8888-4888-8888-888888888888', title: 'hero', mime: 'image/png' }),
      ],
      // The page references `hero`, so the loader asks for the bytes of both
      // candidates before `resolveAssets` gets to refuse the choice.
      'FROM document_files': [
        { document_id: DOCUMENT_ID, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x09]) },
        { document_id: '88888888-8888-4888-8888-888888888888', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a]) },
      ],
      'INSERT INTO human_tasks': [{ id: '66666466-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(String(result.reason)).toContain('asset_name_ambiguous')
  })

  it('stages a page whose picture resolves, and records the picture in the hash', async () => {
    // This fixture names a real page with real bytes, so `deriveActions` yields
    // a publish_page, and the unit env registers no adapters — the refusal case
    // near the top of this block depends on that. The door needs the executable
    // answer boot would give it; the unregister runs in a `finally` so a failed
    // assertion here cannot leak the adapter into the rest of the file.
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x09])
      const stored = [
        { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
        { id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png' },
      ]
      stubQueries({
        // First, for the same reason as the case above, and `ready` because this bundle
        // is meant to stage: the unreviewed arm is the one thing standing between a
        // fixture and the hash assertion below.
        'JOIN documents d': [{ document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' }],
        'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
        'FROM marketing_artifacts': stored,
        'FROM document_files': [{ document_id: DOCUMENT_ID, data: png }],
        'INSERT INTO pending_writes': [pendingWriteRow()],
        'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
      })
      const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
      const resolved = [
        { id: 'a1', kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' },
        { id: 'a2', kind: 'image', textContent: null, documentId: DOCUMENT_ID, title: 'hero', mime: 'image/png', bytes: png },
      ]
      expect(stagedInsert()['siteHash']).toBe(siteHashOf(resolveSite('free-scan', resolved)))
      expect(result.message).toContain('free-scan')
    } finally {
      unregister()
    }
  })

  it('reports a picture no page references without refusing the stage', async () => {
    // Same reason as the case above: the bundle carries a resolvable page_html,
    // so `deriveActions` yields a publish_page and staging needs the executable
    // answer boot would give it.
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    try {
      stubQueries({
        // `listImageAssetStatuses` is reached because the bundle has an image, and the
        // picture has to be reviewed or the unreviewed arm refuses first. It sits first
        // because its SQL also contains the artifacts fragment below.
        'JOIN documents d': [{ document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' }],
        'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
        'FROM marketing_artifacts': [
          artifactRow(),
          artifactRow({ id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png', status: 'active' }),
        ],
        'INSERT INTO pending_writes': [pendingWriteRow()],
        'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
      })
      const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
      expect(result).toMatchObject({ proceed: undefined, assetsUnreferenced: ['hero'] })
    } finally {
      unregister()
    }
  })

  it('refuses the unreviewed image by title while a reviewed one in the same bundle passes', async () => {
    stubQueries({
      // First, because listImageAssetStatuses's SQL also contains the artifacts
      // fragment below and stubQueries answers from the first match. `JOIN
      // documents d` is in that read and in nothing else this tool issues.
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
        {
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'founder-portrait',
          status: 'needs_review',
          kind: 'marketing_asset',
        },
        // A third status, and the reason it is here: documents.status is
        // `('pending','processing','ready','needs_review','failed')`
        // (migrations/0009_crum_documents.sql:38), and with only two values in the
        // fixture no test can tell `status !== 'ready'` from `status ===
        // 'needs_review'`. Those are different products — under the second, a
        // picture whose generation failed or is still running stages as if it had
        // been looked at.
        {
          document_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          title: 'scan-fail',
          status: 'failed',
          kind: 'marketing_asset',
        },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({ id: 'a1', kind: 'script', text_content: 'Brand rules' }),
        artifactRow({
          id: 'a2',
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
        artifactRow({
          id: 'a3',
          role: 'creative-designer',
          kind: 'image',
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          text_content: null,
        }),
        artifactRow({
          id: 'a4',
          role: 'creative-designer',
          kind: 'image',
          document_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          text_content: null,
        }),
      ],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ proceed: false })
    // The title, not the uuid, and only the unreviewed one. The second line is
    // spec section 6.1's load-bearing case, and it is the reason the status filter
    // sits in this file rather than in a WHERE clause the mock above cannot exercise.
    expect(String(result.reason)).toContain('unreviewed images: founder-portrait')
    // The `failed` picture has to be named too, in the same list. This is the
    // assertion that makes the arm's own operator load-bearing: read as
    // `status === 'needs_review'` it refuses one title instead of two, and every
    // other case in this file stays green.
    expect(String(result.reason)).toContain('unreviewed images: founder-portrait, scan-fail')
    expect(String(result.reason)).not.toContain('hero-image')
    expect(String(call('INSERT INTO human_tasks')?.params[4])).toContain('founder-portrait')
    // params[4] is the title and params[5] is the body, and the body is the half
    // the reviewer actually opens. Both interpolate the same `refusal` string in
    // the createHumanTask call, so this is one line of insurance against a body
    // that stops quoting it.
    expect(String(call('INSERT INTO human_tasks')?.params[5])).toContain('founder-portrait')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
    expect(call('UPDATE marketing_bundles')).toBeUndefined()
  })

  it('stages a bundle whose only image is reviewed', async () => {
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
      ],
      'INSERT INTO pending_writes': [
        pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result.proceed).not.toBe(false)
    // The read happens and the bundle still stages: an empty refusal is the
    // difference between "reviewed" and "there were no pictures to ask about", and
    // only this assertion tells them apart.
    expect(call('JOIN documents d')).toBeDefined()
  })

  it('does not refuse a bundle over a document that is not a marketing asset', async () => {
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'october-invoice', status: 'needs_review', kind: 'invoice' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({
          role: 'creative-designer',
          kind: 'image',
          document_id: DOCUMENT_ID,
          text_content: null,
        }),
      ],
      'INSERT INTO pending_writes': [
        pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    // An image artifact pointing at somebody's invoice is a data problem, not a
    // review queue full of invoices. Ruling 8b is the filter this case exists for.
    expect(result.proceed).not.toBe(false)
    expect(String(result.reason ?? '')).not.toContain('october-invoice')
  })

  it('names a shared title once when two unreviewed pictures carry it', async () => {
    // `documents.title` is NOT NULL with no unique constraint
    // (migrations/0009_crum_documents.sql:30), so two generated pictures can reach
    // staging with the same name and no bug is involved. The exact string is the
    // assertion: dropping the dedup prints the name twice, which reads as two
    // things to open when a reviewer can only act on one picture at a time.
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'hero-image', status: 'needs_review', kind: 'marketing_asset' },
        {
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'hero-image',
          status: 'needs_review',
          kind: 'marketing_asset',
        },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [
        artifactRow({ id: 'a1', role: 'creative-designer', kind: 'image', document_id: DOCUMENT_ID, text_content: null }),
        artifactRow({
          id: 'a2',
          role: 'creative-designer',
          kind: 'image',
          document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          text_content: null,
        }),
      ],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(String(result.reason)).toBe('unreviewed images: hero-image')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('stages the bundle it refused as soon as the picture in it is reviewed', async () => {
    // Spec section 10's third section 6.1 case, and the one that closes the loop:
    // the review is the existing `reviewDocument`, which sets
    // `documents.status = 'ready'` (src/db/documents.ts:543), and this arm accepts
    // exactly that literal (marketing-writes.ts:445). Nothing else in the suite
    // pins the two against each other — tests/api/documents.test.ts:205 stubs its
    // own UPDATE with its own 'ready' — so a refusal that no review could clear,
    // or an arm that refused a reviewed picture, would leave every other test here
    // green. Same bundle, same artifact row, one column changed.
    const imageArtifact = artifactRow({
      role: 'creative-designer',
      kind: 'image',
      document_id: DOCUMENT_ID,
      text_content: null,
    })
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'founder-portrait', status: 'needs_review', kind: 'marketing_asset' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [imageArtifact],
      'INSERT INTO human_tasks': [{ id: '66666666-6666-4666-8666-666666666666' }],
    })
    const refused = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(String(refused.reason)).toContain('unreviewed images: founder-portrait')
    expect(call('INSERT INTO pending_writes')).toBeUndefined()

    // The review: the same read, answering with the row reviewDocument leaves
    // behind it. No handler is added for human_tasks, because reaching this arm's
    // opposite means no second refusal task.
    stubQueries({
      'JOIN documents d': [
        { document_id: DOCUMENT_ID, title: 'founder-portrait', status: 'ready', kind: 'marketing_asset' },
      ],
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [imageArtifact],
      'INSERT INTO pending_writes': [
        pendingWriteRow({ object_type: 'marketing_stage', gate: 'approval' }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result.proceed).not.toBe(false)
    expect(stagedInsert().artifactCount).toBe(1)
  })

  it('refuses a bundle that is already approved, rather than double-approving it', async () => {
    stubQueries(stageHandlers(bundleRow({ status: 'approved' })))
    await expect(stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })).rejects.toThrow(
      /bundle_not_stageable/,
    )
    expect(call('INSERT INTO pending_writes')).toBeUndefined()
  })

  it('is a not_found for a bundle the tenant cannot see', async () => {
    stubQueries({ 'FROM marketing_bundles': [] })
    await expect(stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })).rejects.toThrow(/not_found/)
  })

  it('marks the bundle staged only after the draft exists', async () => {
    stubQueries(stageHandlers(bundleRow()))
    await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    const order = mockQuery.mock.calls
      .map((raw) => (raw as unknown[])[0] as string)
      .findIndex((sql) => sql.includes('INSERT INTO pending_writes'))
    const stagedAt = mockQuery.mock.calls
      .map((raw) => (raw as unknown[])[0] as string)
      .findIndex((sql) => sql.includes('UPDATE marketing_bundles'))
    expect(stagedAt).toBeGreaterThan(order)
    /**
     * Load-bearing since Task 5: commitBundleApproval now refuses anything that is
     * not exactly 'staged', so a stage tool that wrote some other status — or a
     * hand-rolled UPDATE that skipped markBundleStaged's tenant predicate — would
     * make every approval refuse, and only the end-to-end run would say so.
     */
    const staged = call('UPDATE marketing_bundles')
    expect(staged?.sql).toMatch(/SET status = 'staged'/)
    expect(staged?.sql).toContain('tenant_id = $2')
    expect(staged?.params).toEqual([BUNDLE_ID, TENANT])
  })

  it('reports the gate that was actually computed', async () => {
    stubQueries(stageHandlers(bundleRow()))
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result).toMatchObject({ gate: 'approval', riskScore: 10 })
    /**
     * The same values as they reach the row, because the fixture row above also
     * carries gate 'approval' and risk_score 10: asserting only the returned
     * object cannot tell a computed value from one echoed back out of the stub.
     */
    const insert = call('INSERT INTO pending_writes')
    expect(String(insert?.params[8])).toBe('approval')
    expect(Number(insert?.params[7])).toBe(10)
    /**
     * And the dispatch key the commit reads. applyDraft branches on object_type
     * (pending-writes.ts:447), so a bundle-shaped object type here would insert a
     * second marketing_bundles row at approval instead of approving this one, and
     * 'create' instead of 'update' throws UnsupportedCommitError on the way in.
     * Nothing else in this lane reads what this tool writes, so it is pinned here.
     */
    expect(String(insert?.params[3])).toBe('marketing_stage')
    expect(String(insert?.params[4])).toBe('update')
    expect(String(insert?.params[5])).toBe(BUNDLE_ID)
  })

  /**
   * getOrCreateDraft resolves a key match with DO UPDATE SET run_id = run_id
   * (src/db/pending-writes.ts:93-95), so a re-stage at a different ceiling gets back
   * the draft that already exists, holding the ceiling it was created with. The
   * message must describe that row. Before the fix it described the request.
   */
  it('reports the ceiling the open draft holds when the key already exists', async () => {
    stubQueries({
      'FROM marketing_bundles': [bundleRow()],
      'FROM marketing_artifacts': [],
      'INSERT INTO pending_writes': [
        pendingWriteRow({
          object_type: 'marketing_stage',
          gate: 'approval',
          payload: { requestedCeilingMinor: 999999, artifactCount: 1, actionCount: 0 },
        }),
      ],
      'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    })
    const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
    expect(result.pendingWriteId).toBe(DRAFT_ID)
    expect(result.gate).toBe('approval')
    expect(result.message).toContain('ceiling 999999 minor units')
    expect(result.message).not.toContain('ceiling 2500')
    expect(result.message).toContain('1 asset(s)')
  })

  it('refuses to claim success when the bundle row did not move to staged', async () => {
    stubQueries({
      ...stageHandlers(bundleRow()),
      'UPDATE marketing_bundles': [],
    })
    await expect(stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })).rejects.toThrow(
      /stage_failed/,
    )
  })
})

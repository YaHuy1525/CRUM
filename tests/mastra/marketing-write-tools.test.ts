import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
        payload: typeof staged === 'string' ? (JSON.parse(staged) as Row) : row.payload,
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

beforeEach(() => {
  mockQuery.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
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
})

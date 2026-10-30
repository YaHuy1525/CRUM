import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/marketing')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('getMarketingBundle', () => {
  it('scopes the read on tenant as well as id', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getMarketingBundle } = await load()
    await getMarketingBundle(TENANT, BUNDLE)
    const [call] = calls('FROM marketing_bundles')
    expect(call?.sql).toContain('tenant_id = $2')
    expect(call?.params).toEqual([BUNDLE, TENANT])
  })

  it('returns null rather than an empty object when the row is not there', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { getMarketingBundle } = await load()
    expect(await getMarketingBundle(OTHER_TENANT, BUNDLE)).toBeNull()
  })

  it('maps snake_case columns to camelCase, including the five role columns', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: BUNDLE,
          tenant_id: TENANT,
          brief: 'b',
          objective: 'outreach_support',
          audience_note: null,
          status: 'draft',
          strategy: { position: 'p' },
          copy: null,
          media_plan: null,
          funnel_plan: null,
          analysis: null,
          prompt_version: 'marketing-v1',
          draft_hash: 'abc',
          created_at: '2026-10-30T00:00:00.000Z',
          updated_at: '2026-10-30T00:00:00.000Z',
        },
      ],
    })
    const { getMarketingBundle } = await load()
    const row = await getMarketingBundle(TENANT, BUNDLE)
    expect(row?.mediaPlan).toBeNull()
    expect(row?.strategy).toEqual({ position: 'p' })
    expect(row?.promptVersion).toBe('marketing-v1')
  })
})

describe('insertMarketingArtifacts', () => {
  it('inserts one statement per artifact with a content-derived id', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'x' }] })
    const { insertMarketingArtifacts } = await load()
    const count = await insertMarketingArtifacts({
      tenantId: TENANT,
      bundleId: BUNDLE,
      artifacts: [
        { role: 'marketer-copywriter', kind: 'script', documentId: null, textContent: 'objection handling' },
        { role: 'funnel-builder', kind: 'form_spec', documentId: null, textContent: '{"fields":[]}' },
      ],
    })
    const inserts = calls('INSERT INTO marketing_artifacts')
    expect(count).toBe(2)
    expect(inserts).toHaveLength(2)
    expect(inserts[0]?.sql).toContain('ON CONFLICT (id) DO NOTHING')
    expect(inserts[0]?.params).toEqual([
      inserts[0]?.params[0],
      TENANT,
      BUNDLE,
      'marketer-copywriter',
      'script',
      null,
      'objection handling',
    ])
  })

  it('counts a duplicate as zero inserted, so a retried save is quiet', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { insertMarketingArtifacts } = await load()
    const count = await insertMarketingArtifacts({
      tenantId: TENANT,
      bundleId: BUNDLE,
      artifacts: [
        { role: 'campaign-analyst', kind: 'report', documentId: null, textContent: 'no data yet' },
      ],
    })
    expect(count).toBe(0)
  })

  it('derives the same id for the same content twice', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'x' }] })
    const { insertMarketingArtifacts } = await load()
    const artifact = {
      role: 'media-buyer' as const,
      kind: 'campaign_spec' as const,
      documentId: null,
      textContent: '{"campaigns":[]}',
    }
    await insertMarketingArtifacts({ tenantId: TENANT, bundleId: BUNDLE, artifacts: [artifact] })
    await insertMarketingArtifacts({ tenantId: TENANT, bundleId: BUNDLE, artifacts: [artifact] })
    const firstIds = calls('INSERT INTO marketing_artifacts').map((call) => call.params[0])
    expect(firstIds[0]).toBe(firstIds[1])
  })
})

describe('markBundleStaged', () => {
  it('only moves a draft or an already staged bundle, never an approved one', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: BUNDLE }] })
    const { markBundleStaged } = await load()
    const ok = await markBundleStaged({ tenantId: TENANT, bundleId: BUNDLE })
    const [call] = calls('UPDATE marketing_bundles')
    expect(ok).toBe(true)
    expect(call?.sql).toContain("status IN ('draft','staged')")
    expect(call?.sql).toContain('tenant_id = $2')
    // trg_marketing_bundles_touch owns updated_at (migrations/0018), so a
    // hand-set column here would be a second writer to one field.
    expect(call?.sql).not.toContain('updated_at')
  })

  it('reports false when no row matched', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { markBundleStaged } = await load()
    expect(await markBundleStaged({ tenantId: TENANT, bundleId: BUNDLE })).toBe(false)
  })
})

describe('countMarketingArtifacts', () => {
  it('reads the count and not the bodies', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: 4 }] })
    const { countMarketingArtifacts } = await load()
    expect(await countMarketingArtifacts(TENANT, BUNDLE)).toBe(4)
    expect(calls('FROM marketing_artifacts')[0]?.sql).toContain('count(*)')
  })
})

describe('listMarketingArtifacts', () => {
  it('scopes the read on tenant as well as bundle', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { listMarketingArtifacts } = await load()
    await listMarketingArtifacts(TENANT, BUNDLE)
    const [call] = calls('FROM marketing_artifacts')
    expect(call?.sql).toContain('tenant_id = $1 AND bundle_id = $2')
    expect(call?.params).toEqual([TENANT, BUNDLE])
  })

  it('maps the payload columns without dropping the document bridge', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          role: 'creative-designer',
          kind: 'image',
          document_id: '55555555-5555-5555-8555-555555555555',
          text_content: null,
          status: 'pending_review',
          created_at: '2026-10-30T00:00:00.000Z',
        },
      ],
    })
    const { listMarketingArtifacts } = await load()
    const rows = await listMarketingArtifacts(TENANT, BUNDLE)
    expect(rows[0]?.documentId).toBe('55555555-5555-5555-8555-555555555555')
    expect(rows[0]?.textContent).toBeNull()
  })
})

describe('roleColumnsOf', () => {
  it('carries the nine hash columns and none of the lifecycle ones', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: BUNDLE,
          tenant_id: TENANT,
          brief: 'b',
          objective: 'proof_asset',
          audience_note: 'a',
          status: 'staged',
          strategy: { s: 1 },
          copy: { c: 1 },
          media_plan: { m: 1 },
          funnel_plan: { f: 1 },
          analysis: { x: 1 },
          prompt_version: 'marketing-v1',
          draft_hash: 'abc',
          created_at: '2026-10-30T00:00:00.000Z',
          updated_at: '2026-10-30T00:00:00.000Z',
        },
      ],
    })
    const { getMarketingBundle, roleColumnsOf } = await load()
    const bundle = await getMarketingBundle(TENANT, BUNDLE)
    const columns = bundle ? roleColumnsOf(bundle) : null
    expect(columns).toEqual({
      brief: 'b',
      objective: 'proof_asset',
      audienceNote: 'a',
      strategy: { s: 1 },
      copy: { c: 1 },
      mediaPlan: { m: 1 },
      funnelPlan: { f: 1 },
      analysis: { x: 1 },
      promptVersion: 'marketing-v1',
    })
    const keys = Object.keys(columns ?? {})
    expect(keys).toHaveLength(9)
    expect(keys).not.toContain('status')
    expect(keys).not.toContain('draftHash')
    expect(keys).not.toContain('createdAt')
  })
})

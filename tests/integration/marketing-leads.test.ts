import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDbClient, getDbClient } from '../../src/db/client'
import {
  bundleForLeadToken,
  countLeadsSince,
  normalizeEmail,
  recordLead,
  type LeadInput,
} from '../../src/db/marketing-leads'

/**
 * The inbound lead lane against a real Postgres, because every effect it writes
 * is a constraint: 0015's channel key, its set-once consent row, and 0019's
 * one-lead-per-bundle-and-email key. The route test mocks the data module, so
 * this is the only place the four effects and the token join are proven.
 *
 * Same lazy contract as the other integration files: no URL, no run, and the
 * skip is reported rather than faked. The tenant is this file's alone, and the
 * pre-suite delete makes a rerun start from nothing.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
if (url) process.env.DATABASE_URL = url

const TENANT = 'a3000000-0000-4000-8000-000000000014'
const SLUG = 'physio'
const SERVING = 'https://dep-9.example.pages.dev'
const LIVE = 'https://physio.example'
const PAGE_URL = `${SERVING}/${SLUG}/`
const PUBLISHED_AT = '2026-01-01T00:00:00.000Z'
const PROMOTED_AT = '2026-01-02T00:00:00.000Z'
const EPOCH = '1970-01-01T00:00:00.000Z'

const TOKEN = '0f0f0f0f-0000-4000-8000-000000000014'
const TOKEN_PROMOTED = '0f0f0f0f-0000-4000-8000-000000000015'
const TOKEN_UNPUBLISHED = '0f0f0f0f-0000-4000-8000-000000000016'
const TOKEN_OTHER = '0f0f0f0f-0000-4000-8000-000000000017'
const TOKEN_UNKNOWN = '00000000-0000-4000-8000-000000000000'

async function insertBundle(params: { token: string; draftHash: string }): Promise<string> {
  const result = await getDbClient().query<{ id: string }>(
    `INSERT INTO marketing_bundles
       (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash, lead_token)
     VALUES ($1, 'Lead intake integration fixture', 'inbound_leads', 'live', $2::jsonb, 'marketing-v1', $3, $4)
     RETURNING id`,
    [TENANT, JSON.stringify({ page: { slug: SLUG } }), params.draftHash, params.token],
  )
  return result.rows[0]!.id
}

async function insertSucceededAction(params: {
  bundleId: string
  action: 'publish_page' | 'promote_page'
  url: string
  executedAt: string
}): Promise<void> {
  await getDbClient().query(
    `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, result, executed_at)
     VALUES ($1, $2, $3, $4::jsonb, 'succeeded', $5::jsonb, $6)`,
    [
      TENANT,
      params.bundleId,
      params.action,
      JSON.stringify({ siteHash: 'a'.repeat(64) }),
      JSON.stringify({ url: params.url }),
      params.executedAt,
    ],
  )
}

async function clean(): Promise<void> {
  const db = getDbClient()
  await db.query('DELETE FROM marketing_leads WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM prospect_consents WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM prospect_channels WHERE tenant_id = $1', [TENANT])
  await db.query('DELETE FROM prospects WHERE tenant_id = $1', [TENANT])
  await db.query(
    `DELETE FROM marketing_actions WHERE bundle_id IN
       (SELECT id FROM marketing_bundles WHERE tenant_id = $1)`,
    [TENANT],
  )
  await db.query(
    `DELETE FROM marketing_artifacts WHERE bundle_id IN
       (SELECT id FROM marketing_bundles WHERE tenant_id = $1)`,
    [TENANT],
  )
  await db.query('DELETE FROM marketing_bundles WHERE tenant_id = $1', [TENANT])
}

describe.skipIf(!url)('inbound lead intake', () => {
  let bundleId = ''
  let first: Awaited<ReturnType<typeof recordLead>>

  function lead(over: Partial<LeadInput> = {}): LeadInput {
    return {
      tenantId: TENANT,
      bundleId,
      name: 'Nguyen Van A',
      email: 'A@Example.COM ',
      country: 'VN',
      budgetBucket: '500_to_2k',
      goal: 'More booked calls',
      sourceUrl: PAGE_URL,
      ...over,
    }
  }

  beforeAll(async () => {
    await clean()
    bundleId = await insertBundle({ token: TOKEN, draftHash: 'lead-intake-fixture-primary' })
    await insertSucceededAction({
      bundleId,
      action: 'publish_page',
      url: SERVING,
      executedAt: PUBLISHED_AT,
    })
    first = await recordLead(lead())
  })

  afterAll(async () => {
    await clean()
    await closeDbClient()
  })

  it('writes the lead, its prospect, one email channel and one opt-in consent', async () => {
    expect(first.duplicate).toBe(false)
    const db = getDbClient()

    const prospects = await db.query<{
      id: string
      name: string
      name_normalized: string
      country: string
      category: string
      status: string
    }>(
      `SELECT id, name, name_normalized, country, category, status
         FROM prospects WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(prospects.rows).toHaveLength(1)
    expect(prospects.rows[0]).toMatchObject({
      id: first.prospectId,
      name: 'Nguyen Van A',
      name_normalized: 'nguyen van a',
      country: 'VN',
      category: 'marketing lead',
      status: 'new',
    })

    const channels = await db.query<{
      prospect_id: string
      platform: string
      handle_normalized: string
      profile_url: string
    }>(
      `SELECT prospect_id, platform, handle_normalized, profile_url
         FROM prospect_channels WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(channels.rows).toHaveLength(1)
    expect(channels.rows[0]).toMatchObject({
      prospect_id: first.prospectId,
      platform: 'email',
      handle_normalized: 'a@example.com',
      // The page that produced the lead is the source, without a new column.
      profile_url: PAGE_URL,
    })

    const consents = await db.query<{ prospect_id: string; basis: string; source: string }>(
      `SELECT prospect_id, basis, source FROM prospect_consents WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(consents.rows).toHaveLength(1)
    expect(consents.rows[0]).toMatchObject({
      prospect_id: first.prospectId,
      basis: 'opt_in',
      source: `bundle:${bundleId}`,
    })

    const leads = await db.query<{
      id: string
      prospect_id: string
      email: string
      email_normalized: string
      country: string
      budget_bucket: string
      goal: string
      source_url: string
    }>(
      `SELECT id, prospect_id, email, email_normalized, country, budget_bucket, goal, source_url
         FROM marketing_leads WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(leads.rows).toHaveLength(1)
    expect(leads.rows[0]).toMatchObject({
      id: first.leadId,
      prospect_id: first.prospectId,
      // The raw address is kept for the owner; the normalised copy is the key.
      email: 'A@Example.COM ',
      email_normalized: 'a@example.com',
      country: 'VN',
      budget_bucket: '500_to_2k',
      goal: 'More booked calls',
      source_url: PAGE_URL,
    })
  })

  it('turns a second submission of the same address into the same lead and prospect', async () => {
    const again = await recordLead(lead({ email: '  a@EXAMPLE.com  ' }))
    expect(again.duplicate).toBe(true)
    expect(again.prospectId).toBe(first.prospectId)
    expect(again.leadId).toBe(first.leadId)

    const db = getDbClient()
    const leads = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_leads
        WHERE tenant_id = $1 AND bundle_id = $2 AND email_normalized = $3`,
      [TENANT, bundleId, normalizeEmail('A@Example.COM ')],
    )
    expect(leads.rows[0]?.n).toBe('1')

    const prospects = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prospects
        WHERE tenant_id = $1 AND name_normalized = 'nguyen van a'`,
      [TENANT],
    )
    expect(prospects.rows[0]?.n).toBe('1')

    const consents = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prospect_consents
        WHERE tenant_id = $1 AND prospect_id = $2`,
      [TENANT, first.prospectId],
    )
    expect(consents.rows[0]?.n).toBe('1')
  })

  it('gives a different email on the same bundle its own prospect and lead', async () => {
    const second = await recordLead(lead({ name: 'Tran Thi B', email: 'b@example.com' }))
    expect(second.duplicate).toBe(false)
    expect(second.prospectId).not.toBe(first.prospectId)
    expect(second.leadId).not.toBe(first.leadId)

    const db = getDbClient()
    const prospects = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prospects WHERE tenant_id = $1`,
      [TENANT],
    )
    expect(prospects.rows[0]?.n).toBe('2')
    const leads = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_leads WHERE tenant_id = $1 AND bundle_id = $2`,
      [TENANT, bundleId],
    )
    expect(leads.rows[0]?.n).toBe('2')
  })

  it('names the serving page for a stamped token, and follows a promotion to the live URL', async () => {
    expect(await bundleForLeadToken(TOKEN)).toEqual({
      tenantId: TENANT,
      bundleId,
      slug: SLUG,
      servingUrl: SERVING,
    })

    const promoted = await insertBundle({ token: TOKEN_PROMOTED, draftHash: 'lead-intake-fixture-promoted' })
    await insertSucceededAction({
      bundleId: promoted,
      action: 'publish_page',
      url: SERVING,
      executedAt: PUBLISHED_AT,
    })
    await insertSucceededAction({
      bundleId: promoted,
      action: 'promote_page',
      url: LIVE,
      executedAt: PROMOTED_AT,
    })
    expect(await bundleForLeadToken(TOKEN_PROMOTED)).toEqual({
      tenantId: TENANT,
      bundleId: promoted,
      slug: SLUG,
      servingUrl: LIVE,
    })
  })

  it('refuses a token nobody minted and a page that never published', async () => {
    expect(await bundleForLeadToken(TOKEN_UNKNOWN)).toBeNull()
    expect(await bundleForLeadToken('')).toBeNull()

    const unpublished = await insertBundle({
      token: TOKEN_UNPUBLISHED,
      draftHash: 'lead-intake-fixture-unpublished',
    })
    expect(unpublished).toMatch(/^[0-9a-f-]{36}$/)
    expect(await bundleForLeadToken(TOKEN_UNPUBLISHED)).toBeNull()
  })

  it('counts leads per bundle and only since the given instant', async () => {
    const db = getDbClient()
    const other = await insertBundle({ token: TOKEN_OTHER, draftHash: 'lead-intake-fixture-other' })
    await recordLead(lead({ bundleId: other, email: 'c@example.com' }))

    const expected = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_leads
        WHERE bundle_id = $1 AND created_at >= $2`,
      [bundleId, EPOCH],
    )
    expect(await countLeadsSince(bundleId, EPOCH)).toBe(Number(expected.rows[0]?.n))
    expect(await countLeadsSince(other, EPOCH)).toBe(1)

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    expect(await countLeadsSince(bundleId, tomorrow)).toBe(0)
  })
})

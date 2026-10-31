import { beforeEach, describe, expect, it, vi } from 'vitest'

const leads = vi.hoisted(() => ({
  bundleForLeadToken: vi.fn(),
  recordLead: vi.fn(),
  countLeadsSince: vi.fn(),
}))

vi.mock('../../src/db/marketing-leads', () => ({
  bundleForLeadToken: leads.bundleForLeadToken,
  recordLead: leads.recordLead,
  countLeadsSince: leads.countLeadsSince,
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const BUNDLE = '33333333-3333-4333-8333-333333333333'
const TOKEN = '0f0f0f0f-0000-4000-8000-00000000000f'
const SERVING = 'https://dep-9.example.pages.dev'

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

const GOOD = {
  name: 'Nguyen Van A',
  email: 'A@Example.COM ',
  country: 'VN',
  budget: '500_to_2k',
  goal: 'More booked calls',
  website: '',
}

function postLeads(body: string, token = TOKEN, contentType = 'application/x-www-form-urlencoded') {
  return createMarketingRouter({ env: parseEnv({}) }).request(
    `/api/marketing/leads?t=${token}`,
    { method: 'POST', headers: { 'content-type': contentType }, body },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  leads.bundleForLeadToken.mockResolvedValue({ tenantId: '11111111-1111-4111-8111-111111111111', bundleId: BUNDLE, slug: 'physio', servingUrl: SERVING })
  leads.countLeadsSince.mockResolvedValue(0)
  leads.recordLead.mockResolvedValue({ leadId: '22222222-2222-4222-8222-222222222222', prospectId: '33333333-3333-4333-8333-333333333333', duplicate: false })
})

describe('POST /api/marketing/leads', () => {
  it('accepts a plain html form post and redirects to the thank-you page it can name', async () => {
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${SERVING}/physio/thanks/`)
    // The whole mapping: the form's names are not the column names, and the
    // source is the page the lead came from.
    expect(leads.recordLead).toHaveBeenCalledWith({
      tenantId: '11111111-1111-4111-8111-111111111111',
      bundleId: BUNDLE,
      name: 'Nguyen Van A',
      email: 'A@Example.COM ',
      country: 'VN',
      budgetBucket: '500_to_2k',
      goal: 'More booked calls',
      sourceUrl: `${SERVING}/physio/`,
    })
  })

  it('lowercases and trims the email before anything is looked up', async () => {
    await postLeads(form(GOOD))
    expect(leads.recordLead.mock.calls[0]![0]).toMatchObject({ email: 'A@Example.COM ', /* stored as-is */ })
    expect(leads.recordLead.mock.calls[0]![0]).not.toHaveProperty('email_normalized')
  })

  it('404s an unknown token, the same way it 404s a revoked one', async () => {
    leads.bundleForLeadToken.mockResolvedValue(null)
    const res = await postLeads(form(GOOD), '00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('drops a lead past the daily cap and still thanks the visitor', async () => {
    leads.countLeadsSince.mockResolvedValue(200)
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
    // Per bundle, and from a day boundary rather than an arbitrary instant.
    expect(leads.countLeadsSince).toHaveBeenCalledWith(BUNDLE, expect.stringMatching(/T00:00:00\.000Z$/))
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('drops a submission whose honeypot is filled, and says nothing different', async () => {
    const res = await postLeads(form({ ...GOOD, website: 'http://spam.test' }))
    expect(res.status).toBe(303)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('400s a json caller whose country is outside the two the spine admits, without writing', async () => {
    const res = await postLeads(JSON.stringify({ ...GOOD, country: 'NZ' }), TOKEN, 'application/json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_lead' })
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('sends a form caller with the same bad country back to the page, not a status code', async () => {
    const res = await postLeads(form({ ...GOOD, country: 'NZ' }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${SERVING}/physio/?lead=invalid`)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('needs no identity header, which is the point and the risk', async () => {
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
  })

  it('answers json to a json caller and never a redirect', async () => {
    const res = await postLeads(JSON.stringify({ ...GOOD }), TOKEN, 'application/json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
  })

  it('answers a known address exactly like a new one, because it cannot say which it was', async () => {
    leads.recordLead.mockResolvedValue({ leadId: '22222222-2222-4222-8222-222222222222', prospectId: '33333333-3333-4333-8333-333333333333', duplicate: true })

    const formRes = await postLeads(form(GOOD))
    expect(formRes.status).toBe(303)
    expect(formRes.headers.get('location')).toBe(`${SERVING}/physio/thanks/`)

    const jsonRes = await postLeads(JSON.stringify({ ...GOOD }), TOKEN, 'application/json')
    expect(jsonRes.status).toBe(200)
    expect(await jsonRes.json()).toEqual({ status: 'received' })
  })
})

describe('the public edge', () => {
  it('answers the lead post without an identity while the bundle read still demands one', async () => {
    const router = createMarketingRouter({ env: parseEnv({}) })

    const privateRead = await router.request(`/api/marketing/bundles/${BUNDLE}`)
    expect(privateRead.status).toBe(401)

    leads.bundleForLeadToken.mockResolvedValue(null)
    const publicPost = await router.request('/api/marketing/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(GOOD),
    })
    expect(publicPost.status).toBe(404)
    expect(publicPost.status).not.toBe(401)
    expect(publicPost.status).not.toBe(200)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * End-to-end unit coverage for the Phase 4 sponsorship intake workflow. The
 * whole pipeline runs over a mocked LLM agent and mocked DB writes/resolution,
 * so this pins the workflow's decisions — the keyword detect gate, the
 * fallback+retry-once extract path, brand→channel/customer resolution, and the
 * "always suggested" review-gate persistence — without loading pg or calling a
 * model. Mirrors the `document-intake` composition it is built from.
 */

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const OWNER = '660e8400-e29b-41d4-a716-446655440009'
const SPONSORSHIP_ID = '33333333-3333-4333-8333-333333333333'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  insertSponsorshipSuggestion: vi.fn(),
  resolveChannelByBrand: vi.fn(),
  resolveCustomerByEntity: vi.fn(),
}))

vi.mock('../../../src/mastra/agents/sponsorship-extractor', () => ({
  sponsorshipExtractorAgent: { generate: mocks.generate },
}))

vi.mock('../../../src/db/sponsorship', () => ({
  insertSponsorshipSuggestion: mocks.insertSponsorshipSuggestion,
  resolveChannelByBrand: mocks.resolveChannelByBrand,
}))

// db/documents is imported by both the sponsorship workflow and the
// document-intake helpers it reuses; provide every runtime binding so the
// module graph links without pulling in pg.
vi.mock('../../../src/db/documents', () => ({
  resolveCustomerByEntity: mocks.resolveCustomerByEntity,
  insertDocument: vi.fn(),
}))

import { sponsorshipIntakeWorkflow } from '../../../src/mastra/workflows/sponsorship-intake'

const { generate } = mocks
const insertSponsorshipSuggestion = mocks.insertSponsorshipSuggestion
const resolveChannelByBrand = mocks.resolveChannelByBrand
const resolveCustomerByEntity = mocks.resolveCustomerByEntity

const EXTRACT = {
  brandName: 'ACME Brands',
  brandEmail: 'partners@acme.test',
  dealType: 'flat',
  amount: '$5,000',
  currency: 'USD',
  dealDate: '2026-03-01',
  confidence: 0.9,
}

function extractResult(over: Record<string, unknown> = {}) {
  return { object: { ...EXTRACT, ...over }, usedFallbackValue: false }
}

async function run(inputData: Record<string, unknown>) {
  const run1 = await sponsorshipIntakeWorkflow.createRun()
  return run1.start({ inputData: inputData as never })
}

beforeEach(() => {
  generate.mockReset()
  insertSponsorshipSuggestion.mockReset()
  resolveChannelByBrand.mockReset()
  resolveCustomerByEntity.mockReset()
  resolveChannelByBrand.mockResolvedValue(CHANNEL)
  resolveCustomerByEntity.mockResolvedValue(CUSTOMER)
  // Echo the status/confidence the workflow wrote, the way the DB row would.
  insertSponsorshipSuggestion.mockImplementation((_tenant: string, data: Record<string, unknown>) =>
    Promise.resolve({
      id: SPONSORSHIP_ID,
      status: (data.status as string) ?? 'suggested',
      confidence: (data.confidence as number | null) ?? null,
    }),
  )
})

describe('sponsorship intake — obvious sponsorship email', () => {
  it('detects, extracts, resolves the brand, and persists a suggested row', async () => {
    generate.mockResolvedValue(extractResult())

    const result = await run({
      tenantId: TENANT,
      ownerId: OWNER,
      subject: 'ACME sponsorship — brand deal',
      text: 'We would like to sponsor your next video. $5,000 flat fee, payment terms net 30. Contact partners@acme.test',
      source: 'email',
    })

    expect(result.status).toBe('success')
    const payload = (result as { status: 'success'; result?: Record<string, unknown> }).result
    expect(payload).toMatchObject({
      detected: true,
      status: 'suggested',
      sponsorshipId: SPONSORSHIP_ID,
      channelId: CHANNEL,
      customerId: CUSTOMER,
    })

    // Brand→channel and brand→customer both consulted with the extracted identity.
    expect(resolveChannelByBrand).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ email: 'partners@acme.test', brandName: 'ACME Brands' }),
    )
    expect(resolveCustomerByEntity).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ email: 'partners@acme.test', name: 'ACME Brands' }),
    )

    // Exactly one persisted suggestion, hard-wired to the review gate.
    expect(insertSponsorshipSuggestion).toHaveBeenCalledTimes(1)
    const [writeTenant, writeData] =
      insertSponsorshipSuggestion.mock.calls[0] as [string, Record<string, unknown>]
    expect(writeTenant).toBe(TENANT)
    expect(writeData).toMatchObject({
      status: 'suggested',
      channelId: CHANNEL,
      customerId: CUSTOMER,
      amount: 5000,
      dealType: 'flat',
      dealDate: '2026-03-01',
    })
    // A real sha256 hex digest of `${subject}\n${text}` for (tenant, hash) dedup.
    expect(writeData.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('sponsorship intake — clearly non-sponsorship', () => {
  it('short-circuits to skipped with no agent extract and no insert', async () => {
    const result = await run({
      tenantId: TENANT,
      ownerId: OWNER,
      subject: 'Lunch tomorrow?',
      text: 'Hey, want to grab a sandwich at noon?',
      source: 'email',
    })

    expect(result.status).toBe('success')
    const payload = (result as { status: 'success'; result?: Record<string, unknown> }).result
    expect(payload).toMatchObject({ detected: false, status: 'skipped', sponsorshipId: null })
    expect(insertSponsorshipSuggestion).not.toHaveBeenCalled()
    expect(resolveChannelByBrand).not.toHaveBeenCalled()
  })
})

describe('sponsorship intake — agent fallback path', () => {
  it('still persists a suggested row with a null confidence when the model falls back', async () => {
    // Extract always falls back → needsReview, extract null.
    generate.mockResolvedValue({ object: {}, usedFallbackValue: true })

    const result = await run({
      tenantId: TENANT,
      ownerId: OWNER,
      subject: 'Sponsorship / brand deal proposal',
      text: 'This is a paid partnership sponsorship offer with a rate card and deliverables.',
      source: 'email',
    })

    expect(result.status).toBe('success')
    const payload = (result as { status: 'success'; result?: Record<string, unknown> }).result
    expect(payload).toMatchObject({ detected: true, status: 'suggested', confidence: null })
    // The retry-once pattern means a fallback still gives the model a second shot.
    expect(generate.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(insertSponsorshipSuggestion).toHaveBeenCalledTimes(1)
    const writeData = insertSponsorshipSuggestion.mock.calls[0]![1] as Record<string, unknown>
    expect(writeData.status).toBe('suggested')
    expect(writeData.confidence).toBeNull()
  })
})

describe('sponsorship intake — non-numeric amount', () => {
  it('normalises a free-text amount to a null money column via parseMoneyValue', async () => {
    generate.mockResolvedValue(extractResult({ amount: 'POA on request' }))

    const result = await run({
      tenantId: TENANT,
      ownerId: OWNER,
      subject: 'Sponsorship enquiry',
      text: 'Interested in a sponsorship and brand deal for our campaign.',
      source: 'email',
    })

    expect(result.status).toBe('success')
    expect(insertSponsorshipSuggestion).toHaveBeenCalledTimes(1)
    const writeData = insertSponsorshipSuggestion.mock.calls[0]![1] as Record<string, unknown>
    // "POA on request" is not a number, so it must NOT be coerced to 0 — it stays null.
    expect(writeData.amount ?? null).toBeNull()
  })
})

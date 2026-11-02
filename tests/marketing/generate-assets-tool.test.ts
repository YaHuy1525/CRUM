// tests/marketing/generate-assets-tool.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  insertMarketingArtifacts: vi.fn(),
  getDesignerArtifactText: vi.fn(),
  insertAssetDocument: vi.fn(),
  hashImageBytes: vi.fn(),
  listImageAssetStatuses: vi.fn(),
  committedSpendMinor: vi.fn(),
  committedBundleSpendMinor: vi.fn(),
  recordImageSpend: vi.fn(),
  createHumanTask: vi.fn(),
  selectImageAdapter: vi.fn(),
  listImageProviders: vi.fn(),
  selectedImageProviderName: vi.fn(),
  generate: vi.fn(),
}))

vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: h.getMarketingBundle,
  insertMarketingArtifacts: h.insertMarketingArtifacts,
  ARTIFACT_KINDS: ['script', 'image', 'page_html', 'thank_you_html', 'ad_copy'],
  MARKETING_OBJECTIVES: ['outreach_support', 'inbound_leads', 'proof_asset'],
  MARKETING_ROLES: [
    'offer-strategist',
    'marketer-copywriter',
    'creative-designer',
    'media-buyer',
    'funnel-builder',
    'campaign-analyst',
  ],
}))
vi.mock('../../src/db/marketing-assets', () => ({
  getDesignerArtifactText: h.getDesignerArtifactText,
  insertAssetDocument: h.insertAssetDocument,
  hashImageBytes: h.hashImageBytes,
  listImageAssetStatuses: h.listImageAssetStatuses,
}))
vi.mock('../../src/marketing/image-spend', async () => {
  const actual = await vi.importActual<typeof import('../../src/marketing/image-spend')>(
    '../../src/marketing/image-spend',
  )
  return { ...actual, committedSpendMinor: h.committedSpendMinor, committedBundleSpendMinor: h.committedBundleSpendMinor, recordImageSpend: h.recordImageSpend }
})
vi.mock('../../src/db/pending-writes', () => ({ createHumanTask: h.createHumanTask }))
vi.mock('../../src/marketing/image-provider', () => ({
  selectImageAdapter: h.selectImageAdapter,
  listImageProviders: h.listImageProviders,
  selectedImageProviderName: h.selectedImageProviderName,
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const OWNER = '77777777-7777-4777-8777-777777777777'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DOC = '99999999-9999-4999-8999-999999999999'
const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const context = {
  requestContext: { all: { tenantId: TENANT, userId: OWNER, userRole: 'user' } },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never

function bundle(status: string) {
  return { id: BUNDLE, tenantId: TENANT, brief: 'b', objective: 'outreach_support', status }
}

function promptJson(...names: string[]): string {
  return JSON.stringify({
    assets: names.map((name) => ({
      name,
      prompt: `a prompt for ${name}`,
      aspectRatio: '16:9',
      negativePrompt: null,
    })),
  })
}

function okImage(name: string, costMinor = 4) {
  return {
    ok: true as const,
    image: {
      predictionId: `pred-${name}`,
      costUsd: '0.04',
      costMinor,
      model: 'black-forest-labs/flux-1.1-pro',
      aspectRatio: '16:9',
      mime: 'image/png' as const,
      bytes: new Uint8Array([1, 2, 3]),
      sizeBytes: 3,
    },
  }
}

function failImage(code: string, detail: string, charge: unknown = null, deadToken = false) {
  return { ok: false as const, code, detail, charge, deadToken }
}

/**
 * The ledger as a closure, so the arithmetic under test is the real admitsRun over
 * a running total rather than a scripted sequence of answers. Tracks both the
 * daily total and the per-bundle lifetime total; the test uses one bundle,
 * `BUNDLE`, throughout, so both increment together.
 */
function ledger(dayStart = 0, bundleStart = 0) {
  let committed = dayStart
  let bundleCommitted = bundleStart
  // Not `async () =>`: this repo's lint rejects an async arrow with no await in it,
  // and a promise literal keeps the ledger's timing identical.
  h.committedSpendMinor.mockImplementation(() => Promise.resolve(committed))
  h.committedBundleSpendMinor.mockImplementation(() => Promise.resolve(bundleCommitted))
  h.recordImageSpend.mockImplementation((params: { costMinor: number }) => {
    committed += params.costMinor
    bundleCommitted += params.costMinor
    return Promise.resolve('spend-row')
  })
  return { get committed() { return committed }, get bundleCommitted() { return bundleCommitted } }
}

async function run(input: { bundleId: string }) {
  const { generateAssetsTool } = await import('../../src/mastra/tools/marketing-writes')
  return (await generateAssetsTool.execute!(input, context)) as {
    bundleId: string
    assets: Array<{ name: string; documentId: string; status: string; deduplicated: boolean; costMinor: number }>
    refused: Array<{ name: string; code: string; detail: string }>
    spentMinor: number
    provider: string | null
    model: string | null
    humanTaskId: string | null
    riskScore: number
    gate: string
    message: string
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.selectImageAdapter.mockReturnValue({
    provider: 'replicate',
    model: 'black-forest-labs/flux-1.1-pro',
    ceilingMinor: 2000,
    bundleCeilingMinor: 200,
    costMinorPerImage: 4,
    maxBytes: 15 * 1024 * 1024,
    generate: h.generate,
  })
  h.listImageProviders.mockReturnValue(['replicate'])
  h.selectedImageProviderName.mockReturnValue('replicate')
  h.getMarketingBundle.mockResolvedValue(bundle('draft'))
  h.getDesignerArtifactText.mockResolvedValue(promptJson('hero-image'))
  h.hashImageBytes.mockReturnValue('c'.repeat(64))
  h.insertAssetDocument.mockResolvedValue({
    id: DOC,
    status: 'needs_review',
    contentHash: 'c'.repeat(64),
    deduplicated: false,
  })
  h.insertMarketingArtifacts.mockResolvedValue(1)
  h.createHumanTask.mockResolvedValue(TASK_ID)
  h.generate.mockResolvedValue(okImage('hero-image'))
  h.listImageAssetStatuses.mockResolvedValue([])
  ledger(0)
})

describe('marketing.generate_assets refuses before it costs anything', () => {
  it('refuses a live bundle, because shipping assets for a finished campaign is not the job', async () => {
    h.getMarketingBundle.mockResolvedValue(bundle('live'))
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('bundle_not_generable')
    expect(result.assets).toHaveLength(0)
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.createHumanTask).toHaveBeenCalledTimes(1)
    expect(result.humanTaskId).toBe(TASK_ID)
  })

  it('refuses an archived bundle', async () => {
    h.getMarketingBundle.mockResolvedValue(bundle('archived'))
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('bundle_not_generable')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses a missing bundle', async () => {
    h.getMarketingBundle.mockResolvedValue(null)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('not_found')
    // The prose has to match the rows: `bundle` is null here, so the human-task
    // block is skipped and no task exists. This case is the only cover for that
    // branch of the refused-branch message, which used to promise a task
    // unconditionally.
    expect(result.humanTaskId).toBeNull()
    expect(h.createHumanTask).not.toHaveBeenCalled()
    expect(result.message).toContain('not_found')
    expect(result.message).toContain('No human task was created')
    expect(result.message).not.toContain('A human task was created.')
  })

  it('refuses with no_asset_prompts when the designer artifact row is absent', async () => {
    h.getDesignerArtifactText.mockResolvedValue(null)
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('no_asset_prompts')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses with asset_prompts_unparsable when the creative arrived as prose', async () => {
    h.getDesignerArtifactText.mockResolvedValue('Make it friendly, maybe a reception desk.')
    expect((await run({ bundleId: BUNDLE })).refused[0]!.code).toBe('asset_prompts_unparsable')
  })

  it('refuses at call time when no adapter is registered, which is an absent token', async () => {
    h.selectImageAdapter.mockReturnValue(null)
    h.listImageProviders.mockReturnValue([])
    h.selectedImageProviderName.mockReturnValue('replicate')
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('image_provider_not_configured')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('refuses with image_provider_unknown when the config names something nothing registered', async () => {
    h.selectImageAdapter.mockReturnValue(null)
    h.listImageProviders.mockReturnValue(['replicate'])
    h.selectedImageProviderName.mockReturnValue('stability')
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('image_provider_unknown')
    expect(String(result.refused[0]!.detail)).toContain('stability')
    expect(String(result.refused[0]!.detail)).toContain('replicate')
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('never charges a second provider for a picture the first one failed to make', async () => {
    // The ruling (option A) in test form: one adapter registered, one failure with a
    // charge, and the run reports the charge with no second attempt. A fallback would
    // make the ceiling arithmetic a lie, because two providers failing one image
    // bill one image twice.
    h.generate.mockResolvedValueOnce(
      failImage('replicate_down', 'replicate down', { predictionId: 'pred-hero-image', costUsd: '0.04', costMinor: 4 }),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.recordImageSpend).toHaveBeenCalledTimes(1)
    expect(result.refused[0]!.code).toBe('replicate_down')
    expect(result.spentMinor).toBe(4)
  })

  it('refuses the whole run before any money moves when the ceiling will not cover it', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(1990)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('image_spend_ceiling_reached')
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.createHumanTask).toHaveBeenCalledTimes(1)
  })

  it('names every asset a ceiling refusal stopped, because "1 refusal" hides three', async () => {
    // The run-level `'*'` shape this case used to have is what Step 8's
    // integration test contradicts: two pending assets must read back as two
    // named refusals and a human task titled "refused 2 asset(s)".
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(1990)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a', 'b', 'c'])
    const [task] = h.createHumanTask.mock.calls[0] as [{ title: string }]
    expect(task.title).toContain('refused 3 asset(s)')
  })

  it('refuses on the bundle ceiling before it mentions the day', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(0, 195)
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused.map((r) => r.code)).toEqual([
      'image_bundle_ceiling_reached',
      'image_bundle_ceiling_reached',
      'image_bundle_ceiling_reached',
    ])
    expect(h.generate).not.toHaveBeenCalled()
    expect(String(result.refused[0]!.detail)).toContain('CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE')
  })

  it('reports both ceilings when both bind, because an owner should not have to discover the second one tomorrow', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    ledger(1990, 195)
    const result = await run({ bundleId: BUNDLE })
    const codes = result.refused.map((r) => r.code)
    expect(codes).toContain('image_bundle_ceiling_reached')
    expect(codes).toContain('image_spend_ceiling_reached')
    // Three assets, six refusal lines, and a title that says three. The line count
    // is what `refusedProse` needs to tell the owner what is missing; the asset count
    // is what a human task title must claim.
    const [task] = h.createHumanTask.mock.calls[0] as [{ title: string }]
    expect(task.title).toContain('refused 3 asset(s)')
    expect(result.refused).toHaveLength(6)
  })

  it('stops at the bundle boundary mid-run, after the provider actually charged past the estimate', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    // Pre-flight: 188 + 3*4 = 200 <= 200, admits. After 'a' costs 12: 188+12=200.
    // Mid-loop for 'b': 200 + 4 = 204 > 200, refuses.
    ledger(0, 188)
    h.generate.mockResolvedValueOnce(okImage('a', 12)).mockResolvedValue(okImage('b'))
    const result = await run({ bundleId: BUNDLE })
    expect(result.assets.map((asset) => asset.name)).toEqual(['a'])
    expect(result.refused.map((r) => [r.name, r.code])).toEqual([
      ['b', 'image_bundle_ceiling_reached'],
      ['c', 'image_bundle_ceiling_reached'],
    ])
  })

  it('attributes every spend row to the bundle, including the ones with nothing to show', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a'))
    h.generate.mockResolvedValue(failImage('asset_too_large', '16 MB', { predictionId: 'pred-a', costUsd: '0.04', costMinor: 4 }))
    await run({ bundleId: BUNDLE })
    expect(h.recordImageSpend.mock.calls[0]![0]).toMatchObject({ bundleId: BUNDLE, documentId: null })
  })

  it('keeps the refusal prose to ten entries but reports every refusal', async () => {
    // `refusedProse`'s `slice(0, 10)` is the only bound on how much text a run can
    // write into one `human_tasks.body` row (ruling 6d): an artifact of five
    // thousand prompts would otherwise put five thousand sentences in it. Nothing
    // else in this file reaches ten refusals — the largest is three — so the
    // `…and N more.` tail was never executed and never asserted. Eleven is the
    // smallest set that runs the tail, and the tool output must still hold all
    // eleven, because the prose is capped for the queue, not for the owner.
    const names = Array.from({ length: 11 }, (_unused, index) => `asset-${index + 1}`)
    h.getDesignerArtifactText.mockResolvedValue(promptJson(...names))
    h.generate.mockResolvedValue(
      failImage('image_generation_failed', 'replicate rejected the api token (401)', null, true),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused).toHaveLength(11)
    const [task] = h.createHumanTask.mock.calls[0] as [{ body: string }]
    expect(task.body).toContain('\u2026and 1 more.')
    expect(task.body).toContain('asset-1: image_generation_failed')
    expect(task.body).not.toContain('asset-11')
  })

  it('keeps a refusal detail to one sentence when the artifact echoes back at it', async () => {
    // `asset-prompts.ts:47-50` interpolates JSON.stringify(parsed) into the detail,
    // and a designer artifact that is a JSON-encoded long string makes that detail
    // as long as the artifact. This tool writes that string into its own output and
    // into human_tasks.body, so the bound belongs here.
    h.getDesignerArtifactText.mockResolvedValue(JSON.stringify('x'.repeat(5000)))
    const result = await run({ bundleId: BUNDLE })
    expect(result.refused[0]!.code).toBe('asset_prompts_unparsable')
    expect(result.refused[0]!.detail).toHaveLength(400)
    expect(result.refused[0]!.detail.endsWith('\u2026')).toBe(true)
  })
})

describe('marketing.generate_assets spends', () => {
  it('reads prompts from the stored artifact and never from its arguments', async () => {
    // The input schema has one field, bundleId, so anything reaching the provider
    // must have come out of the artifact row. That is the assertion, and it is the
    // reason the tool cannot be talked into an image the reviewer never read.
    const result = await run({ bundleId: BUNDLE })
    // `as number` because `expect.any` returns `any`, and this repo's lint fails an
    // unsafe assignment. The matcher still asserts "some number"; the seed's value
    // is pinned by the case below, not here.
    expect(h.generate).toHaveBeenCalledWith({
      prompt: 'a prompt for hero-image',
      aspectRatio: '16:9',
      seed: expect.any(Number) as number,
      negativePrompt: null,
    })
    expect(result.assets).toHaveLength(1)
  })

  it('derives the same seed for the same bundle and asset name, twice', async () => {
    await run({ bundleId: BUNDLE })
    const first = h.generate.mock.calls[0]![0] as { seed: number }
    h.generate.mockClear()
    await run({ bundleId: BUNDLE })
    const second = h.generate.mock.calls[0]![0] as { seed: number }
    expect(second.seed).toBe(first.seed)
    expect(Number.isSafeInteger(first.seed)).toBe(true)
  })

  it('attaches through the existing artifact path rather than a second one', async () => {
    await run({ bundleId: BUNDLE })
    expect(h.insertMarketingArtifacts).toHaveBeenCalledWith({
      tenantId: TENANT,
      bundleId: BUNDLE,
      artifacts: [{ role: 'creative-designer', kind: 'image', documentId: DOC, textContent: null }],
    })
  })

  it('records the cost Replicate reported, not the admission estimate', async () => {
    h.generate.mockResolvedValue(okImage('hero-image', 7))
    const result = await run({ bundleId: BUNDLE })
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      bundleId: BUNDLE,
      documentId: DOC,
      costMinor: 7,
      // Named explicitly by the tool, not left to `image-spend.ts`'s
      // REPLICATE_PROVIDER default: the ledger row and the answer below have to
      // agree about who was paid even when the registered adapter is not Replicate.
      provider: 'replicate',
      rawExtract: {
        predictionId: 'pred-hero-image',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    // The pair the owner reads. `provider` used to be typed in the output schema
    // and asserted nowhere, so a tool that booked every row under the default while
    // answering with `adapter?.provider` passed; these two lines are what close it.
    expect(result.provider).toBe('replicate')
    expect(result.model).toBe('black-forest-labs/flux-1.1-pro')
    expect(result.spentMinor).toBe(7)
    expect(result.assets[0]).toEqual({
      name: 'hero-image',
      documentId: DOC,
      status: 'needs_review',
      deduplicated: false,
      costMinor: 7,
    })
  })

  it('stops at the boundary mid-run and keeps the assets it already made', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
    // The pre-flight check admits three images at the 4-minor estimate: 1985 + 12
    // fits a 2000 ceiling. The first prediction then costs 12, so b no longer
    // fits and c is never attempted. The ceiling is enforced against what the
    // provider actually charged, not against what was estimated when the run
    // started, and every asset the stop left behind is reported, not dropped.
    ledger(1985)
    h.generate.mockResolvedValueOnce(okImage('a', 12)).mockResolvedValue(okImage('b'))
    const result = await run({ bundleId: BUNDLE })
    expect(result.assets.map((asset) => asset.name)).toEqual(['a'])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['b', 'c'])
    expect(result.refused[0]!.code).toBe('image_spend_ceiling_reached')
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(result.spentMinor).toBe(12)
  })

  it('spends nothing on a bundle that already carries every asset', async () => {
    // The skip is on the asset name the reviewer reads, which is the document
    // title the attach path wrote: a re-run finds the hero image already on the
    // bundle and never reaches the provider. Spec section 6 idempotency.
    h.listImageAssetStatuses.mockResolvedValue([
      { documentId: DOC, title: 'hero-image', status: 'ready', kind: 'marketing_asset' },
    ])
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.recordImageSpend).not.toHaveBeenCalled()
    expect(h.insertMarketingArtifacts).not.toHaveBeenCalled()
    expect(h.createHumanTask).not.toHaveBeenCalled()
    expect(result.spentMinor).toBe(0)
    expect(result.assets).toEqual([
      { name: 'hero-image', documentId: DOC, status: 'ready', deduplicated: true, costMinor: 0 },
    ])
    expect(result.refused).toHaveLength(0)
  })

  it('attaches a carried asset only when it is not already on the bundle', async () => {
    // Two prompts, one already carried: the run pays for the missing one and
    // reports both, so a partial first run is finishable without re-buying.
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.listImageAssetStatuses.mockResolvedValue([
      { documentId: DOC, title: 'a', status: 'needs_review', kind: 'marketing_asset' },
    ])
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.generate.mock.calls[0]![0]).toMatchObject({ prompt: 'a prompt for b' })
    expect(result.assets.map((asset) => asset.name)).toEqual(['a', 'b'])
    expect(result.assets[0]!.deduplicated).toBe(true)
    expect(result.assets[1]!.deduplicated).toBe(false)
  })

  it('stops the run at a dead token instead of paying forty visits to it', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate.mockResolvedValue(failImage('image_generation_failed', 'replicate rejected the api token (401)', null, true))
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(result.refused[0]!.detail).toContain('token')
    expect(result.refused).toHaveLength(2)
  })

  it('records the spend for a prediction that produced no usable bytes', async () => {
    h.generate.mockResolvedValue(
      failImage('asset_too_large', '16 MB', { predictionId: 'pred-hero-image', costUsd: '0.04', costMinor: 4 }),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      bundleId: BUNDLE,
      documentId: null,
      costMinor: 4,
      provider: 'replicate',
      // The failed path takes the model name from the adapter, because a charge
      // carries a prediction id and a price but not the model that made it.
      rawExtract: {
        predictionId: 'pred-hero-image',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    expect(result.refused[0]!.code).toBe('asset_too_large')
    expect(result.spentMinor).toBe(4)
  })

  it('invoices a prediction the document lane refused, then stops rather than paying again', async () => {
    // The hole this case closes: `insertAssetDocument` rejects on 0 bytes before it
    // touches the database (src/db/marketing-assets.ts:75) and a real document
    // write can reject for its own reasons, while the money is already gone. With
    // the spend booked after an uncalled-for catch, the rejection escapes `execute`
    // and spec section 9's billed-but-unusable prediction never reaches the ledger.
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate.mockResolvedValue(okImage('a'))
    h.insertAssetDocument.mockRejectedValue(
      new Error('insertAssetDocument: "a" carries 0 bytes, which is not an image'),
    )
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.recordImageSpend).toHaveBeenCalledWith({
      tenantId: TENANT,
      bundleId: BUNDLE,
      documentId: null,
      costMinor: 4,
      provider: 'replicate',
      rawExtract: {
        predictionId: 'pred-a',
        model: 'black-forest-labs/flux-1.1-pro',
        costUsd: '0.04',
      },
    })
    expect(result.refused.map((refusal) => refusal.code)).toEqual([
      'asset_storing_failed',
      'asset_storing_failed',
    ])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a', 'b'])
    expect(result.spentMinor).toBe(4)
    expect(result.assets).toEqual([])
    expect(h.insertMarketingArtifacts).not.toHaveBeenCalled()
  })

  it('keeps going after one asset fails, so a rate limit never loses the other images', async () => {
    h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b'))
    h.generate
      .mockResolvedValueOnce(failImage('image_generation_failed', 'rate limited', null, false))
      .mockResolvedValueOnce(okImage('b'))
    const result = await run({ bundleId: BUNDLE })
    expect(h.generate).toHaveBeenCalledTimes(2)
    expect(result.assets.map((asset) => asset.name)).toEqual(['b'])
    expect(result.refused.map((refusal) => refusal.name)).toEqual(['a'])
  })

  it('never marks an image ready, and reports the status the lane gave back', async () => {
    const result = await run({ bundleId: BUNDLE })
    expect(result.assets[0]!.status).toBe('needs_review')
    const insertParams = h.insertAssetDocument.mock.calls[0]![0] as { title: string }
    expect(insertParams.title).toBe('hero-image')
  })
})

describe('marketing.generate_assets stays an auto tool governance can see', () => {
  it('scores its redacted view at benign and gates auto', async () => {
    const result = await run({ bundleId: BUNDLE })
    expect(result.gate).toBe('auto')
    expect(result.riskScore).toBeLessThan(40)
  })

  it('names nothing but identifiers, counts and dollars in its risk view', async () => {
    const { generateAssetsRiskView } = await import('../../src/marketing/payload')
    const view = generateAssetsRiskView({
      bundleId: BUNDLE,
      objective: 'outreach_support',
      assetCount: 3,
      estimatedCostMinor: 12,
    })
    expect(Object.keys(view).sort()).toEqual([
      'assetCount',
      'bundleId',
      'estimatedCostMinor',
      'objective',
    ])
  })
})

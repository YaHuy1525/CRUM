import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ listMarketingArtifacts: vi.fn() }))

vi.mock('../../src/db/marketing', () => ({
  listMarketingArtifacts: db.listMarketingArtifacts,
}))

import { buildUploadForm, PageHostError, type PageHostConfig } from '@/marketing/page-host'
import { resolveSite, siteHashOf, type SiteFile } from '@/marketing/site'

const CONFIG: PageHostConfig = {
  accountId: 'acc',
  project: 'proj',
  apiToken: 'tok',
  productionBranch: 'main',
  previewBranchPrefix: 'crum-preview',
  apiBaseUrl: 'https://api.cloudflare.com/client/v4',
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

const files = resolveSite('physio', [
  { id: 'a1', kind: 'page_html', textContent: '<h1>hi</h1>' },
])

const PAYLOAD = { bundleId: BUNDLE, slug: 'physio', siteHash: siteHashOf(files) }

function artifactRow() {
  return {
    id: 'a1',
    role: 'funnel-builder',
    kind: 'page_html',
    documentId: null,
    textContent: '<h1>hi</h1>',
    status: 'saved',
    createdAt: '2026-10-31T00:00:00.000Z',
  }
}

// The branch each adapter computed from its config is only ever visible on the
// wire, so the stub records it from the form the adapter actually posted.
const uploads: string[] = []

function stubUpload() {
  const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData
    uploads.push(formText(form, 'branch'))
    return Promise.resolve(new Response(
      JSON.stringify({ success: true, result: { id: 'd1', url: 'h1.pages.dev' } }),
      { status: 200 },
    ))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  db.listMarketingArtifacts.mockReset()
  uploads.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function formText(form: FormData, name: string): string {
  const value = form.get(name)
  if (typeof value !== 'string') throw new Error(`form field ${name} is not text`)
  return value
}

describe('buildUploadForm', () => {
  it('maps each path to its content hash and names one part per hash', async () => {
    const form = buildUploadForm(files, 'crum-preview/physio', 'crum bundle')
    expect(form.get('branch')).toBe('crum-preview/physio')
    const manifest = JSON.parse(formText(form, 'manifest')) as Record<string, string>
    expect(manifest['physio/index.html']).toBe(files[0]?.sha256)
    const part = form.get(files[0]!.sha256)
    expect(part).toBeInstanceOf(Blob)
    // The part's own media type, which `Blob.text()` cannot see: this is the one
    // behaviour Task 1 changed here, and a hardcoded `'text/html'` default would
    // still hand back the same markup on the next line, so the label needs its
    // own assertion — and one that a non-`text/html` file can differ from.
    expect((part as Blob).type).toBe('text/html')
    expect(await (part as Blob).text()).toBe('<h1>hi</h1>')
  })

  it('labels each part with the type its own file carries, because one default for every part is the bug', () => {
    const asset: SiteFile = {
      path: 'physio/assets/hero.png',
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      contentType: 'image/png',
      content: new Uint8Array([1, 2, 3]),
    }
    const form = buildUploadForm([...files, asset], 'b', 'm')
    expect((form.get(asset.sha256) as Blob).type).toBe('image/png')
    // And the page keeps its own label instead of inheriting the last one set.
    expect((form.get(files[0]!.sha256) as Blob).type).toBe('text/html')
  })

  it('sends no zip, because the documented body is a hash manifest', () => {
    const names = [...buildUploadForm(files, 'b', 'm').keys()]
    expect(names).not.toContain('file')
    expect(names).not.toContain('zip')
  })

  it('lists every path, because a manifest that drops one publishes half a site', () => {
    const two = resolveSite('physio', [
      { id: 'a1', kind: 'page_html', textContent: '<h1>hi</h1>' },
      { id: 'a2', kind: 'thank_you_html', textContent: '<p>thanks</p>' },
    ])
    const form = buildUploadForm(two, 'b', 'm')
    const manifest = JSON.parse(formText(form, 'manifest')) as Record<string, string>
    for (const file of two) expect(manifest[file.path]).toBe(file.sha256)
    expect(Object.keys(manifest)).toHaveLength(two.length)
  })

  it('sends one part per hash, because the manifest maps two paths to the same bytes', async () => {
    const shared = resolveSite('physio', [
      { id: 'a1', kind: 'page_html', textContent: '<h1>same</h1>' },
      { id: 'a2', kind: 'thank_you_html', textContent: '<h1>same</h1>' },
    ])
    const hash = shared[0]?.sha256 ?? ''
    expect(shared[1]?.sha256).toBe(hash)
    const form = buildUploadForm(shared, 'b', 'm')
    // A second part with the same name would upload the same bytes twice; the
    // manifest already maps both paths to this one hash.
    expect([...form.keys()].filter((key) => key === hash)).toHaveLength(1)
    const manifest = JSON.parse(formText(form, 'manifest')) as Record<string, string>
    expect(manifest['physio/thanks/index.html']).toBe(hash)
    expect(await (form.get(hash) as Blob).text()).toBe('<h1>same</h1>')
  })
})

describe('PageHostError', () => {
  it('is thrown with the provider body, because a silent-looking failure is the common shape here', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 80001, message: 'no scope' }] }), { status: 403 }),
    )
    const { deploySite } = await import('@/marketing/page-host')
    await expect(deploySite(CONFIG, files, 'crum-preview/physio', 'm', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/80001/)
  })

  it('carries the http status for the publisher to record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const { deploySite } = await import('@/marketing/page-host')
    const err: unknown = await deploySite(CONFIG, files, 'b', 'm', fetchImpl as unknown as typeof fetch)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PageHostError)
    expect((err as PageHostError).status).toBe(500)
  })
})

describe('deploySite', () => {
  it('posts the form to the project endpoint, and the branch is what separates preview from production', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      calls.push(formText(form, 'branch'))
      return Promise.resolve(new Response(
        JSON.stringify({ success: true, result: { id: `d${calls.length}`, url: `h${calls.length}.pages.dev` } }),
        { status: 200 },
      ))
    })
    const { deploySite } = await import('@/marketing/page-host')
    const preview = await deploySite(CONFIG, files, `${CONFIG.previewBranchPrefix}/physio`, 'preview', fetchImpl)
    const live = await deploySite(CONFIG, files, CONFIG.productionBranch, 'live', fetchImpl)

    expect(calls).toEqual(['crum-preview/physio', 'main'])
    expect(preview).toEqual({ deploymentId: 'd1', url: 'https://h1.pages.dev' })
    expect(live).toEqual({ deploymentId: 'd2', url: 'https://h2.pages.dev' })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/pages/projects/proj/deployments')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ Authorization: 'Bearer tok' })
  })
})

describe('the page adapters', () => {
  it('name the actions the outbox routes, and register nothing at import time', async () => {
    const { makePublishPageAdapter, makePromotePageAdapter } = await import('@/marketing/page-host')
    const { isExecutable } = await import('@/marketing/outbox')
    expect(makePublishPageAdapter(CONFIG).name).toBe('publish_page')
    expect(makePromotePageAdapter(CONFIG).name).toBe('promote_page')
    // Task 8 registers these only when credentials exist; importing the module
    // must not be enough to make an action approvable.
    expect(isExecutable('publish_page')).toBe(false)
    expect(isExecutable('promote_page')).toBe(false)
  })

  it('reads the bundle with the tenant the drainer claimed, not one the payload could name', async () => {
    stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([artifactRow()])
    const { makePublishPageAdapter } = await import('@/marketing/page-host')
    const deployed = await makePublishPageAdapter(CONFIG).execute(
      // A payload that somehow carried a tenant is still not the authority: the
      // claimed action row is. The decoy is what makes a read that prefers the
      // payload fail this assertion, not just a read that drops the tenant.
      { action: 'publish_page', payload: { ...PAYLOAD, tenantId: OTHER_TENANT } },
      { tenantId: TENANT },
    )
    expect(db.listMarketingArtifacts).toHaveBeenCalledWith(TENANT, BUNDLE)
    expect(deployed).toEqual({ externalId: 'd1', url: 'https://h1.pages.dev', fileCount: 1 })
  })

  it('threads the same tenant through the promote read, because promotion re-uploads the same bundle', async () => {
    stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([artifactRow()])
    const { makePromotePageAdapter } = await import('@/marketing/page-host')
    const deployed = await makePromotePageAdapter(CONFIG).execute(
      { action: 'promote_page', payload: PAYLOAD },
      { tenantId: TENANT },
    )
    expect(db.listMarketingArtifacts).toHaveBeenCalledWith(TENANT, BUNDLE)
    expect(deployed).toEqual({ externalId: 'd1', url: 'https://h1.pages.dev', fileCount: 1 })
  })
})

describe('the branch each adapter uploads to', () => {
  it('publishes to the preview branch the config prefix and the slug name', async () => {
    stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([artifactRow()])
    const { makePublishPageAdapter } = await import('@/marketing/page-host')
    await makePublishPageAdapter(CONFIG).execute(
      { action: 'publish_page', payload: PAYLOAD },
      { tenantId: TENANT },
    )
    expect(uploads).toEqual([`${CONFIG.previewBranchPrefix}/${PAYLOAD.slug}`])
  })

  it('promotes to the production branch, because a re-upload anywhere else never goes live', async () => {
    stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([artifactRow()])
    const { makePromotePageAdapter } = await import('@/marketing/page-host')
    await makePromotePageAdapter(CONFIG).execute(
      { action: 'promote_page', payload: PAYLOAD },
      { tenantId: TENANT },
    )
    expect(uploads).toEqual([CONFIG.productionBranch])
  })
})

describe('the byte re-check', () => {
  it('refuses bytes that no longer hash to the approved one, before anything is uploaded', async () => {
    const uploaded = stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([{ ...artifactRow(), textContent: '<h1>edited</h1>' }])
    const { makePublishPageAdapter } = await import('@/marketing/page-host')
    await expect(makePublishPageAdapter(CONFIG).execute(
      { action: 'publish_page', payload: PAYLOAD },
      { tenantId: TENANT },
    )).rejects.toThrow(/site_hash_moved/)
    expect(uploaded).not.toHaveBeenCalled()
  })

  it('refuses a payload with no string hash, because an unchecked upload publishes unapproved bytes', async () => {
    const uploaded = stubUpload()
    db.listMarketingArtifacts.mockResolvedValue([artifactRow()])
    const { makePublishPageAdapter } = await import('@/marketing/page-host')
    const adapter = makePublishPageAdapter(CONFIG)
    const payloads = [
      { bundleId: BUNDLE, slug: 'physio' },
      { bundleId: BUNDLE, slug: 'physio', siteHash: 42 },
    ]
    for (const payload of payloads) {
      await expect(adapter.execute({ action: 'publish_page', payload }, { tenantId: TENANT }))
        .rejects.toThrow(/site_hash_missing/)
    }
    expect(uploaded).not.toHaveBeenCalled()
  })
})

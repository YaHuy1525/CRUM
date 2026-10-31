import { describe, expect, it, vi } from 'vitest'
import { buildUploadForm, PageHostError, type PageHostConfig } from '@/marketing/page-host'
import { resolveSite } from '@/marketing/site'

const CONFIG: PageHostConfig = {
  accountId: 'acc',
  project: 'proj',
  apiToken: 'tok',
  productionBranch: 'main',
  previewBranchPrefix: 'crum-preview',
}

const files = resolveSite('physio', [
  { id: 'a1', kind: 'page_html', textContent: '<h1>hi</h1>' },
])

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
    expect(await (part as Blob).text()).toBe('<h1>hi</h1>')
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
})

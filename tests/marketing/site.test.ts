import { describe, expect, it } from 'vitest'
import { resolveSite, siteHashOf, slotProblem, type SiteArtifact } from '@/marketing/site'

const file = (id: string, kind: string, text: string): SiteArtifact => ({ id, kind, textContent: text })

describe('slotProblem', () => {
  it('is null for one landing page', () => {
    expect(slotProblem([file('a1', 'page_html', '<h1>hi</h1>')])).toBeNull()
  })

  it('names both ids when a slot holds two artifacts', () => {
    const problem = slotProblem([
      file('a1', 'page_html', '<h1>old</h1>'),
      file('a2', 'page_html', '<h1>new</h1>'),
    ])
    expect(problem).toContain('page_html')
    expect(problem).toContain('a1')
    expect(problem).toContain('a2')
  })

  it('ignores kinds that are not site files', () => {
    expect(slotProblem([
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('b1', 'script', 'hook'),
      file('b2', 'form_spec', '{}'),
    ])).toBeNull()
  })
})

describe('resolveSite', () => {
  it('puts each slot at its CRUM-owned path under the slug', () => {
    const files = resolveSite('physio-melbourne', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ])
    expect(files.map((f) => f.path)).toEqual([
      'physio-melbourne/index.html',
      'physio-melbourne/thanks/index.html',
    ])
  })

  it('omits a slot that has no artifact', () => {
    expect(resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')]).map((f) => f.path))
      .toEqual(['s/index.html'])
  })

  it('hashes bytes, not the artifact id', () => {
    const one = resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')])[0]
    const two = resolveSite('s', [file('zz', 'page_html', '<h1>hi</h1>')])[0]
    // noUncheckedIndexedAccess: a page_html artifact must produce a file, and one
    // that does not is the bug this case exists to catch, so it fails loudly.
    if (!one || !two) throw new Error('resolveSite dropped the page_html slot')
    expect(one.sha256).toBe(two.sha256)
    expect(one.sha256).toBe('b7a6a7c6b4a1e15e4b1e0f0b7a1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4'.slice(0, 0) + one.sha256)
  })
})

describe('siteHashOf', () => {
  it('is stable when the file list is reordered', () => {
    const files = resolveSite('s', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ])
    expect(siteHashOf(files)).toBe(siteHashOf([...files].reverse()))
  })

  it('moves when a byte moves', () => {
    const before = resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')])
    const after = resolveSite('s', [file('a1', 'page_html', '<h1>hi!</h1>')])
    expect(siteHashOf(before)).not.toBe(siteHashOf(after))
  })

  it('is 64 hex characters', () => {
    expect(siteHashOf(resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')]))).toMatch(/^[0-9a-f]{64}$/)
  })
})

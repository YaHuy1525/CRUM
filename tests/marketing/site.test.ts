import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SlugProblemError,
  SlotProblemError,
  resolveSite,
  siteHashOf,
  slugProblem,
  slotProblem,
  type SiteArtifact,
} from '@/marketing/site'

const file = (id: string, kind: string, text: string): SiteArtifact => ({ id, kind, textContent: text })

describe('slugProblem', () => {
  it('is null for a bundle with no page and for a publishable slug', () => {
    expect(slugProblem(null)).toBeNull()
    expect(slugProblem('physio-melbourne')).toBeNull()
  })

  it('says which slug it refused and what a slug may look like', () => {
    const problem = slugProblem('Free Quote')
    expect(problem).toContain('Free Quote')
    expect(problem).toContain('63 characters')
  })

  it.each([
    'physio-melbourne',
    's',
    'a'.repeat(63),
    '9-lives',
    '',
    'Free Quote',
    'Free-Scan',
    '../x',
    'a/b',
    'a'.repeat(64),
    '-x',
    '.x',
    'x:y',
    'x\n',
    ' x',
  ])('agrees with resolveSite on whether %j can be published', (slug) => {
    // One table, both spellings of the same predicate: the stage tool asks
    // slugProblem and the manifest asks resolveSite. If either is edited alone,
    // some row here flips and the pair stops answering one question.
    const attempt = () => resolveSite(slug, [])
    if (slugProblem(slug) === null) expect(attempt).not.toThrow()
    else expect(attempt).toThrow(SlugProblemError)
  })
})

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
    expect(one.sha256).toBe(createHash('sha256').update('<h1>hi</h1>').digest('hex'))
  })

  it.each(['', 'Free Quote', '../x', 'a/b', 'a'.repeat(64), 'x\n', '-x', '.x', 'x:y'])(
    'refuses the slug %j before it becomes a hosted path',
    (slug) => {
      expect(() => resolveSite(slug, [file('a1', 'page_html', '<h1>hi</h1>')])).toThrow(SlugProblemError)
    },
  )

  it.each(['physio-melbourne', 's', 'a'.repeat(63), '9-lives'])(
    'publishes under the slug %j',
    (slug) => {
      expect(resolveSite(slug, [file('a1', 'page_html', '<h1>hi</h1>')]).map((f) => f.path))
        .toEqual([`${slug}/index.html`])
    },
  )

  it('says which slug it refused and what a slug may look like', () => {
    expect(() => resolveSite('Free Quote', [])).toThrow(/Free Quote/)
    expect(() => resolveSite('Free Quote', [])).toThrow(/63 characters/)
  })

  it('refuses an ambiguous slot rather than picking one of the rows', () => {
    // slotProblem answers the same question in text for the stage tool; this is the
    // throw that stops a derivation. A publisher that chose between two page_html
    // rows would publish a page the reviewer may never have seen.
    expect(() =>
      resolveSite('s', [
        file('a1', 'page_html', '<h1>old</h1>'),
        file('a2', 'page_html', '<h1>new</h1>'),
      ]),
    ).toThrow(SlotProblemError)
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

  it('moves when the same bytes sit at a different path', () => {
    const landing = resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')])[0]
    const thanks = resolveSite('s', [file('a2', 'thank_you_html', '<h1>hi</h1>')])[0]
    if (!landing || !thanks) throw new Error('resolveSite dropped a slot')
    expect(landing.path).not.toBe(thanks.path)
    expect(landing.sha256).toBe(thanks.sha256)
    expect(siteHashOf([landing])).not.toBe(siteHashOf([thanks]))
  })

  it('is 64 hex characters', () => {
    expect(siteHashOf(resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')]))).toMatch(/^[0-9a-f]{64}$/)
  })
})

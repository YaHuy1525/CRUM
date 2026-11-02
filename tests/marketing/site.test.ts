import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SlugProblemError,
  SlotProblemError,
  resolveSite,
  siteHashOf,
  siteTextOf,
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

describe('the byte lane (slice 5 R1)', () => {
  // Computed with `node -e "console.log(require('crypto').createHash('sha256').update('<h1>hi</h1>').digest('hex'))"`,
  // so this is the UTF-8 hash of the page, not the hash of whatever the code under test happens to produce.
  const INDEX_HASH = 'e7fbb6fbbf4ce294913eb62b53ff03a7546649cfdc0d824d9e3a2b4541502f7f'
  // The same recipe over a page whose bytes are not pure ASCII: node's
  // `createHash` and `printf '%s' '<h1>café</h1>' | sha256sum` both give this, so
  // the 14 bytes those 13 characters encode to are pinned, not only the 11 of
  // `<h1>hi</h1>`.
  const CAFE_HASH = 'ae1320ea2c0c99b82038a29a7e45c7a275f1f62db2a386c6698afa577125f51f'
  // `printf '%s' '<p>thanks</p>' | sha256sum`, the second page's own hash.
  const THANKS_HASH = '6b487a6b7a271ead9ca03bee630011496562c6b025ba884542fe77a19bcd5791'
  // `siteHashOf`'s canonical string for this two-page site —
  // `physio/index.html:<INDEX_HASH>\nphysio/thanks/index.html:<THANKS_HASH>`, the
  // pair order `resolveSite` sorts to — hashed in the shell with `node -e` and
  // confirmed by `sha256sum`. Nothing here calls the function under test, which
  // is the point: slice 2 pinned no two-file aggregate anywhere in the repo, so
  // this is the first value that a moved aggregate can actually break.
  const TWO_FILE_SITE_HASH = '3647921c72f4829942919f1c34c1b325d588b7a0f5f2e94d8161b095d50aaec8'

  it('hashes the same bytes a text page had before it carried a Uint8Array', () => {
    // `page`, not `file`: a local named `file` would shadow the `file()` fixture
    // helper in the very statement that calls it, a ReferenceError before
    // any assertion runs.
    const [page] = resolveSite('physio', [file('a1', 'page_html', '<h1>hi</h1>')])
    expect(page?.sha256).toBe(INDEX_HASH)
    expect(page?.contentType).toBe('text/html')
    expect(siteTextOf(page!)).toBe('<h1>hi</h1>')
    expect(page?.content).toBeInstanceOf(Uint8Array)
  })

  it('hashes the UTF-8 bytes of a page that is not pure ASCII', () => {
    const [page] = resolveSite('physio', [file('a1', 'page_html', '<h1>café</h1>')])
    expect(page?.sha256).toBe(CAFE_HASH)
    expect(siteTextOf(page!)).toBe('<h1>café</h1>')
    // The bytes are longer than the characters, so a hash taken over a
    // latin-1 or UTF-16 spelling of the same string cannot satisfy this.
    expect(page?.content).toHaveLength(14)
  })

  it('leaves a multi-file site hash unchanged across the string to bytes move', () => {
    const site = resolveSite('physio', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ])
    // The inputs the aggregate is built over, pinned before the aggregate itself:
    // if a per-file hash moves, this fails rather than the next line quietly
    // composing the expectation from the moved value.
    expect(site.map((f) => f.sha256)).toEqual([INDEX_HASH, THANKS_HASH])
    const hash = siteHashOf(site)
    // Composed here, in the same file, from the two literal hashes above and the
    // `path:sha256` pairs joined with `\n` — `siteHashOf` is not used to build
    // what it is then compared against.
    expect(hash).toBe(
      createHash('sha256')
        .update(`physio/index.html:${INDEX_HASH}\nphysio/thanks/index.html:${THANKS_HASH}`)
        .digest('hex'),
    )
    expect(hash).toBe(TWO_FILE_SITE_HASH)
  })
})

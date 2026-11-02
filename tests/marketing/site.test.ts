import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AssetProblemError,
  MAX_ASSET_BYTES,
  SlugProblemError,
  SlotProblemError,
  assetNamesReferenced,
  resolveSite,
  sha256OfText,
  siteHashOf,
  siteProblem,
  siteTextOf,
  slugProblem,
  slotProblem,
  type SiteArtifact,
  unreferencedAssetNames,
  unterminatedAssetReferences,
} from '@/marketing/site'

const file = (id: string, kind: string, text: string): SiteArtifact => ({ id, kind, textContent: text })

// Beside `file`, and the same shape of helper: an image artifact carries a
// document, a title, a mime and bytes, and only Task 4's loader can fill them
// from a row. `PNG_BYTES` is four bytes so the byte ceilings stay testable
// without a megabyte in a fixture, and the padded segment keeps the twelve
// characters a real uuid's last group has, because `documentId` is a uuid.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const asset = (
  id: string,
  title: string,
  over: Partial<SiteArtifact> = {},
): SiteArtifact => ({
  id,
  kind: 'image',
  textContent: null,
  documentId: `00000000-0000-4000-8000-${id.padEnd(12, '0')}`,
  title,
  mime: 'image/png',
  bytes: PNG_BYTES,
  ...over,
})
const page = (html: string): SiteArtifact => ({ id: 'p1', kind: 'page_html', textContent: html })

// Vitest's `toThrow` reads a function argument as an error class to match with
// `instanceof`, so a predicate cannot ride it. The caught error is returned
// here and its token asserted, which is the same claim in the form the matcher
// actually checks.
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to refuse, and it returned a file list')
}

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

describe('assetNamesReferenced', () => {
  it('reads one name', () => {
    expect(assetNamesReferenced('<img src="{{ASSET:hero}}">')).toEqual(['hero'])
  })

  it('reads the same name once, however many times the page uses it', () => {
    expect(assetNamesReferenced('{{ASSET:hero}} {{ASSET:hero}}')).toEqual(['hero'])
  })

  it('keeps two names in the order the page wrote them', () => {
    expect(assetNamesReferenced('{{ASSET:b}} then {{ASSET:a}}')).toEqual(['b', 'a'])
  })

  it('trims, because a model writes {{ASSET: hero }} as readily as {{ASSET:hero}}', () => {
    expect(assetNamesReferenced('{{ASSET:  hero  }}')).toEqual(['hero'])
  })

  it('allows a space inside a name, because asset titles are prose', () => {
    expect(assetNamesReferenced('{{ASSET:Hero image}}')).toEqual(['Hero image'])
  })

  it('reads nothing for a fragment with no closing braces', () => {
    expect(assetNamesReferenced('{{ASSET:hero')).toEqual([])
  })

  it('refuses a name containing a brace rather than half-matching it', () => {
    expect(assetNamesReferenced('{{ASSET:a{b}}')).toEqual([])
  })
})

describe('unterminatedAssetReferences', () => {
  // Split out of the name block so a failure names the function that failed, and
  // extended with the cases the corrected brief lists: the empty page, the blank
  // name, two malformed literals, the fragment-not-the-copy guarantee, the bare
  // literal at end of page, and the MAX_FRAGMENT_CHARS cut.

  it('reports nothing for a page that never uses the placeholder', () => {
    // The branch most pages take, and the cheapest guard against an off-by-one in
    // the walk: an empty page has no literal to start a fragment at.
    expect(unterminatedAssetReferences('<h1>hi</h1>')).toEqual([])
  })

  it('reports nothing for a page whose every placeholder is well formed', () => {
    // The other half of the refusal: a page that resolves must not be reported,
    // or the count in unterminatedAssetReferences fires on every well-formed
    // page and Task 3 refuses the copy that is actually fine.
    expect(unterminatedAssetReferences('<img src="{{ASSET:hero}}">{{ASSET:Hero image}}')).toEqual([])
  })

  it('reports nothing for a well-formed page that names two assets', () => {
    expect(unterminatedAssetReferences('<p>{{ASSET:hero}} and {{ASSET:map}}</p>')).toEqual([])
  })

  it('reports a fragment with no closing braces', () => {
    expect(unterminatedAssetReferences('{{ASSET:hero')).toEqual(['{{ASSET:hero'])
  })

  it('reports a bare literal at the very end of the page', () => {
    expect(unterminatedAssetReferences('{{ASSET:')).toEqual(['{{ASSET:'])
  })

  it('reports a blank name, which has no asset title to name in a refusal', () => {
    expect(unterminatedAssetReferences('{{ASSET:}}')).toEqual(['{{ASSET:}}'])
  })

  it('reports a name containing a brace rather than half-matching it', () => {
    expect(unterminatedAssetReferences('{{ASSET:a{b}}')).toHaveLength(1)
  })

  it('reports a well-formed placeholder sitting after a malformed one as one fragment', () => {
    // The first literal is malformed and its run to the next `}}` swallows the
    // following well-formed placeholder, so the page is one finding not two.
    expect(unterminatedAssetReferences('{{ASSET:a}{{ASSET:b}}')).toHaveLength(1)
  })

  it('reports each of two malformed literals', () => {
    // Two broken placeholders are two findings, not the single prefix the count
    // would have returned.
    expect(unterminatedAssetReferences('{{ASSET:a}} {{ASSET:b {{ASSET:c')).toHaveLength(2)
  })

  it('quotes the fragment and not the page around it', () => {
    const html = '<h1>Bring your back pain to the clinic</h1><p>Book now</p>{{ASSET:hero</p>'
    expect(unterminatedAssetReferences(html)).toEqual(['{{ASSET:hero</p>'])
  })

  it('cuts a runaway fragment at MAX_FRAGMENT_CHARS', () => {
    // A literal with no closing `}}` would otherwise quote the whole rest of the
    // page; the refusal quotes a phrase, so the fragment is capped, not truncated
    // to the page head.
    const fragments = unterminatedAssetReferences('{{ASSET:' + 'x'.repeat(200))
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toHaveLength(120)
  })
})

describe('resolveSite with assets', () => {
  it('publishes a referenced image at a document-id path under the slug', () => {
    const files = resolveSite('physio', [page('<img src="{{ASSET:hero}}">'), asset('i1', 'hero')])
    expect(files.map((f) => f.path)).toEqual(['physio/assets/00000000-0000-4000-8000-i10000000000.png', 'physio/index.html'])
    const image = files.find((f) => f.path.endsWith('.png'))!
    expect(image.contentType).toBe('image/png')
    expect(image.content).toEqual(PNG_BYTES)
    // The image's hash is over the uploaded bytes, and never through
    // `sha256OfText`, which is the text lane's helper.
    expect(image.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'))
  })

  it('substitutes a root-relative URL into the page before hashing it', () => {
    // Root-relative, not relative to the page: the thank-you page sits one level
    // deeper, and `assets/a.png` from there asks for a path that does not exist.
    const files = resolveSite('physio', [page('<img src="{{ASSET:hero}}">'), asset('i1', 'hero')])
    const html = files.find((f) => f.path === 'physio/index.html')!
    expect(siteTextOf(html)).toBe('<img src="/physio/assets/00000000-0000-4000-8000-i10000000000.png">')
    expect(html.sha256).toBe(sha256OfText(siteTextOf(html)))
  })

  it('does not publish or hash an image the page never names', () => {
    const withUnused = resolveSite('physio', [page('<p>text only</p>'), asset('i1', 'hero'), asset('i2', 'unused')])
    expect(withUnused.map((f) => f.path)).toEqual(['physio/index.html'])
    expect(unreferencedAssetNames([page('<p>text only</p>'), asset('i1', 'hero')])).toEqual(['hero'])
  })

  it('hashes a repeated reference once, because it is one file', () => {
    const twice = resolveSite('physio', [page('{{ASSET:hero}} {{ASSET:hero}}'), asset('i1', 'hero')])
    expect(twice.filter((f) => f.path.endsWith('.png'))).toHaveLength(1)
  })

  it('refuses a mime with no extension rather than guessing one', () => {
    expect(() => resolveSite('physio', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/gif' })]))
      .toThrow(AssetProblemError)
    expect(siteProblem([page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/gif' })])).toContain('image/gif')
  })
})

describe('siteProblem names each asset failure', () => {
  // `token`, then the `needle` the sentence must name, then the artifacts: the
  // title format prints its two `%s` slots in argument order, so the needle sits
  // where the title can read it.
  const cases: Array<[string, string, SiteArtifact[]]> = [
    ['asset_name_missing', 'hero', [page('{{ASSET:hero}}')]],
    ['asset_name_ambiguous', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero'), asset('i2', 'hero')]],
    ['asset_mime_unsupported', 'image/tiff', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/tiff' })]],
    ['asset_bytes_missing', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: null })]],
    ['asset_bytes_missing', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(0) })]],
    ['asset_too_large', '8388608', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(MAX_ASSET_BYTES + 1) })]],
    ['asset_unresolved', '{{ASSET:hero', [page('{{ASSET:hero')]],
  ]

  it.each(cases)('%s is refused in a sentence naming %s', (token, needle, artifacts) => {
    const problem = siteProblem(artifacts)
    expect(problem).not.toBeNull()
    expect(problem).toContain(needle)
    // One predicate, two spellings: whatever siteProblem can say, resolveSite
    // refuses with the same token rather than publishing something else.
    const refusal = thrownBy(() => resolveSite('physio', artifacts))
    expect(refusal).toBeInstanceOf(AssetProblemError)
    expect((refusal as AssetProblemError).token).toBe(token)
  })

  it('counts one asset over the ceiling by itself, and twelve of them too', () => {
    const twelve = Array.from({ length: 13 }, (_unused, i) => asset(`i${i}`, `a${i}`))
    const names = twelve.map((a) => `{{ASSET:${a.title}}}`).join(' ')
    expect(siteProblem([page(names), ...twelve])).toContain('12')
  })

  it('adds the page and its pictures together when it checks the site ceiling', () => {
    // Three pictures over one shared buffer, each at exactly the per-image
    // ceiling, so the pictures alone sit at the 24 MiB site ceiling to the byte and
    // only the page's own bytes can tip it over. Two pictures never could: the
    // per-image ceiling caps a pair at 16 MiB, well under a 24 MiB site.
    const big = new Uint8Array(MAX_ASSET_BYTES)
    const artifacts = [
      page('{{ASSET:a}} {{ASSET:b}} {{ASSET:c}}'),
      asset('i1', 'a', { bytes: big }),
      asset('i2', 'b', { bytes: big }),
      asset('i3', 'c', { bytes: big }),
    ]
    expect(siteProblem(artifacts)).toContain('asset_too_large')
  })

  it('is null for a page with no placeholders and for a bundle with no page', () => {
    expect(siteProblem([page('<h1>hi</h1>')])).toBeNull()
    expect(siteProblem([asset('i1', 'hero')])).toBeNull()
  })

  it('still says what slotProblem says about two pages in one slot', () => {
    const two = [file('a1', 'page_html', '<h1>old</h1>'), file('a2', 'page_html', '<h1>new</h1>')]
    expect(siteProblem(two)).toBe(slotProblem(two))
  })
})

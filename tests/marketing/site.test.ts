import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AssetProblemError,
  MAX_ASSET_BYTES,
  MAX_SITE_BYTES,
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
  type AssetProblemToken,
  type SiteArtifact,
  unreferencedAssetNames,
  unterminatedAssetReferences,
} from '@/marketing/site'

const file = (id: string, kind: string, text: string): SiteArtifact => ({ id, kind, textContent: text })

// Beside `file`, and the same shape of helper: an image artifact carries a
// document, a title, a mime and bytes, and only Task 4's loader can fill them
// from a row. The bytes are the PNG signature followed by the fixture's own id, so
// every artifact in a case holds a buffer no other artifact holds: one shared
// four-byte buffer cannot say *which* picture's bytes were published, and swapping
// two of them in the publish loop would satisfy it. They stay a handful of
// bytes so the byte ceilings remain testable without a megabyte in a fixture, and
// the padded segment keeps the twelve characters a real uuid's last group has,
// because `documentId` is a uuid.
const pngBytes = (id: string): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from(id, (character) => character.charCodeAt(0))])
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
  bytes: pngBytes(id),
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
    // `pngBytes('i1')`, not a shared fixture buffer: this asserts that the bytes
    // published at the `i1` path are the `i1` artifact's own.
    expect(image.content).toEqual(pngBytes('i1'))
    // The image's hash is over the uploaded bytes, and never through
    // `sha256OfText`, which is the text lane's helper.
    expect(image.sha256).toBe(createHash('sha256').update(pngBytes('i1')).digest('hex'))
  })

  it('publishes each picture with its own bytes and its own hash', () => {
    // Two pictures, each holding bytes the other does not. With one shared fixture
    // buffer they were interchangeable, so a publish loop that wrote one artifact's
    // bytes to every path could not be caught from the outside.
    const files = resolveSite('physio', [page('{{ASSET:hero}} {{ASSET:map}}'), asset('i1', 'hero'), asset('i2', 'map')])
    const hero = files.find((f) => f.path.endsWith('-i10000000000.png'))!
    const map = files.find((f) => f.path.endsWith('-i20000000000.png'))!
    expect(hero.content).toEqual(pngBytes('i1'))
    expect(map.content).toEqual(pngBytes('i2'))
    expect(hero.sha256).toBe(createHash('sha256').update(pngBytes('i1')).digest('hex'))
    expect(map.sha256).toBe(createHash('sha256').update(pngBytes('i2')).digest('hex'))
  })

  it('gives the page a URL that is the published path with its slash put back', () => {
    // `assetPathOf` is the only spelling of a hosted path, and `SiteFile.path` is
    // the same string without its leading slash, so the URL the approval hashed
    // cannot name a file the publisher does not upload.
    const files = resolveSite('physio', [page('<img src="{{ASSET:hero}}">'), asset('i1', 'hero')])
    const image = files.find((f) => f.path.endsWith('.png'))!
    const html = files.find((f) => f.path === 'physio/index.html')!
    expect(siteTextOf(html)).toBe(`<img src="/${image.path}">`)
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

  it('names an unreferenced title once, because Task 6 prints one line per picture', () => {
    // Two unused images sharing a title are one picture to the owner reading a
    // stage report, the same way `referencedNames` dedupes a placeholder the page
    // wrote three times.
    const artifacts = [page('<p>text only</p>'), asset('i1', 'hero'), asset('i2', 'hero'), asset('i3', 'map')]
    expect(unreferencedAssetNames(artifacts)).toEqual(['hero', 'map'])
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
  // where the title can read it. The token is `AssetProblemToken` and not `string`,
  // so a lane that stops existing is a compile error in this table rather than a row
  // comparing an error against a word nothing throws any more.
  const cases: Array<[AssetProblemToken, string, SiteArtifact[]]> = [
    ['asset_name_missing', 'hero', [page('{{ASSET:hero}}')]],
    ['asset_name_ambiguous', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero'), asset('i2', 'hero')]],
    ['asset_mime_unsupported', 'image/tiff', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/tiff' })]],
    ['asset_bytes_missing', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: null })]],
    ['asset_bytes_missing', 'hero', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(0) })]],
    ['asset_too_large', '8388608', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(MAX_ASSET_BYTES + 1) })]],
    ['asset_unresolved', '{{ASSET:hero', [page('{{ASSET:hero')]],
    // `ASSET_REFERENCE` matches `{{ASSET: }}` and `assetNamesReferenced` drops the
    // blank capture, so the name lanes never see a placeholder substitution does meet.
    // The second row is the divergence in its worst shape: a bundle holding the one
    // picture the page asked for, waved through by the predicate and refused by the
    // throw.
    ['asset_unresolved', '"{{ASSET: }}"', [page('<img src="{{ASSET: }}">')]],
    ['asset_unresolved', '"{{ASSET:  }}"', [page('{{ASSET:hero}} {{ASSET:  }}'), asset('i1', 'hero')]],
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

  it('names the ids behind an ambiguous title, which is the half an owner can act on', () => {
    const problem = siteProblem([page('{{ASSET:hero}}'), asset('i1', 'hero'), asset('i7', 'hero')])
    expect(problem).toContain('(i1, i7)')
  })

  it('counts the images it found rather than asserting there are two', () => {
    // The guard is `matches.length > 1`, so three pictures answering one placeholder
    // are a bundle that exists. A sentence saying "two" would send the owner to
    // delete a picture that is not the mistake.
    const three = [page('{{ASSET:hero}}'), asset('i1', 'hero'), asset('i2', 'hero'), asset('i3', 'hero')]
    const problem = siteProblem(three)
    expect(problem).toContain('3 images in this bundle are titled "hero" (i1, i2, i3)')
    expect(problem).not.toContain('two images')
  })

  it('names no ceiling where no ceiling was checked', () => {
    // `ceiling` is the discriminator for the three lanes that share
    // `asset_too_large`. A name or mime refusal checked no ceiling, and a consumer
    // branching on the field must read nothing there rather than a guess.
    const mime = thrownBy(() =>
      resolveSite('physio', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/tiff' })]),
    ) as AssetProblemError
    expect(mime.token).toBe('asset_mime_unsupported')
    expect(mime.ceiling).toBeUndefined()
    const missing = thrownBy(() => resolveSite('physio', [page('{{ASSET:hero}}')])) as AssetProblemError
    expect(missing.token).toBe('asset_name_missing')
    expect(missing.ceiling).toBeUndefined()
  })

  it('counts one asset over the ceiling by itself, and twelve of them too', () => {
    // Both halves the title promises, because all three byte lanes refuse with one
    // token and a consumer has to tell them apart: one picture over
    // `MAX_ASSET_BYTES` alone is "shrink this", and thirteen referenced pictures
    // under it are "use fewer". Twelve publish; the thirteenth is the one refused.
    const one = thrownBy(() =>
      resolveSite('physio', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(MAX_ASSET_BYTES + 1) })]),
    ) as AssetProblemError
    expect(one.token).toBe('asset_too_large')
    expect(one.ceiling).toBe('image')
    expect(one.detail).toContain(`${MAX_ASSET_BYTES + 1} bytes and CRUM publishes nothing over ${MAX_ASSET_BYTES}`)

    const thirteen = Array.from({ length: 13 }, (_unused, i) => asset(`i${i}`, `a${i}`))
    const names = thirteen.map((a) => `{{ASSET:${a.title}}}`).join(' ')
    const tooMany = thrownBy(() => resolveSite('physio', [page(names), ...thirteen])) as AssetProblemError
    expect(tooMany.token).toBe('asset_too_large')
    expect(tooMany.ceiling).toBe('count')
    expect(siteProblem([page(names), ...thirteen])).toContain('12')
  })

  it('adds the page and its pictures together when it checks the site ceiling', () => {
    // Three pictures over one shared buffer, each at exactly the per-image
    // ceiling, so the pictures alone sit at the 24 MiB site ceiling to the byte and
    // only the page's own bytes can tip it over. Two pictures never could: the
    // per-image ceiling caps a pair at 16 MiB, well under a 24 MiB site.
    const big = new Uint8Array(MAX_ASSET_BYTES)
    const html = '{{ASSET:a}} {{ASSET:b}} {{ASSET:c}}'
    const artifacts = [
      page(html),
      asset('i1', 'a', { bytes: big }),
      asset('i2', 'b', { bytes: big }),
      asset('i3', 'c', { bytes: big }),
    ]
    const problem = siteProblem(artifacts)
    expect(problem).toContain('asset_too_large')
    // The sentence states the size and the bound, and never calls the size an
    // excess: Task 6 prints it verbatim to an owner deciding how much creative to
    // re-cut, and "25165859 bytes over a 25165824 ceiling" says the bundle is that
    // many bytes too big when it is 35 bytes too big.
    const total = 3 * MAX_ASSET_BYTES + Buffer.byteLength(html, 'utf8')
    expect(problem).toContain(`${total} bytes and CRUM publishes nothing over ${MAX_SITE_BYTES}`)
    expect(problem).not.toContain('over a')
    expect((thrownBy(() => resolveSite('physio', artifacts)) as AssetProblemError).ceiling).toBe('site')
  })

  it('counts a page in UTF-8 bytes, because the ceiling it quotes is in bytes', () => {
    // Three pictures 40 bytes short of the site ceiling and a page of 38 characters
    // that is 41 UTF-8 bytes: the byte measure lands one over the ceiling and a
    // count of UTF-16 code units lands two under it, so accented copy could
    // publish a site over the bound its own refusal names. The three pictures are
    // views over one buffer, so the case pays 8 MiB rather than 24.
    const big = new Uint8Array(MAX_ASSET_BYTES)
    const html = '{{ASSET:a}} {{ASSET:b}} {{ASSET:c}}ééé'
    expect(html.length).toBe(38)
    expect(Buffer.byteLength(html, 'utf8')).toBe(41)
    const artifacts = [
      page(html),
      asset('i1', 'a', { bytes: big }),
      asset('i2', 'b', { bytes: big }),
      asset('i3', 'c', { bytes: big.subarray(0, MAX_ASSET_BYTES - 40) }),
    ]
    expect(siteProblem(artifacts)).toContain(
      `${MAX_SITE_BYTES + 1} bytes and CRUM publishes nothing over ${MAX_SITE_BYTES}`,
    )
    expect((thrownBy(() => resolveSite('physio', artifacts)) as AssetProblemError).ceiling).toBe('site')
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

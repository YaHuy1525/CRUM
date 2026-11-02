// tests/marketing/pixel-injection.test.ts
// Covers spec section 6: the pixel snippet lands before </head> when present,
// before </body> when </head> is absent, is prepended when neither tag exists,
// is skipped with a warning when the pixel ID is not configured, is applied to
// every HTML file in a multi-file site, and leaves non-HTML files untouched.

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  buildPixelSnippet,
  injectPixel,
  injectPixelIntoFiles,
} from '@/marketing/pixel-injection'
import { siteTextOf, type SiteFile } from '@/marketing/site'

const PIXEL_ID = '1234567890'

function makeFile(path: string, content: string): SiteFile {
  return { path, content: new TextEncoder().encode(content), contentType: 'text/html', sha256: 'unused' }
}

describe('buildPixelSnippet', () => {
  it('substitutes the pixel ID into both the init call and the noscript src', () => {
    const snippet = buildPixelSnippet(PIXEL_ID)
    expect(snippet).toContain(`fbq('init', '${PIXEL_ID}')`)
    expect(snippet).toContain(`id=${PIXEL_ID}&ev=PageView`)
    expect(snippet).not.toContain('{{PIXEL_ID}}')
  })
})

describe('injectPixel', () => {
  it('injects before </head> when the tag is present', () => {
    const html = '<html><head><title>t</title></head><body>hi</body></html>'
    const result = injectPixel(html, PIXEL_ID)
    const snippet = buildPixelSnippet(PIXEL_ID)
    expect(result).toContain(snippet + '\n</head>')
    expect(result.indexOf(snippet)).toBeLessThan(result.indexOf('</head>'))
  })

  it('injects before </body> when </head> is absent', () => {
    const html = '<html><body><p>hi</p></body></html>'
    const result = injectPixel(html, PIXEL_ID)
    const snippet = buildPixelSnippet(PIXEL_ID)
    expect(result).toContain(snippet + '\n</body>')
    expect(result.indexOf(snippet)).toBeLessThan(result.indexOf('</body>'))
  })

  it('prepends when neither </head> nor </body> is present', () => {
    const html = '<p>just a fragment</p>'
    const result = injectPixel(html, PIXEL_ID)
    const snippet = buildPixelSnippet(PIXEL_ID)
    expect(result.startsWith(snippet)).toBe(true)
    expect(result).toContain('\n<p>just a fragment</p>')
  })

  it('matches </head> case-insensitively', () => {
    const html = '<html><HEAD><title>t</title></HEAD><body>hi</body></html>'
    const result = injectPixel(html, PIXEL_ID)
    expect(result).toContain('</HEAD>')
    const snippet = buildPixelSnippet(PIXEL_ID)
    expect(result.indexOf(snippet)).toBeLessThan(result.indexOf('</HEAD>'))
  })
})

describe('injectPixelIntoFiles', () => {
  it('injects into all HTML files in a site', () => {
    const files: SiteFile[] = [
      makeFile('physio/index.html', '<html><head></head><body>main</body></html>'),
      makeFile('physio/thanks/index.html', '<html><head></head><body>thanks</body></html>'),
    ]
    const { files: result, injected } = injectPixelIntoFiles(files, PIXEL_ID)
    expect(injected).toBe(true)
    expect(result).toHaveLength(2)
    for (const f of result) {
      expect(siteTextOf(f)).toContain(buildPixelSnippet(PIXEL_ID))
    }
  })

  it('skips non-HTML files', () => {
    const files: SiteFile[] = [
      makeFile('physio/index.html', '<html><head></head><body>hi</body></html>'),
      makeFile('physio/style.css', 'body { color: red }'),
      makeFile('physio/script.js', 'console.log("hi")'),
    ]
    const { files: result } = injectPixelIntoFiles(files, PIXEL_ID)
    const css = result.find((f) => f.path.endsWith('.css'))!
    const js = result.find((f) => f.path.endsWith('.js'))!
    expect(siteTextOf(css)).toBe('body { color: red }')
    expect(siteTextOf(js)).toBe('console.log("hi")')
  })

  it('skips injection and logs a warning when pixel ID is undefined', () => {
    const warn = vi.fn()
    const files: SiteFile[] = [
      makeFile('physio/index.html', '<html><head></head><body>hi</body></html>'),
    ]
    const { files: result, injected } = injectPixelIntoFiles(files, undefined, { warn })
    expect(injected).toBe(false)
    expect(result[0]!.content).toBe(files[0]!.content)
    expect(warn).toHaveBeenCalledWith(
      'Meta pixel ID not configured; page published without tracking',
    )
  })

  it('skips injection and logs a warning when pixel ID is blank', () => {
    const warn = vi.fn()
    const files: SiteFile[] = [
      makeFile('physio/index.html', '<html><head></head><body>hi</body></html>'),
    ]
    const { injected } = injectPixelIntoFiles(files, '   ', { warn })
    expect(injected).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('returns new file objects rather than mutating the originals', () => {
    const original = makeFile('physio/index.html', '<html><head></head><body>hi</body></html>')
    const files: SiteFile[] = [original]
    const { files: result } = injectPixelIntoFiles(files, PIXEL_ID)
    expect(result[0]).not.toBe(original)
    expect(siteTextOf(original)).not.toContain(buildPixelSnippet(PIXEL_ID))
  })
})

describe('the hash after injection', () => {
  it('describes the bytes that were injected, not the bytes that were approved', () => {
    const [one] = injectPixelIntoFiles([makeFile('physio/index.html', '<html><head></head></html>')], PIXEL_ID).files
    const file = one!
    expect(file.sha256).toBe(createHash('sha256').update(siteTextOf(file)).digest('hex'))
    expect(file.sha256).not.toBe(makeFile('physio/index.html', '<html><head></head></html>').sha256)
  })

  it('leaves a non-html file byte-identical', () => {
    const png = { path: 'physio/assets/a.png', sha256: 'deadbeef', contentType: 'image/png', content: new Uint8Array([1, 2, 3]) }
    const result = injectPixelIntoFiles([png], PIXEL_ID)
    expect(result.files[0]).toEqual(png)
  })
})

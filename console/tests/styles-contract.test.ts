import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'


const CONSOLE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const APP = path.join(CONSOLE_ROOT, 'app')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full)
  }
  return out
}

const theme = readFileSync(path.join(APP, 'theme.css'), 'utf8')
const tailwind = readFileSync(path.join(APP, 'tailwind.css'), 'utf8')
const layout = readFileSync(path.join(APP, 'layout.tsx'), 'utf8')

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const TOKEN_REFERENCE = /var\(--([a-zA-Z0-9-]+)\)/g

function referencedTokens(files: string[]): string[] {
  const out = new Set<string>()
  for (const file of files) {
    for (const match of stripComments(readFileSync(file, 'utf8')).matchAll(TOKEN_REFERENCE)) {
      out.add(match[1])
    }
  }
  return [...out]
}

function consoleSources(dirs: string[]): string[] {
  return dirs.flatMap((dir) => sourceFiles(path.join(CONSOLE_ROOT, dir)))
}

describe('legacy global stylesheet', () => {
  it('is gone from disk', () => {
    expect(existsSync(path.join(APP, 'globals.css'))).toBe(false)
  })

  it('has no surviving importer anywhere in the console', () => {
    const importers = sourceFiles(CONSOLE_ROOT).filter((file) =>
      /import\s+['"][^'"]*globals\.css['"]/.test(readFileSync(file, 'utf8')),
    )
    expect(importers).toEqual([])
  })

  it('leaves the shell importing the token layer before the utility layer', () => {
    const order = layout.match(/import '\.\/(theme|tailwind)\.css'/g) ?? []
    expect(order).toEqual(["import './theme.css'", "import './tailwind.css'"])
  })
})

describe('element defaults', () => {
  it('live inside @layer base so utilities win the cascade', () => {
    const code = stripComments(tailwind)
    const base = code.slice(code.indexOf('@layer base'))
    expect(code).toMatch(/@layer base\s*\{/)
    for (const selector of ['body', 'h1, h2, h3, h4', 'a', 'a:hover', 'button', 'ul, ol', 'p']) {
      expect(base).toContain(`${selector}`)
    }
    expect(code.slice(0, code.indexOf('@layer base'))).not.toMatch(
      /^\s*(body|h1|a|p|ul|button)\s*\{/m,
    )
  })

  it('keep the paragraph and heading margins the console has always rendered with', () => {
    expect(tailwind).toMatch(/p\s*\{\s*margin:\s*0 0 var\(--space-3\);?\s*\}/)
    expect(tailwind).toMatch(/margin:\s*0 0 var\(--space-2\);?\s*\}/)
  })
})

describe('theme tokens', () => {
  const DECLARED_BY_NEXT_FONT = ['font-inter', 'font-source-serif', 'font-jetbrains-mono']

  it('declare every custom property the utility layer and the components reference', () => {
    const referenced = referencedTokens(consoleSources(['app', 'components', 'lib']))
    const declared = new Set([...theme.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))
    const missing = [...new Set(referenced)].filter(
      (name) => !declared.has(name) && !DECLARED_BY_NEXT_FONT.includes(name),
    )
    expect(missing).toEqual([])
    expect(referenced.length).toBeGreaterThan(40)
    for (const name of DECLARED_BY_NEXT_FONT) {
      expect(layout).toContain(`variable: '--${name}'`)
    }
  })

  it('serve the three families from the console itself rather than a font CDN', () => {
    expect(layout).toMatch(/from 'next\/font\/google'/)
    expect(layout).not.toContain('fonts.googleapis.com')
    const offenders = consoleSources(['app', 'components', 'lib']).filter((file) =>
      /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('no longer carry the shell dimensions the redesign removed', () => {
    for (const dead of ['--header-h', '--pane-sessions-w', '--pane-context-w']) {
      expect(theme).not.toContain(dead)
    }
    expect(theme).toContain('--sidebar-w')
  })

  it('defines the focus ring exactly once, and outside every layer', () => {
    expect((theme.match(/\.focus-ring:focus-visible/g) ?? []).length).toBe(1)
    const rule = theme.match(/\.focus-ring\s*\{([^}]*)\}/)
    expect(rule?.[1]).toContain('transition-property')
    expect(rule?.[1]).not.toContain('outline-color')
  })
})

describe('reduced motion', () => {
  it('pins duration, iteration count, transition, and scroll behaviour', () => {
    const block = theme.slice(theme.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/)
    expect(block).toMatch(/transition-duration:\s*0\.001ms\s*!important/)
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/)
  })

  it('keeps the two documented durations as the only motion scale', () => {
    expect(theme).toMatch(/--dur-fast:\s*120ms/)
    expect(theme).toMatch(/--dur:\s*180ms/)
  })
})

describe('responsive contract', () => {
  it('registers the nav breakpoint the shell collapse depends on', () => {
    expect(tailwind).toMatch(/--breakpoint-nav:\s*900px/)
    expect(layout).toContain('max-nav:')
  })

  it('gives every page column the same gutter step down to narrow screens', () => {
    const deferred = ['knowledge']
    const columns = sourceFiles(path.join(CONSOLE_ROOT, 'app')).filter(
      (file) =>
        /(page|loading|error|not-found)\.tsx$/.test(file) &&
        !deferred.some((name) => file.includes(`${path.sep}${name}${path.sep}`)),
    )
    expect(columns.length).toBeGreaterThan(6)
    for (const file of columns) {
      const src = stripComments(readFileSync(file, 'utf8'))
      if (!/mx-auto w-full max-w-/.test(src)) continue
      expect(src, `${path.basename(file)} must shrink its gutter under md`).toMatch(
        /mx-auto w-full max-w-[^\s"]* px-4 py-\d+ md:px-8/,
      )
    }
  })

  it('wraps every table in its own horizontal scroller', () => {
    for (const file of sourceFiles(path.join(CONSOLE_ROOT, 'components'))) {
      const src = readFileSync(file, 'utf8')
      if (!/<table/.test(src)) continue
      expect(src, `${path.basename(file)} needs an overflow-x-auto wrapper`).toContain(
        'overflow-x-auto',
      )
    }
  })
})

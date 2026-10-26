import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * `usePathname` reads from the App Router context, which is not mounted in a bare
 * `render()` — Next throws "invariant expected app router to be mounted" without
 * it. So the router surface the shell depends on is mocked here: a mutable
 * pathname holder (via `vi.hoisted` so it exists before the component module is
 * imported) and `next/link` reduced to a plain anchor that still carries `href`,
 * `aria-current`, and `className`, which is all the shell asserts on.
 */
const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/' } }))

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

/**
 * `next/font/google` is a build-time loader: outside Next's compiler the exported
 * factories are stubs that do not return a font object, and the shell throws on
 * import. What the shell tests actually care about is that the loader's variable
 * name ends up on the `<html>` element, so the stub hands back the shape the real
 * loader would, and `styles-contract.test.ts` asserts the variable names themselves
 * against the source of `layout.tsx`.
 */
vi.mock('next/font/google', () => {
  const font = (name: string) => () => ({ variable: `__${name}_variable`, className: name })
  return {
    Inter: font('inter'),
    Source_Serif_4: font('source-serif'),
    JetBrains_Mono: font('jetbrains-mono'),
  }
})

import { SidebarNav, type SidebarIdentity } from '@/components/SidebarNav'
import { PageHeader } from '@/components/PageHeader'
import { Providers } from '@/components/providers'
import RootLayout from '@/app/layout'

const DEV_IDENTITY: SidebarIdentity = {
  mode: 'dev',
  userId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
}

beforeEach(() => {
  pathnameRef.current = '/'
})

describe('SidebarNav', () => {
  it('renders the two group labels', () => {
    render(<SidebarNav identity={DEV_IDENTITY} />)
    expect(screen.getByText('Pages')).toBeInTheDocument()
    expect(screen.getByText('Chats')).toBeInTheDocument()
  })

  it('links every Pages entry to its route', () => {
    render(<SidebarNav identity={DEV_IDENTITY} />)

    // The link accessible names are unique across both groups (the lucide icons
    // are aria-hidden), so they can be queried directly against the screen.
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: /governance/i })).toHaveAttribute('href', '/governance')
    expect(screen.getByRole('link', { name: /knowledge/i })).toHaveAttribute('href', '/knowledge')
    expect(screen.getByRole('link', { name: /records/i })).toHaveAttribute('href', '/records')
  })

  it('points New chat at /chats/new and All conversations at /chats', () => {
    render(<SidebarNav identity={DEV_IDENTITY} />)
    expect(screen.getByRole('link', { name: /new chat/i })).toHaveAttribute('href', '/chats/new')
    expect(screen.getByRole('link', { name: /all conversations/i })).toHaveAttribute(
      'href',
      '/chats',
    )
  })

  it('marks the active path with aria-current="page"', () => {
    pathnameRef.current = '/governance'
    render(<SidebarNav identity={DEV_IDENTITY} />)

    const governance = screen.getByRole('link', { name: /governance/i })
    const home = screen.getByRole('link', { name: /home/i })

    expect(governance).toHaveAttribute('aria-current', 'page')
    expect(home).not.toHaveAttribute('aria-current')
  })

  it('marks an active chat route with aria-current="page"', () => {
    pathnameRef.current = '/chats'
    render(<SidebarNav identity={DEV_IDENTITY} />)
    expect(screen.getByRole('link', { name: /all conversations/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('shows the real dev ids in the footer, never a fabricated name', () => {
    render(<SidebarNav identity={DEV_IDENTITY} />)
    const footer = screen.getByTestId('sidebar-identity')
    expect(footer).toHaveTextContent('Dev identity')
    // The ids are truncated but present, and sourced from the injected env.
    expect(footer).toHaveTextContent('00000000…')
  })

  it('falls back to a generic workspace label when not in dev mode', () => {
    render(<SidebarNav identity={{ mode: 'jwt' }} />)
    const footer = screen.getByTestId('sidebar-identity')
    expect(footer).toHaveTextContent('Signed-in workspace')
    expect(footer).not.toHaveTextContent('Dev identity')
  })
})

describe('PageHeader', () => {
  it('renders the title, description, and actions slot', () => {
    render(
      <PageHeader
        title="Conversations"
        description="Your saved conversations."
        actions={<button type="button">New chat</button>}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeInTheDocument()
    expect(screen.getByText('Your saved conversations.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
  })

  it('omits the description and actions when not provided', () => {
    const { container } = render(<PageHeader title="Records" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Records' })).toBeInTheDocument()
    expect(container.querySelector('p')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Providers', () => {
  it('renders its children', () => {
    render(
      <Providers>
        <div data-testid="child">shell content</div>
      </Providers>,
    )
    expect(screen.getByTestId('child')).toHaveTextContent('shell content')
  })
})

/**
 * The root layout is a server component whose whole job is markup: landmarks, the
 * skip link, and the two stylesheet imports in the right order. Rendering it into
 * jsdom would put an `<html>` element inside a test container, so the contract is
 * read off the static markup instead — the same bytes the browser gets.
 */
describe('RootLayout shell', () => {
  function shell(): Document {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>page body</div>
      </RootLayout>,
    )
    return new DOMParser().parseFromString(markup, 'text/html')
  }

  it('puts a skip link in front of the navigation and gives it a real target', () => {
    const doc = shell()
    const skip = doc.querySelector('a[href="#app-main"]')
    expect(skip?.textContent).toBe('Skip to content')
    expect(doc.querySelector('#app-main')?.textContent).toBe('page body')
    // An anchor target without tabindex="-1" only scrolls; focus would stay on
    // <body> and the next Tab would walk the rail all over again.
    expect(doc.querySelector('#app-main')?.getAttribute('tabindex')).toBe('-1')

    // Tab order is DOM order: the link is the first anchor in the document, so the
    // first Tab press from the address bar lands on it rather than on the brand.
    const firstLink = doc.querySelectorAll('a')[0]
    expect(firstLink?.getAttribute('href')).toBe('#app-main')
  })

  it('labels the one navigation landmark and hides the decorative brand glyph', () => {
    const doc = shell()
    expect(doc.querySelector('nav')?.getAttribute('aria-label')).toBe('Main navigation')
    expect(doc.querySelector('[aria-hidden="true"]')?.textContent).toBe('C')
  })

  it('collapses the rail below the nav breakpoint instead of a media query', () => {
    const doc = shell()
    const nav = doc.querySelector('nav')
    expect(nav?.getAttribute('class')).toContain('w-[var(--sidebar-w)]')
    expect(nav?.getAttribute('class')).toContain('max-nav:flex-row')
    expect(doc.querySelector('#app-main')?.getAttribute('class')).toContain(
      'max-nav:overflow-visible',
    )
  })

  it('hangs the three self-hosted font variables off the root element', () => {
    const doc = shell()
    const classes = doc.documentElement.getAttribute('class') ?? ''
    // theme.css opens every font stack with one of these; if the shell stopped
    // mounting them the console would silently fall back to system faces.
    for (const name of ['__inter_variable', '__source-serif_variable', '__jetbrains-mono_variable']) {
      expect(classes).toContain(name)
    }
    expect(doc.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull()
  })
})

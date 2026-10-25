import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

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

import { SidebarNav, type SidebarIdentity } from '@/components/SidebarNav'
import { PageHeader } from '@/components/PageHeader'
import { Providers } from '@/components/providers'

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

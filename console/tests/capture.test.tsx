import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

/**
 * `/records/new` is the Capture flow. §"Route map": "Paste text, parser previews
 * fields honestly, hand off to a new chat prefilled with them. Never creates rows
 * silently."
 *
 * The three facts this file pins down:
 *
 * 1. The only write it makes is the parse — `POST /api/crm/prefill/:type`. There
 *    is no create call to find, because the page does not hold one.
 * 2. `usedFallbackValue` is surfaced. A blank field map presented as "parsed" is
 *    the lie the flag exists to prevent.
 * 3. The hand-off is a link to `/chats/new?prompt=…`, carrying the operator's own
 *    words and (only when the parse was real) the parsed fields. It never mints a
 *    thread on its own.
 */
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

import NewRecordPage from '@/app/records/new/page'
import { route, stubFetch, type FetchStub } from './fetchStub'

let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function sourceText(): HTMLTextAreaElement {
  return screen.getByLabelText('Source text') as HTMLTextAreaElement
}

async function parse(text: string) {
  fireEvent.change(sourceText(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Parse fields' }))
}

describe('/records/new', () => {
  it('previews the parsed fields and hands them to a new chat', async () => {
    server = stubFetch([
      route('/api/crm/prefill/', {
        status: 200,
        body: {
          objectType: 'customer',
          data: { name: 'Maria Chen', company: 'Nordwind GmbH' },
          usedFallbackValue: false,
        },
      }),
    ])
    render(<NewRecordPage />)

    await parse('Maria Chen at Nordwind GmbH')

    expect(await screen.findByText('Maria Chen')).toBeInTheDocument()
    expect(screen.getByText('Nordwind GmbH')).toBeInTheDocument()
    expect(screen.getByText('Parsed from the text above.')).toBeInTheDocument()

    const handoff = screen.getByRole('link', { name: /Continue in chat/ })
    const href = handoff.getAttribute('href') ?? ''
    expect(href.startsWith('/chats/new?prompt=')).toBe(true)

    const prompt = decodeURIComponent(href.slice('/chats/new?prompt='.length))
    expect(prompt).toContain('Create a customer from this note:')
    expect(prompt).toContain('Maria Chen at Nordwind GmbH')
    expect(prompt).toContain('- name: Maria Chen')
    expect(prompt).toContain('- company: Nordwind GmbH')

    // The parse is the only write; creating the row stays in the governed path.
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]!.method).toBe('POST')
    expect(server.calls[0]!.url).toBe('/api/crm/prefill/customer')
  })

  it('names blank fallbacks instead of passing them off as a parse', async () => {
    server = stubFetch([
      route('/api/crm/prefill/', {
        status: 200,
        body: {
          objectType: 'customer',
          data: { name: '' },
          usedFallbackValue: true,
          error: 'invalid_json',
        },
      }),
    ])
    render(<NewRecordPage />)

    await parse('Maria Chen at Nordwind GmbH')

    expect(await screen.findByText(/blank fallbacks/)).toBeInTheDocument()
    expect(screen.getByText(/invalid_json/)).toBeInTheDocument()

    const href = screen.getByRole('link', { name: /Continue in chat/ }).getAttribute('href') ?? ''
    const prompt = decodeURIComponent(href.slice('/chats/new?prompt='.length))
    // Blank fields are not handed over as if the model had read them; the chat gets
    // the operator's own words and nothing invented.
    expect(prompt).toContain('Maria Chen at Nordwind GmbH')
    expect(prompt).not.toContain('Parsed fields:')
  })

  it('relays a failed parse as an alert with no hand-off', async () => {
    server = stubFetch([
      route('/api/crm/prefill/', { status: 503, body: { error: 'prefill-not-wired', detail: 'parser offline' } }),
    ])
    render(<NewRecordPage />)

    await parse('Maria Chen at Nordwind GmbH')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('parser offline')
    expect(screen.queryByRole('link', { name: /Continue in chat/ })).toBeNull()
  })

  it('cannot parse an empty note', () => {
    render(<NewRecordPage />)
    expect(screen.getByRole('button', { name: 'Parse fields' })).toBeDisabled()
  })
})

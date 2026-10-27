import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MailPage from '../app/mail/page'
import { route, stubFetch, type FetchStub, type Rule } from './fetchStub'


let server: FetchStub

const NOT_CONNECTED = { configured: true, connected: false }
const CONNECTED = { configured: true, connected: true, email: 'me@gmail.example', scopes: 'gmail.readonly gmail.compose' }

function mountWith(rules: Rule[]) {
  server = stubFetch(rules)
  return render(<MailPage />)
}

beforeEach(() => {
  vi.stubGlobal('open', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MailPage connection states', () => {
  it('offers Connect when configured but nobody has consented', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/mail/status', { status: 200, body: NOT_CONNECTED }, 'GET'),
      route(
        '/api/mail/connect-url',
        { status: 200, body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=signed', redirectUri: 'http://localhost:4111/gmail/callback' } },
        'GET',
      ),
    ])

    expect(await screen.findByText('No mailbox linked')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect Gmail' }))

    await vi.waitFor(() => expect(server.last('/api/mail/connect-url')).toBeDefined())
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=signed',
      '_blank',
      'noopener',
    )
  })

  it('says what is missing when the connector itself is unconfigured', async () => {
    mountWith([
      route('/api/mail/status', { status: 200, body: { configured: false, connected: false, detail: 'Set GMAIL_OAUTH_CLIENT_ID / SECRET.' } }, 'GET'),
    ])
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument()
  })

  it('shows the plane failure verbatim rather than an empty inbox', async () => {
    mountWith([route('/api/mail/status', { status: 401, body: { error: 'unauthorized', reason: 'missing-claim' } }, 'GET')])
    expect(await screen.findByRole('alert')).toHaveTextContent(/unauthorized/)
  })
})

describe('MailPage search', () => {
  const connectedRules = (): Rule[] => [
    route('/api/mail/status', { status: 200, body: CONNECTED }, 'GET'),
    route('/api/mail/threads', { status: 200, body: { query: 'in:inbox', threads: [
      { id: '1913726543210987654', subject: 'Invoice', snippet: 'Please find attached', senders: ['Ariel <a@x.com>'], date: 'Mon, 26 Oct 2026 09:00:00 +0000' },
    ] } }, 'GET'),
    route('/api/mail/drafts', { status: 200, body: { draftId: 'draft-9', url: 'https://mail.google.com/mail/#drafts/draft-9' } }, 'POST'),
  ]

  it('searches the linked mailbox and renders the thread with a Gmail permalink', async () => {
    const user = userEvent.setup()
    mountWith(connectedRules())

    await screen.findByText('me@gmail.example')
    expect(screen.queryByText('Invoice')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Invoice')).toBeInTheDocument()
    expect(screen.getByText('Please find attached')).toBeInTheDocument()
    expect(server.last('/api/mail/threads?q=in%3Ainbox')).toBeDefined()

    const open = screen.getByRole('link', { name: 'Open in Gmail' })
    expect(open).toHaveAttribute('href', 'https://mail.google.com/mail/#inbox/1913726543210987654')
  })

  it('creates a draft and reports it as a draft, not a sent mail', async () => {
    const user = userEvent.setup()
    mountWith(connectedRules())

    await screen.findByText('me@gmail.example')
    await user.type(screen.getByLabelText('Draft recipient'), 'a@x.com')
    await user.type(screen.getByLabelText('Draft body'), 'Thanks for the call.')
    await user.click(screen.getByRole('button', { name: 'Create draft' }))

    expect(await screen.findByText(/Draft created \(draft-9\)/)).toBeInTheDocument()
    const call = server.last('/api/mail/drafts')
    expect(call?.method).toBe('POST')
    expect(call?.body).toMatchObject({ to: 'a@x.com', body: 'Thanks for the call.' })
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })
})

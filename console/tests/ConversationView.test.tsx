import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const useChatMock = vi.hoisted(() => vi.fn())
vi.mock('@ai-sdk/react', () => ({ useChat: useChatMock }))

const notFoundMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ notFound: notFoundMock }))

import { ConversationView } from '@/components/chats/ConversationView'
import { pendingKey } from '@/lib/pending'
import { route, stubFetch, type FetchStub } from './fetchStub'

const THREAD = '11111111-1111-4111-8111-111111111111'

interface ChatStub {
  messages: unknown[]
  sendMessage: ReturnType<typeof vi.fn>
  setMessages: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  clearError: ReturnType<typeof vi.fn>
  status: 'ready' | 'streaming' | 'submitted' | 'error'
  error: Error | undefined
}

function chat(overrides: Partial<ChatStub> = {}): ChatStub {
  const value: ChatStub = {
    messages: [],
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
    status: 'ready',
    error: undefined,
    ...overrides,
  }
  useChatMock.mockReturnValue(value)
  return value
}

const threadRow = {
  id: THREAD,
  title: 'Quarterly pipeline review',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T09:30:00Z',
  resource_id: null,
  title_pinned: true,
}

const transcriptPage = {
  messages: [
    { id: 'm1', role: 'user', createdAt: '2026-10-20T09:00:00Z', parts: [{ type: 'text', text: 'Any at-risk deals?' }] },
    { id: 'm2', role: 'assistant', createdAt: '2026-10-20T09:00:05Z', parts: [{ type: 'text', text: 'Two accounts slipped.' }] },
  ],
  total: 2,
  page: 1,
  perPage: 50,
  hasMore: false,
  trace_available: false,
}

let server: FetchStub

beforeEach(() => {
  useChatMock.mockReset()
  notFoundMock.mockReset()
  chat()
  server = stubFetch([])
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const textbox = () => screen.getByPlaceholderText('Type a message...')

describe('ConversationView: transport and composer', () => {
  it('points the transport at the proxied chat route, not at an absolute origin', () => {
    render(<ConversationView threadId={THREAD} hydrate={false} />)
    const init = useChatMock.mock.calls[0]![0] as { transport: { api?: unknown } }
    expect(init.transport).toBeDefined()
    expect(init.transport.api).toBe('/chat/crm')
  })

  it('renders the empty state and the composer', async () => {
    render(<ConversationView threadId={THREAD} hydrate={false} />)
    expect(await screen.findByText(/Start a conversation/)).toBeInTheDocument()
    expect(textbox()).toBeInTheDocument()
    expect(screen.getByLabelText('Send message')).toBeInTheDocument()
  })

  it('sends the thread id as a per-turn header', async () => {
    const { sendMessage } = chat()
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    fireEvent.change(textbox(), { target: { value: 'Hello CRM' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const [message, options] = vi.mocked(sendMessage).mock.calls[0]!
    expect(message).toEqual({ text: 'Hello CRM' })
    expect(options).toEqual({ headers: { 'x-thread-id': THREAD } })
  })

  it('clears the input after sending', async () => {
    render(<ConversationView threadId={THREAD} hydrate={false} />)
    const input = textbox() as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: 'Test message' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(input.value).toBe('')
  })

  it('does not send empty messages', async () => {
    const { sendMessage } = chat()
    render(<ConversationView threadId={THREAD} hydrate={false} />)
    fireEvent.click(screen.getByLabelText('Send message'))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText(/Start a conversation/)).toBeInTheDocument()
  })

  it('sends on Enter', async () => {
    const { sendMessage } = chat()
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    fireEvent.change(textbox(), { target: { value: 'Enter key test' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  it('refuses to send while a stream is in flight', async () => {
    const { sendMessage } = chat({ status: 'streaming' })
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    fireEvent.change(textbox(), { target: { value: 'queued?' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('swaps Send for Stop while streaming, and the stop is also a server signal', async () => {
    const { stop } = chat({ status: 'streaming' })
    server = stubFetch([route('/api/signals/interrupt', { status: 202, body: { ok: true } })])
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    expect(screen.queryByLabelText('Send message')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stop generation'))

    expect(stop).toHaveBeenCalled()
    const call = server.last('/api/signals/interrupt')
    expect(call?.method).toBe('POST')
    expect(call?.headers['x-session-id']).toBe(THREAD)
  })
})

describe('ConversationView: message rendering', () => {
  it('labels a user turn and an assistant turn distinctly', () => {
    chat({
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Styled message' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] },
      ],
    })
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    expect(screen.getByRole('group', { name: 'Your message' })).toHaveTextContent('Styled message')
    expect(screen.getByRole('group', { name: 'Assistant message' })).toHaveTextContent('Reply')
  })

  it('renders a dynamic tool part as a collapsed inspector with a human state', () => {
    chat({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'crm_search',
              toolCallId: 'call-1',
              state: 'input-available',
              input: { query: 'Nordwind' },
            },
          ],
        },
      ],
    })
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    const inspector = screen.getByRole('button', { name: /crm_search/ })
    expect(inspector).toHaveAttribute('data-tool', 'crm_search')
    expect(inspector.textContent).toContain('running')
    expect(inspector).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Nordwind/)).toBeNull()
  })

  it('renders a static tool part (tool-<name>) and its result state', () => {
    chat({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'tool-crm_get_customer', toolCallId: 'call-2', state: 'result', input: {}, output: {} },
          ],
        },
      ],
    })
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    const inspector = screen.getByRole('button', { name: /crm_get_customer/ })
    expect(inspector.textContent).toContain('done')
  })

  it('names the approval state instead of pretending the tool is still running', () => {
    chat({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'crm_update_customer',
              toolCallId: 'c3',
              state: 'approval-requested',
              input: {},
            },
          ],
        },
      ],
    })
    render(<ConversationView threadId={THREAD} hydrate={false} />)
    expect(screen.getByRole('button', { name: /crm_update_customer/ }).textContent).toContain(
      'waiting for approval',
    )
  })

  it('shows a stream error with a way to dismiss it', async () => {
    const { clearError } = chat({ error: new Error('502 Bad Gateway: upstream refused') })
    render(<ConversationView threadId={THREAD} hydrate={false} />)

    expect(screen.getByRole('alert').textContent).toContain('502 Bad Gateway')
    fireEvent.click(screen.getByLabelText('Dismiss error'))
    expect(clearError).toHaveBeenCalled()
  })
})

describe('ConversationView: hydration of a stored thread', () => {
  it('reads the metadata, then pages the transcript into useChat once', async () => {
    const { setMessages } = chat()
    server = stubFetch([
      route('/api/agent/threads/', { status: 200, body: threadRow }),
      route('/messages', { status: 200, body: transcriptPage }),
    ])
    render(<ConversationView threadId={THREAD} />)

    await waitFor(() => expect(setMessages).toHaveBeenCalledTimes(1))
    expect(setMessages).toHaveBeenCalledWith(transcriptPage.messages)
    const urls = server.calls.map((c) => c.url)
    expect(urls[0]).toBe(`/api/agent/threads/${THREAD}`)
    expect(urls[1]).toContain(`/api/agent/threads/${THREAD}/messages?page=1&perPage=50`)
  })

  it('renders not-found for a 404 rather than an empty conversation', async () => {
    const { setMessages } = chat()
    server = stubFetch([route('/api/agent/threads/', { status: 404, body: { error: 'not_found' } })])
    render(<ConversationView threadId={THREAD} />)

    await waitFor(() => expect(notFoundMock).toHaveBeenCalled())
    expect(server.count('/messages')).toBe(0)
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('keeps a readable failure on screen and offers a retry', async () => {
    chat()
    server = stubFetch([
      route('/api/agent/threads/', { status: 503, body: { error: 'unavailable', detail: 'gateway down' } }),
    ])
    render(<ConversationView threadId={THREAD} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('gateway down')
    expect(notFoundMock).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Retry loading conversation')).toBeInTheDocument()
  })
})

describe('ConversationView: the launch handoff', () => {
  it('sends the parked first message and skips the existence check', async () => {
    const { sendMessage } = chat()
    sessionStorage.setItem(pendingKey(THREAD), 'Who is overdue today?')
    render(<ConversationView threadId={THREAD} />)

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(sendMessage).mock.calls[0]![0]).toEqual({ text: 'Who is overdue today?' })
    expect(vi.mocked(sendMessage).mock.calls[0]![1]).toEqual({
      headers: { 'x-thread-id': THREAD },
    })
    expect(server.count('/api/agent/threads/')).toBe(0)
    expect(sessionStorage.getItem(pendingKey(THREAD))).toBeNull()
  })

  it('prefers an explicit initialMessage over the stored handoff', async () => {
    const { sendMessage } = chat()
    sessionStorage.setItem(pendingKey(THREAD), 'stale draft')
    render(<ConversationView threadId={THREAD} initialMessage="typed in the launch view" />)

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(sendMessage).mock.calls[0]![0]).toEqual({ text: 'typed in the launch view' })
  })

  it('a plain reopen with nothing parked is hydrating, not launching', async () => {
    const { sendMessage } = chat()
    server = stubFetch([
      route('/api/agent/threads/', { status: 200, body: threadRow }),
      route('/messages', { status: 200, body: transcriptPage }),
    ])
    render(<ConversationView threadId={THREAD} />)

    await waitFor(() => expect(server.count('/api/agent/threads/')).toBe(1))
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

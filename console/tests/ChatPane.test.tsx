import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * `useChat` is mocked, and that is the honest boundary here. The alternative — a
 * fake HTTP server feeding a real `DefaultChatTransport` — would be testing the AI
 * SDK's own streaming parser, which is its business, not the console's. What these
 * tests own is the console's half: which parts become text, which become tool
 * chips, what goes in the request headers, and what the pane shows when the stream
 * fails or is still running.
 */
const useChatMock = vi.hoisted(() => vi.fn())
vi.mock('@ai-sdk/react', () => ({ useChat: useChatMock }))

import { ChatPane } from '../components/ChatPane'

const THREAD = '11111111-1111-4111-8111-111111111111'

/** The slice of `UseChatHelpers` this component reads. */
interface ChatStub {
  messages: unknown[]
  sendMessage: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  clearError: ReturnType<typeof vi.fn>
  status: 'ready' | 'streaming' | 'submitted' | 'error'
  error: Error | undefined
}

function chat(overrides: Partial<ChatStub> = {}): ChatStub {
  const value: ChatStub = {
    messages: [],
    sendMessage: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
    status: 'ready',
    error: undefined,
    ...overrides,
  }
  useChatMock.mockReturnValue(value)
  return value
}

beforeEach(() => {
  useChatMock.mockReset()
  chat()
})

describe('ChatPane', () => {
  it('points the transport at the proxied chat route, not at an absolute origin', () => {
    render(<ChatPane threadId={THREAD} />)
    const init = useChatMock.mock.calls[0]![0] as { transport: { api?: unknown } }
    // A relative url is what keeps the browser on :3000: no CORS, no port or
    // credential in a `NEXT_PUBLIC_*` value (§13.6).
    expect(init.transport).toBeDefined()
    expect(init.transport.api).toBe('/chat/crm')
  })

  it('renders the empty state when no messages exist', () => {
    render(<ChatPane threadId={THREAD} />)
    expect(screen.getByText(/Start a conversation/)).toBeInTheDocument()
  })

  it('renders the input field and send button', () => {
    render(<ChatPane threadId={THREAD} />)
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
    expect(screen.getByLabelText('Send message')).toBeInTheDocument()
  })

  it('sends the thread id as a per-turn header', async () => {
    const { sendMessage } = chat()
    render(<ChatPane threadId={THREAD} />)

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'Hello CRM' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const [message, options] = vi.mocked(sendMessage).mock.calls[0]!
    expect(message).toEqual({ text: 'Hello CRM' })
    // The server reads the thread from a header so it never has to buffer the
    // streamed body; without this every turn would open a new single-turn thread.
    expect(options).toEqual({ headers: { 'x-thread-id': THREAD } })
  })

  it('clears the input after sending', async () => {
    chat()
    render(<ChatPane threadId={THREAD} />)
    const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Test message' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(input.value).toBe('')
  })

  it('does not send empty messages', async () => {
    const { sendMessage } = chat()
    render(<ChatPane threadId={THREAD} />)
    fireEvent.click(screen.getByLabelText('Send message'))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText(/Start a conversation/)).toBeInTheDocument()
  })

  it('sends on Enter', async () => {
    const { sendMessage } = chat()
    render(<ChatPane threadId={THREAD} />)
    const input = screen.getByPlaceholderText('Type a message...')

    fireEvent.change(input, { target: { value: 'Enter key test' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  it('refuses to send while a stream is in flight', async () => {
    const { sendMessage } = chat({ status: 'streaming' })
    render(<ChatPane threadId={THREAD} />)
    const input = screen.getByPlaceholderText('Type a message...')

    fireEvent.change(input, { target: { value: 'queued?' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('renders text parts inside a token span under the role class', () => {
    chat({
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Styled message' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] },
      ],
    })
    const { container } = render(<ChatPane threadId={THREAD} />)

    const token = screen.getByText('Styled message')
    expect(token.tagName).toBe('SPAN')
    expect(token).toHaveClass('token')
    expect(token.closest('.message')).toHaveClass('user')
    expect(screen.getByText('Reply').closest('.message')).toHaveClass('assistant')
  })

  it('renders a dynamic tool part as a chip with a human state', () => {
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
    render(<ChatPane threadId={THREAD} />)

    const chip = document.querySelector('[data-tool="crm_search"]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('crm_search')
    expect(chip!.textContent).toContain('running')
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
    render(<ChatPane threadId={THREAD} />)

    const chip = document.querySelector('[data-tool="crm_get_customer"]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('done')
  })

  it('names the approval state instead of pretending the tool is still running', () => {
    chat({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'dynamic-tool', toolName: 'crm_update_customer', toolCallId: 'c3', state: 'approval-requested', input: {} },
          ],
        },
      ],
    })
    render(<ChatPane threadId={THREAD} />)
    // The decision lives on /approvals; the chip's job is to say so, not to offer a
    // second approve button that bypasses the receipt.
    expect(document.querySelector('[data-tool="crm_update_customer"]')!.textContent).toContain('waiting for approval')
  })

  it('shows an error with a way to dismiss it', async () => {
    const { clearError } = chat({ error: new Error('502 Bad Gateway: upstream refused') })
    render(<ChatPane threadId={THREAD} />)

    expect(screen.getByRole('alert').textContent).toContain('502 Bad Gateway')
    fireEvent.click(screen.getByLabelText('Dismiss error'))
    expect(clearError).toHaveBeenCalled()
  })

  it('swaps Send for Stop while streaming', () => {
    const { stop } = chat({ status: 'streaming' })
    render(<ChatPane threadId={THREAD} />)
    expect(screen.queryByLabelText('Send message')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stop generation'))
    expect(stop).toHaveBeenCalled()
  })
})

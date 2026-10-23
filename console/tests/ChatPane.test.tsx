import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatPane } from '../components/ChatPane'

describe('ChatPane', () => {
  it('renders the empty state when no messages exist', () => {
    render(<ChatPane />)
    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })

  it('renders the input field and send button', () => {
    render(<ChatPane />)
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
    expect(screen.getByText('Send')).toBeInTheDocument()
  })

  it('adds a user message when send is clicked', async () => {
    render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...')
    const sendButton = screen.getByText('Send')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Hello CRM' } })
    })
    await act(async () => {
      fireEvent.click(sendButton)
    })

    await waitFor(() => {
      expect(screen.getByText('Hello CRM')).toBeInTheDocument()
    })
  })

  it('clears the input after sending', async () => {
    render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement
    const sendButton = screen.getByText('Send')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Test message' } })
    })
    await act(async () => {
      fireEvent.click(sendButton)
    })

    expect(input.value).toBe('')
  })

  it('does not send empty messages', async () => {
    render(<ChatPane />)
    const sendButton = screen.getByText('Send')
    await act(async () => {
      fireEvent.click(sendButton)
    })

    // Empty state should still be visible
    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })

  it('receives a mock assistant response after sending', async () => {
    vi.useFakeTimers()
    render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...')
    const sendButton = screen.getByText('Send')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Hello' } })
    })
    await act(async () => {
      fireEvent.click(sendButton)
    })

    // User message appears immediately
    expect(screen.getByText('Hello')).toBeInTheDocument()

    // Advance past the 500ms mock delay
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    // Assistant echo response should appear
    expect(screen.getByText('Echo: Hello')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('sends a message when Enter is pressed', async () => {
    render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Enter key test' } })
    })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(screen.getByText('Enter key test')).toBeInTheDocument()
    })
  })

  it('applies the user class to user messages', async () => {
    const { container } = render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...')
    const sendButton = screen.getByText('Send')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Styled message' } })
    })
    await act(async () => {
      fireEvent.click(sendButton)
    })

    await waitFor(() => {
      const msg = screen.getByText('Styled message')
      expect(msg.closest('.message')).toHaveClass('user')
    })
  })

  it('applies the token span inside messages', async () => {
    render(<ChatPane />)
    const input = screen.getByPlaceholderText('Type a message...')
    const sendButton = screen.getByText('Send')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Token test' } })
    })
    await act(async () => {
      fireEvent.click(sendButton)
    })

    await waitFor(() => {
      const token = screen.getByText('Token test')
      expect(token.tagName).toBe('SPAN')
      expect(token).toHaveClass('token')
    })
  })
})

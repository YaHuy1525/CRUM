import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pushMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

import { LaunchView } from '@/components/chats/LaunchView'
import { STARTERS } from '@/lib/starters'
import { pendingKey } from '@/lib/pending'

beforeEach(() => {
  pushMock.mockReset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const composer = () => screen.getByLabelText('Message') as HTMLTextAreaElement

describe('LaunchView', () => {
  it('mints a thread id, parks the message, and navigates into the conversation', async () => {
    render(<LaunchView />)

    fireEvent.change(composer(), { target: { value: '  Draft a follow-up for Acme  ' } })
    fireEvent.click(screen.getByLabelText('Start conversation'))

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1))
    const target = pushMock.mock.calls[0]![0] as string
    expect(target).toMatch(/^\/chats\/[0-9a-f-]{36}$/)

    const threadId = target.slice('/chats/'.length)
    expect(sessionStorage.getItem(pendingKey(threadId))).toBe('Draft a follow-up for Acme')
  })

  it('sends on Enter, and Shift+Enter stays a newline', async () => {
    render(<LaunchView />)

    fireEvent.change(composer(), { target: { value: 'line one' } })
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })
    expect(pushMock).not.toHaveBeenCalled()

    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1))
  })

  it('cannot launch an empty message', () => {
    render(<LaunchView />)
    const start = screen.getByLabelText('Start conversation') as HTMLButtonElement

    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('fills the composer from a starter card instead of launching immediately', async () => {
    render(<LaunchView />)
    const first = STARTERS[0]!

    fireEvent.click(screen.getByRole('button', { name: new RegExp(first.label) }))

    expect(composer().value).toBe(first.prompt)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('seeds the composer from a hand-off without sending it', () => {
    render(<LaunchView initialText={'Create a customer from this note:\n\nMaria at Nordwind'} />)

    expect(composer().value).toContain('Maria at Nordwind')
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('carries the one reserved gradient token, on the composer only', () => {
    const { container } = render(<LaunchView />)
    const gradient = container.querySelectorAll('[class*="grad-composer"]')
    expect(gradient).toHaveLength(1)
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionList } from '../components/SessionList'

describe('SessionList', () => {
  it('renders mock sessions after mount', async () => {
    render(<SessionList />)
    const thread1 = await screen.findByText('thread-1')
    const thread2 = await screen.findByText('thread-2')
    expect(thread1).toBeInTheDocument()
    expect(thread2).toBeInTheDocument()
  })

  it('renders session items with the session-item class', async () => {
    const { container } = render(<SessionList />)
    await screen.findByText('thread-1')
    const items = container.querySelectorAll('.session-item')
    expect(items.length).toBe(2)
  })

  it('marks a session as active on click', async () => {
    const user = userEvent.setup()
    const { container } = render(<SessionList />)
    await screen.findByText('thread-1')
    const items = container.querySelectorAll('.session-item')
    await user.click(items[0])
    expect(items[0].className).toContain('active')
  })

  it('renders within 300ms (performance acceptance)', async () => {
    const start = performance.now()
    render(<SessionList />)
    await screen.findByText('thread-1')
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(300)
  })
})

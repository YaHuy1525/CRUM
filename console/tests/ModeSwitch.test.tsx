import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModeSwitch } from '../components/ModeSwitch'

describe('ModeSwitch', () => {
  it('renders explore and operate modes', () => {
    const onModeChange = vi.fn()
    render(<ModeSwitch currentMode="explore" onModeChange={onModeChange} />)
    expect(screen.getByText(/explore/i)).toBeInTheDocument()
    expect(screen.getByText(/operate/i)).toBeInTheDocument()
  })

  it('calls onModeChange when mode is clicked', () => {
    const onModeChange = vi.fn()
    render(<ModeSwitch currentMode="explore" onModeChange={onModeChange} />)
    fireEvent.click(screen.getByText(/operate/i))
    expect(onModeChange).toHaveBeenCalledWith('operate')
  })
})

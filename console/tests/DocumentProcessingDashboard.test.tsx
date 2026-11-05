import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { DocumentProcessingDashboard } from '../components/DocumentProcessingDashboard'

const TENANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DOC = 'a1a1a1a1-0000-4000-8000-000000000001'

/** The browser WebSocket, replaced with something the test can push frames through. */
class FakeSocket {
  static instances: FakeSocket[] = []

  onopen?: (() => void) | null
  onclose?: ((event: { code: number; reason: string }) => void) | null
  onerror?: (() => void) | null
  onmessage?: ((event: { data: string }) => void) | null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  close(): void {}

  open(): void {
    act(() => {
      this.onopen?.()
    })
  }

  emit(type: string, payload: object = {}): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify({ type, ...payload }) })
    })
  }

  /** Deliver a close frame with the given code, as the browser would. */
  closed(code: number, reason = ''): void {
    act(() => {
      this.onclose?.({ code, reason })
    })
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubEnv('NEXT_PUBLIC_CRUM_DEV_TENANT_ID', TENANT)
  vi.stubEnv('NEXT_PUBLIC_CRUM_DEV_USER_ID', USER)
  vi.stubEnv('NEXT_PUBLIC_CRUM_WS_ORIGIN', 'ws://127.0.0.1:4113')
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function mount() {
  render(<DocumentProcessingDashboard />)
  const socket = FakeSocket.instances[0] as FakeSocket
  socket.open()
  return socket
}

describe('DocumentProcessingDashboard', () => {
  it('dials the REST plane with the dev identity on the query string', () => {
    const socket = mount()
    expect(socket.url).toBe(`ws://127.0.0.1:4113/ws/documents?tenantId=${TENANT}&userId=${USER}`)
  })

  it('shows the job the server says is running, with its progress', () => {
    const socket = mount()
    socket.emit('connected')
    socket.emit('document.processing', { jobId: 'job-1', fileName: 'bill.pdf' })
    socket.emit('document.progress', { jobId: 'job-1', fileName: 'bill.pdf', progress: 55 })

    expect(screen.getByText('bill.pdf')).toBeInTheDocument()
    expect(screen.getByText('55%')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('moves a job to completed and names the document it stored', () => {
    const socket = mount()
    socket.emit('document.processing', { jobId: 'job-1', fileName: 'bill.pdf' })
    socket.emit('document.completed', {
      jobId: 'job-1',
      documentId: DOC,
      status: 'ready',
      kind: 'invoice',
      confidence: 0.9,
    })

    expect(screen.getByText('completed')).toBeInTheDocument()
    expect(screen.getByText(`Document ${DOC} · invoice · 90% confidence`)).toBeInTheDocument()
  })

  it('reports a failed job instead of leaving it running', () => {
    const socket = mount()
    socket.emit('document.processing', { jobId: 'job-1', fileName: 'bill.pdf' })
    socket.emit('document.failed', { jobId: 'job-1', error: 'parse failed' })

    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('parse failed')).toBeInTheDocument()
  })

  it('explains a policy refusal and stops retrying it', () => {
    vi.useFakeTimers()
    try {
      const socket = mount()
      socket.closed(1008, 'missing-token')
      vi.advanceTimersByTime(20000)

      expect(screen.getByText(/Live updates need CRUM_AUTH_MODE=dev/)).toBeInTheDocument()
      // A dropped connection retries after five seconds; a refusal must not, so
      // four intervals later there is still only the one socket.
      expect(FakeSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects a connection that dropped for no policy reason', () => {
    vi.useFakeTimers()
    try {
      const socket = mount()
      socket.closed(1006)
      vi.advanceTimersByTime(6000)

      expect(FakeSocket.instances).toHaveLength(2)
      expect(screen.queryByText(/Live updates need/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KnowledgePage from '../app/knowledge/page'
import { route, stubFetch, type FetchStub, type Rule } from './fetchStub'


let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountWith(rules: Rule[]) {
  server = stubFetch(rules)
  return render(<KnowledgePage />)
}

describe('KnowledgePage tabs', () => {
  it('renders Knowledge / Invoices / Contracts, defaulting to Knowledge', async () => {
    mountWith([route('/api/knowledge/documents', { status: 200, body: { documents: [], total: 0 } }, 'GET')])

    const knowledgeTab = screen.getByRole('tab', { name: 'Knowledge' })
    expect(screen.getByRole('tab', { name: 'Invoices' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Contracts' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Campaign images' })).toBeInTheDocument()
    expect(knowledgeTab).toHaveAttribute('aria-selected', 'true')
    await waitForRead('/api/knowledge/documents')
  })

  it('switching to Invoices mounts the structured manager and reads the invoice list', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/knowledge/documents', { status: 200, body: { documents: [], total: '0' } }, 'GET'),
      route('/api/documents?kind=invoice', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
    ])

    await user.click(screen.getByRole('tab', { name: 'Invoices' }))

    await waitForRead('/api/documents?kind=invoice')
    expect(screen.getByLabelText('Upload a invoice')).toBeInTheDocument()
  })

  it('switching to Campaign images reads the asset kind and nothing else', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/knowledge/documents', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
      route('/api/documents?kind=marketing_asset', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
    ])

    await user.click(screen.getByRole('tab', { name: 'Campaign images' }))

    await waitForRead('/api/documents?kind=marketing_asset')
    expect(server.count('/api/documents?kind=invoice')).toBe(0)
  })

  it('switching to Processing mounts the queue dashboard', async () => {
    const user = userEvent.setup()
    mountWith([route('/api/knowledge/documents', { status: 200, body: { documents: [], total: 0 } }, 'GET')])

    await user.click(screen.getByRole('tab', { name: 'Processing' }))

    // The dashboard was unreachable until this tab existed, so the assertion is
    // that its own heading is on screen, not that a socket opened.
    expect(screen.getByText('Processing queue')).toBeInTheDocument()
  })
})

async function waitForRead(urlContains: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.count(urlContains) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no request to ${urlContains} within timeout`)
}

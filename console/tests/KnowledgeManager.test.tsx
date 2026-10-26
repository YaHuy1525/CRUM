import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeManager } from '../components/KnowledgeManager'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { KnowledgeDocument } from '../lib/types'


function doc(over: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'k1k1k1k1-0000-4000-8000-000000000001',
    title: 'Return policy 2026',
    file_type: 'markdown',
    content_hash: 'sha256:abc',
    byte_size: 2048,
    status: 'ready',
    owner_id: 'user-1',
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-24T09:00:00.000Z',
    ...over,
  }
}

const list = (documents: KnowledgeDocument[]): Reply => ({ status: 200, body: { documents, total: documents.length } })

const REINGEST_409 = {
  status: 409,
  body: {
    error: 'reingest_unsupported',
    detail:
      'The source text is not stored (only its hash), so a document can only be re-indexed by uploading it again.',
    documentId: 'k1k1k1k1-0000-4000-8000-000000000001',
  },
}

let server: FetchStub

function mount(rules: Rule[]) {
  server = stubFetch(rules)
  return server
}

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('KnowledgeManager', () => {
  it('lists the tenant documents with their real status', async () => {
    mount([
      route('/api/knowledge/documents', list([doc(), doc({ id: 'k2', title: 'Freight tiers', status: 'failed', byte_size: 512 })])),
    ])
    render(<KnowledgeManager />)

    expect(await screen.findByText('Return policy 2026')).toBeInTheDocument()
    expect(screen.getByText('Freight tiers')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText(/2048 bytes/)).toBeInTheDocument()
  })

  it('an unreadable list is not shown as "no documents"', async () => {
    mount([route('/api/knowledge/documents', { status: 401, body: { error: 'unauthorized', reason: 'invalid-claim' } })])
    render(<KnowledgeManager />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('invalid-claim')
    expect(screen.queryByText(/No documents uploaded yet/)).toBeNull()
  })

  it('uploads text, reports what the ingest actually returned, and re-reads', async () => {
    const user = userEvent.setup()
    let reads = 0
    mount([
      route('/api/knowledge/documents', () => ({ status: 200, body: { documents: reads++ === 0 ? [] : [doc()], total: 1 } })),
      route('/api/knowledge/upload', {
        status: 201,
        body: { documentId: 'k1k1k1k1-0000-4000-8000-000000000001', status: 'ready', chunk_count: 3 },
      }),
    ])
    render(<KnowledgeManager />)
    expect(await screen.findByText(/No documents uploaded yet/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Document title'), 'Return policy 2026')
    await user.type(screen.getByLabelText('Document content'), '# Returns\n30 days.')
    await user.selectOptions(screen.getByLabelText('Content type'), 'markdown')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    const call = server.last('/api/knowledge/upload')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ title: 'Return policy 2026', content: '# Returns\n30 days.', contentType: 'markdown' })
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('3 chunks')
    expect(status.textContent).toContain('ready')
    await waitFor(() => expect(screen.getByText('Return policy 2026')).toBeInTheDocument())
    expect(server.count('/api/knowledge/documents')).toBe(2)
  })

  it('names a duplicate as a duplicate', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/knowledge/documents', list([doc()])),
      route('/api/knowledge/upload', {
        status: 200,
        body: { documentId: 'k1k1k1k1-0000-4000-8000-000000000001', title: 'Return policy 2026', status: 'ready', deduplicated: true },
      }),
    ])
    render(<KnowledgeManager />)

    await user.type(await screen.findByLabelText('Document title'), 'Return policy 2026')
    await user.type(screen.getByLabelText('Document content'), '# Returns\n30 days.')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('nothing was re-embedded')
  })

  it('relays a refused format instead of uploading it anyway', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/knowledge/documents', list([])),
      route('/api/knowledge/upload', {
        status: 415,
        body: { error: 'unsupported_file_type', detail: 'Only .txt, .md, .html and .json are parsed. Convert PDF/DOCX to text before upload.' },
      }),
    ])
    render(<KnowledgeManager />)

    await user.type(await screen.findByLabelText('Document title'), 'Deck')
    await user.type(screen.getByLabelText('Document content'), '%PDF-1.7')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('unsupported_file_type')
    expect(alert.textContent).toContain('Convert PDF/DOCX to text')
  })

  it('tells the truth about re-ingest: the server says 409, the panel says 409', async () => {
    const user = userEvent.setup()
    mount([route('/api/knowledge/documents', list([doc()])), route('/reingest', REINGEST_409)])
    render(<KnowledgeManager />)

    await user.click(await screen.findByRole('button', { name: 'Re-ingest' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('only be re-indexed by uploading it again')
    expect(screen.queryByText(/Re-ingest accepted/)).toBeNull()
    expect(server.last('/reingest')?.url).toBe(`/api/knowledge/documents/${doc().id}/reingest`)
  })

  it('deletes only after a confirmation, and says so afterwards', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let reads = 0
    mount([
      route('/api/knowledge/documents', () => ({ status: 200, body: { documents: reads++ === 0 ? [doc()] : [], total: 0 } })),
      route('/api/knowledge/documents/', { status: 204 }, 'DELETE'),
    ])
    render(<KnowledgeManager />)

    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalled()
    expect(server.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)

    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByText(/Deleted Return policy 2026/)).toBeInTheDocument())
    const deleted = server.calls.find((c) => c.method === 'DELETE')
    expect(deleted?.url).toBe(`/api/knowledge/documents/${doc().id}`)
    expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    expect(await screen.findByText(/No documents uploaded yet/)).toBeInTheDocument()
  })
})

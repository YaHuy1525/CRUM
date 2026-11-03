// console/tests/AssetManager.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetManager } from '../components/AssetManager'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { CrmDocument } from '../lib/types'

const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001'
const OTHER = 'b2b2b2b2-0000-4000-8000-000000000002'

function asset(over: Partial<CrmDocument> = {}): CrmDocument {
  return {
    id: ASSET,
    tenant_id: 'tenant-1',
    owner_id: 'user-1',
    kind: 'marketing_asset',
    title: 'Hero render, physio campaign',
    source: 'upload',
    source_ref: null,
    content_hash: 'sha256:def',
    mime: 'image/png',
    status: 'needs_review',
    confidence: null,
    customer_id: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...over,
  }
}

const list = (documents: CrmDocument[]): Reply => ({ status: 200, body: { documents, total: documents.length } })

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
  return render(<AssetManager />)
}

describe('AssetManager', () => {
  it('lists generated assets with their review state and the gated thumbnail', async () => {
    mountWith([
      route(
        '/api/documents?kind=marketing_asset',
        list([asset(), asset({ id: OTHER, title: 'Story square', status: 'ready' })]),
        'GET',
      ),
    ])

    expect(await screen.findByText('Hero render, physio campaign')).toBeInTheDocument()
    expect(screen.getByText('Story square')).toBeInTheDocument()
    expect(screen.getByText('needs_review')).toBeInTheDocument()
    expect(screen.getAllByText('image/png')).toHaveLength(2)
    expect(screen.getByAltText('Generated image: Hero render, physio campaign')).toHaveAttribute(
      'src',
      `/api/marketing/assets/${ASSET}/bytes`,
    )
    expect(screen.getByAltText('Generated image: Story square')).toHaveAttribute(
      'src',
      `/api/marketing/assets/${OTHER}/bytes`,
    )
    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1)
  })

  it('answers a withheld thumbnail with the awaiting-review slot', async () => {
    mountWith([route('/api/documents?kind=marketing_asset', list([asset()]), 'GET')])

    const img = await screen.findByRole('img')
    fireEvent.error(img)

    expect(await screen.findByText('Awaiting review')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('says what confirming a picture cost the bundle waiting on it', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/documents?kind=marketing_asset', list([asset()]), 'GET'),
      route(
        `/api/documents/${ASSET}/review`,
        { status: 200, body: { documentId: ASSET, status: 'ready', invalidatedBundles: 2 } },
        'POST',
      ),
    ])

    await user.click(await screen.findByRole('button', { name: 'Confirm' }))

    expect(server.last(`/api/documents/${ASSET}/review`)).toBeDefined()
    expect(await screen.findByRole('status')).toHaveTextContent('2 staged bundle(s) went back to draft')
  })

  it('says there is nothing yet, rather than showing an empty table', async () => {
    mountWith([route('/api/documents?kind=marketing_asset', list([]), 'GET')])
    expect(await screen.findByText(/No generated images yet/)).toBeInTheDocument()
  })
})

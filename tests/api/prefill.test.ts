import { describe, it, expect } from 'vitest'
import { createPrefillRouter } from '../../src/api/prefill'

describe('createPrefillRouter', () => {
  it('returns a Hono app', () => {
    const router = createPrefillRouter()
    expect(router).toBeDefined()
    expect(typeof router.fetch).toBe('function')
  })

  it('rejects unknown object types with 400', async () => {
    const router = createPrefillRouter()
    const res = await router.request('/api/crm/prefill/unknown', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'test-tenant' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(400)
  })

  it('requires x-tenant-id header', async () => {
    const router = createPrefillRouter()
    const res = await router.request('/api/crm/prefill/customer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Acme Corp' }),
    })
    expect(res.status).toBe(400)
  })

  it('requires text in request body', async () => {
    const router = createPrefillRouter()
    const res = await router.request('/api/crm/prefill/customer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'test-tenant' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

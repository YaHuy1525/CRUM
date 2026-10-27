import { describe, it, expect } from 'vitest'
import autocannon from 'autocannon'

describe('load: session list', () => {
  it('p95 latency under 300ms at 10 concurrent for 10s', async () => {
    const result = await autocannon({
      url: 'http://localhost:4111/api/sessions',
      connections: 10,
      duration: 10,
      headers: { 'x-tenant-id': 'load-test-tenant' },
    })

    expect(result.p95).toBeLessThan(300)
    expect(result.non2xx).toBe(0)
  }, 30_000)
})

import { describe, it, expect } from 'vitest'
// @ts-ignore — autocannon has no bundled types; tests need a live server anyway
import autocannon from 'autocannon'

describe('load: retrieval tool', () => {
  it('p95 latency under 2s at 5 concurrent for 10s', async () => {
    const result = await autocannon({
      url: 'http://localhost:4111/api/chat',
      method: 'POST',
      connections: 5,
      duration: 10,
      headers: {
        'x-tenant-id': 'load-test-tenant',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'who is in Seattle?' }],
      }),
    })

    expect(result.p95).toBeLessThan(2000)
  }, 30_000)
})

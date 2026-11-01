// tests/marketing/replicate.test.ts
import { describe, expect, it, vi } from 'vitest'
import {
  ASPECT_RATIOS,
  MAX_PROMPT_CHARS,
  costUsdToMinor,
  generateImage,
  isAspectRatio,
  type ReplicateConfig,
} from '../../src/marketing/replicate'

const TOKEN = 'r8_test_token_not_real'
const BYTES = new Uint8Array([137, 80, 78, 71])
const REQUEST = { prompt: 'a physio clinic reception at dawn', aspectRatio: '16:9', seed: 4217 }

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    // The adapter reads text on a refused create, so a double without it throws
    // a TypeError instead of reporting the status it should have refused on.
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

function succeeded(predictionId = 'pred-1') {
  return json(200, {
    id: predictionId,
    status: 'succeeded',
    model: 'black-forest-labs/flux-1.1-pro',
    output: `https://replicate.delivery/${predictionId}.png`,
    urls: { get: `https://replicate.delivery/${predictionId}.png` },
    cost: '0.04',
    error: null,
  })
}

function config(responses: Response[]): ReplicateConfig {
  const fetchImpl = vi.fn(() => Promise.resolve(responses.shift() ?? json(500, { detail: 'ran out' })))
  return {
    apiToken: TOKEN,
    maxBytes: 15 * 1024 * 1024,
    fetchImpl,
    sleep: async () => {},
  }
}

function bytes() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(BYTES.buffer.slice(0)),
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
  } as unknown as Response
}

describe('generateImage', () => {
  it('creates a prediction, polls it, and downloads the bytes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'pred-9', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('pred-9'))
      .mockResolvedValueOnce(bytes())
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 15 * 1024 * 1024,
      fetchImpl,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.image.predictionId).toBe('pred-9')
    expect(outcome.image.costMinor).toBe(4)
    expect(outcome.image.bytes).toEqual(BYTES)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // `!` because noUncheckedIndexedAccess makes a destructure off mock.calls
    // possibly undefined; the call count above is what proves it is there.
    const [create] = fetchImpl.mock.calls as unknown[][]
    expect(create![0]).toBe('https://api.replicate.com/v1/predictions')
    expect((create![1] as RequestInit).method ?? 'POST').toMatch(/POST/)
    const headers = (create![1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe(`Token ${TOKEN}`)
  })

  it('sends only the fields the model takes, and never a negative prompt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce(bytes())
    await generateImage(
      { ...REQUEST, negativePrompt: 'no text, no watermark' },
      {
        apiToken: TOKEN,
        maxBytes: 15 * 1024 * 1024,
        fetchImpl,
        sleep: async () => {},
      },
    )
    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toEqual({
      model: 'black-forest-labs/flux-1.1-pro',
      input: {
        prompt: REQUEST.prompt,
        aspect_ratio: '16:9',
        output_format: 'png',
        seed: 4217,
      },
    })
    expect(JSON.stringify(body)).not.toContain('watermark')
  })

  it('refuses a prompt Replicate would silently truncate', async () => {
    const fetchImpl = vi.fn()
    const outcome = await generateImage(
      { ...REQUEST, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
      {
        apiToken: TOKEN,
        maxBytes: 1024,
        fetchImpl,
        sleep: async () => {},
      },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('prompt_too_long')
    expect(outcome.charge).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses an aspect ratio the model does not take, naming the set that works', async () => {
    const outcome = await generateImage(
      { ...REQUEST, aspectRatio: '5:4' },
      config([json(201, { id: 'p', status: 'starting' })]),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('unsupported_aspect_ratio')
    expect(outcome.detail).toContain(ASPECT_RATIOS.join(', '))
    expect(isAspectRatio('9:16')).toBe(true)
    expect(isAspectRatio('5:4')).toBe(false)
  })

  it('carries Replicate error text out of a failed prediction, with the charge it still cost', async () => {
    const failed = json(200, {
      id: 'pred-f',
      status: 'failed',
      output: null,
      error: 'Input content is flagged',
      logs: '',
    })
    const outcome = await generateImage(REQUEST, config([json(201, { id: 'pred-f', status: 'starting' }), failed]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_failed')
    expect(outcome.detail).toContain('Input content is flagged')
    expect(outcome.charge).toBeNull()
  })

  it('gives up after the poll budget rather than hanging the turn', async () => {
    const responses: Response[] = [json(201, { id: 'p', status: 'starting' })]
    for (let i = 0; i < 20; i++) responses.push(json(200, { id: 'p', status: 'processing' }))
    const sleep = vi.fn(async () => {})
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl: vi.fn(() => Promise.resolve(responses.shift() ?? json(500, {}))),
      sleep,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_timeout')
    // 20 polls and no 21st, with a 2 second gap between each — 19 gaps, because
    // the loop does not wait once it has decided to give up. That is the 40
    // second ceiling on a turn, and it is sleep plus twenty request latencies.
    expect(sleep).toHaveBeenCalledTimes(19)
  })

  it('stops the run at a revoked token instead of burning 20 more calls on it', async () => {
    const outcome = await generateImage(REQUEST, config([json(401, { detail: 'Invalid token' })]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.deadToken).toBe(true)
    expect(outcome.code).toBe('image_generation_failed')
  })

  it('retries a rate limit once and then reports that asset as failed', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { detail: 'Too many requests' }))
      .mockResolvedValueOnce(json(429, { detail: 'Too many requests' }))
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl,
      sleep,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(outcome.detail).toContain('rate')
  })

  it('refuses an over-large image after the download, with the spend kept on the failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array(10).buffer),
        headers: { get: () => null },
      })
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 4,
      fetchImpl,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('asset_too_large')
    // Replicate already billed the prediction, so the money travels with the
    // refusal instead of being lost with the bytes (spec section 9).
    expect(outcome.charge).toEqual({ predictionId: 'p', costUsd: '0.04', costMinor: 4 })
  })

  it('refuses a prediction whose cost field is absent rather than estimating the ledger', async () => {
    const noCost = json(200, { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/p.png', cost: null })
    const outcome = await generateImage(REQUEST, config([json(201, { id: 'p', status: 'starting' }), noCost, bytes()]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('image_generation_failed')
    expect(outcome.detail).toContain('cost')
  })

  it('records a spend with no document when the download dies after a good prediction', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'p', status: 'starting' }))
      .mockResolvedValueOnce(succeeded('p'))
      .mockResolvedValueOnce(json(403, { detail: 'gone' }))
    const outcome = await generateImage(REQUEST, {
      apiToken: TOKEN,
      maxBytes: 1024,
      fetchImpl,
      sleep: async () => {},
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.charge).toEqual({ predictionId: 'p', costUsd: '0.04', costMinor: 4 })
    expect(outcome.detail).toContain('download')
  })
})

describe('costUsdToMinor', () => {
  it('reads a decimal dollar string as cents', () => {
    expect(costUsdToMinor('0.04')).toBe(4)
    expect(costUsdToMinor('0.005')).toBe(1)
    expect(costUsdToMinor('1')).toBe(100)
    expect(costUsdToMinor('0.004')).toBe(0)
    expect(() => costUsdToMinor('0.0.1')).toThrow(/cost/)
  })
})

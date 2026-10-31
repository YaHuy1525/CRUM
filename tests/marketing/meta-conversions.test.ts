// tests/marketing/meta-conversions.test.ts
// Spec section 7: the Conversions API sender must never fail the lead intake,
// must deduplicate on lead_token, and must skip silently when unconfigured.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  buildEventObject,
  conversionsApiConfigFromEnv,
  hashEmail,
  sendConversionEvent,
  type ConversionsApiConfig,
  type ConversionEventInput,
} from '../../src/marketing/meta-conversions'

const SAMPLE_INPUT: ConversionEventInput = {
  leadToken: 'tok-abc-123',
  normalizedEmail: 'test@example.com',
  sourceUrl: 'https://your-domain.test/thanks/',
  bundleId: 'bundle-uuid-1',
  campaignId: '23842653876',
  clientIpAddress: '203.0.113.42',
  clientUserAgent: 'Mozilla/5.0 (Test)',
}

const SAMPLE_CONFIG: ConversionsApiConfig = {
  pixelId: '999888777',
  accessToken: 'test-access-token',
}

function makeFetchMock(status: number, body: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('hashEmail', () => {
  it('returns a 64-character hex SHA-256 digest', () => {
    const hash = hashEmail('test@example.com')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hashEmail('test@example.com')).toBe(hashEmail('test@example.com'))
  })

  it('differs for different inputs', () => {
    expect(hashEmail('a@b.com')).not.toBe(hashEmail('c@d.com'))
  })
})

describe('buildEventObject', () => {
  it('uses the lead_token as event_id for deduplication', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.event_id).toBe('tok-abc-123')
  })

  it('has event_name "Lead" and action_source "website"', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.event_name).toBe('Lead')
    expect(event.action_source).toBe('website')
  })

  it('includes the SHA-256 email hash in user_data.em', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.user_data.em).toEqual([hashEmail('test@example.com')])
  })

  it('carries the request IP and user agent in user_data', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.user_data.client_ip_address).toBe('203.0.113.42')
    expect(event.user_data.client_user_agent).toBe('Mozilla/5.0 (Test)')
  })

  it('includes bundle_id and campaign_id in custom_data', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.custom_data.bundle_id).toBe('bundle-uuid-1')
    expect(event.custom_data.campaign_id).toBe('23842653876')
  })

  it('uses event_source_url from the input', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.event_source_url).toBe('https://your-domain.test/thanks/')
  })

  it('uses the provided event_time', () => {
    const event = buildEventObject(SAMPLE_INPUT, 1698765432)
    expect(event.event_time).toBe(1698765432)
  })

  it('defaults currency to AUD and value to 0', () => {
    const event = buildEventObject(SAMPLE_INPUT)
    expect(event.custom_data.currency).toBe('AUD')
    expect(event.custom_data.value).toBe(0)
  })

  it('handles null campaignId as empty string', () => {
    const input = { ...SAMPLE_INPUT, campaignId: null }
    const event = buildEventObject(input)
    expect(event.custom_data.campaign_id).toBe('')
  })
})

describe('sendConversionEvent', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const logger = { warn: vi.fn() }

  beforeEach(() => {
    fetchMock = vi.fn()
    logger.warn.mockReset()
  })

  it('calls the correct Meta endpoint with the access token as query param', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    })

    await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://graph.facebook.com/v18.0/999888777/events?access_token=test-access-token',
    )
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  it('sends the event wrapped in a data array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    })

    await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body).toHaveProperty('data')
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].event_id).toBe('tok-abc-123')
  })

  it('returns ok true and events_received on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    })

    const result = await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    expect(result.ok).toBe(true)
    expect(result.eventsReceived).toBe(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns ok false and does not throw on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))

    const result = await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('network_error')
    expect(logger.warn).toHaveBeenCalledWith('[CRUM] Conversions API network error', expect.any(Error))
  })

  it('returns ok false and does not throw when Meta returns an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      }),
    })

    const result = await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Invalid parameter')
    expect(logger.warn).toHaveBeenCalledWith(
      '[CRUM] Conversions API HTTP error',
      400,
      'Invalid parameter',
    )
  })

  it('returns ok false when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('unexpected token') },
    })

    const result = await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('unparseable_response')
  })

  it('uses the lead_token as event_id for deduplication', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    })

    await sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: fetchMock },
      SAMPLE_INPUT,
      logger,
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.data[0].event_id).toBe(SAMPLE_INPUT.leadToken)
  })
})

describe('sendConversionEvent — parallel execution', () => {
  it('the API call runs concurrently and does not block the caller', async () => {
    // A slow fetch that resolves after 50ms. The caller should not wait for it
    // because sendConversionEvent is designed to be fired and forgotten.
    let fetchResolved = false
    const slowFetch = vi.fn().mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          fetchResolved = true
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ events_received: 1 }),
          } as Response)
        }, 50)
      })
    })

    const logger = { warn: vi.fn() }
    const promise = sendConversionEvent(
      { ...SAMPLE_CONFIG, fetchImpl: slowFetch },
      SAMPLE_INPUT,
      logger,
    )

    // The promise is in-flight; the fetch was called immediately (not deferred).
    expect(slowFetch).toHaveBeenCalledTimes(1)
    expect(fetchResolved).toBe(false)

    // Await the result to avoid leaking the promise.
    const result = await promise
    expect(result.ok).toBe(true)
    expect(fetchResolved).toBe(true)
  })
})

describe('conversionsApiConfigFromEnv', () => {
  it('returns config when both env vars are present', () => {
    const config = conversionsApiConfigFromEnv({
      CRUM_META_PIXEL_ID: '12345',
      CRUM_META_ADS_ACCESS_TOKEN: 'tok-abc',
    })
    expect(config).toEqual({ pixelId: '12345', accessToken: 'tok-abc' })
  })

  it('returns null when CRUM_META_PIXEL_ID is missing', () => {
    const config = conversionsApiConfigFromEnv({
      CRUM_META_ADS_ACCESS_TOKEN: 'tok-abc',
    })
    expect(config).toBeNull()
  })

  it('returns null when CRUM_META_ADS_ACCESS_TOKEN is missing', () => {
    const config = conversionsApiConfigFromEnv({
      CRUM_META_PIXEL_ID: '12345',
    })
    expect(config).toBeNull()
  })

  it('returns null when both are missing', () => {
    const config = conversionsApiConfigFromEnv({})
    expect(config).toBeNull()
  })

  it('returns null when pixel ID is blank', () => {
    const config = conversionsApiConfigFromEnv({
      CRUM_META_PIXEL_ID: '   ',
      CRUM_META_ADS_ACCESS_TOKEN: 'tok-abc',
    })
    expect(config).toBeNull()
  })

  it('returns null when access token is blank', () => {
    const config = conversionsApiConfigFromEnv({
      CRUM_META_PIXEL_ID: '12345',
      CRUM_META_ADS_ACCESS_TOKEN: '',
    })
    expect(config).toBeNull()
  })
})

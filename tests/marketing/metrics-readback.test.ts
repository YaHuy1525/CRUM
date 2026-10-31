// tests/marketing/metrics-readback.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readCampaignMetrics } from '../../src/marketing/metrics-readback'

describe('readCampaignMetrics', () => {
  const fetchMock = vi.fn()
  const config = {
    accessToken: 'test-token',
    fetchImpl: fetchMock,
  }

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('calls the Meta Insights API with the correct query params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            campaign_name: 'Free Scan - Brisbane - Oct 2026',
            impressions: '1234',
            clicks: '56',
            spend: '45.67',
            actions: [
              { action_type: 'lead', value: '12' },
              { action_type: 'page_engagement', value: '89' },
            ],
            date_start: '2026-10-24',
            date_stop: '2026-10-24',
          },
        ],
      }),
    })

    const result = await readCampaignMetrics('123456', config, {
      since: '2026-10-24',
      until: '2026-10-31',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('graph.facebook.com/v18.0/act_123456/insights')
    expect(url).toContain('level=campaign')
    expect(url).toContain('time_increment=1')
    expect(url).toContain(
      'fields=campaign_name%2Cimpressions%2Cclicks%2Cspend%2Cactions%2Cdate_start%2Cdate_stop',
    )
    expect(url).toContain('access_token=test-token')
    // time_range is JSON-encoded in the query string
    expect(url).toContain('time_range=')

    expect(result.data).toHaveLength(1)
    expect(result.data[0].campaign_name).toBe('Free Scan - Brisbane - Oct 2026')
    expect(result.data[0].impressions).toBe('1234')
    expect(result.data[0].actions).toHaveLength(2)
    expect(result.error).toBeUndefined()
  })

  it('returns an empty data array and an error object when Meta returns an API error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'Invalid ad account',
          type: 'OAuthException',
          code: 100,
        },
      }),
    })

    const result = await readCampaignMetrics('999999', config, {
      since: '2026-10-24',
      until: '2026-10-31',
    })

    expect(result.data).toEqual([])
    expect(result.error).toEqual({
      httpStatus: 400,
      message: 'Invalid ad account',
      type: 'OAuthException',
      code: 100,
    })
  })

  it('throws on network failure so the cron job can log and exit', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))

    await expect(
      readCampaignMetrics('123456', config, {
        since: '2026-10-24',
        until: '2026-10-31',
      }),
    ).rejects.toThrow('metrics_readback_network_error')
  })

  it('uses a default 7-day time range when none is provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    })

    await readCampaignMetrics('123456', config)

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('time_range=')
    // The URL must carry since and until dates; we do not pin exact dates
    // because the clock moves, but the keys must be present.
    const decoded = decodeURIComponent(url)
    expect(decoded).toMatch(/"since":"\d{4}-\d{2}-\d{2}"/)
    expect(decoded).toMatch(/"until":"\d{4}-\d{2}-\d{2}"/)
  })

  it('returns an empty data array when Meta responds with no rows', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const result = await readCampaignMetrics('123456', config, {
      since: '2026-10-24',
      until: '2026-10-31',
    })

    expect(result.data).toEqual([])
    expect(result.error).toBeUndefined()
  })
})

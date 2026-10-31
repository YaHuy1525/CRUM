// tests/marketing/meta-ads.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeCreateCampaignAdapter, makeSetCampaignStatusAdapter } from '../../src/marketing/meta-ads'

describe('makeCreateCampaignAdapter', () => {
  const fetchMock = vi.fn()
  const adapter = makeCreateCampaignAdapter({
    accessToken: 'test-token',
    adAccounts: ['act_123', 'act_456'],
    fetchImpl: fetchMock,
  })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('has the right name', () => {
    expect(adapter.name).toBe('create_campaign')
  })

  it('refuses when startPaused is false', async () => {
    const action = {
      action: 'create_campaign' as const,
      payload: {
        adAccountId: 'act_123',
        name: 'Test Campaign',
        objective: 'LEAD_GENERATION',
        startPaused: false,
        dailyCeilingMinor: 5000,
      },
    }

    await expect(adapter.execute(action, { tenantId: 'tenant-1' })).rejects.toThrow(
      'campaign_must_be_paused',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when adAccountId is not in the configured list', async () => {
    const action = {
      action: 'create_campaign' as const,
      payload: {
        adAccountId: 'act_999',
        name: 'Test Campaign',
        objective: 'LEAD_GENERATION',
        startPaused: true,
        dailyCeilingMinor: 5000,
      },
    }

    await expect(adapter.execute(action, { tenantId: 'tenant-1' })).rejects.toThrow(
      'unknown_ad_account',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the Meta API with the right payload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => ({
        id: '23842653876',
        account_id: 'act_123',
        status: 'PAUSED',
        created_time: '2026-10-31T09:00:00+0000',
      }),
    })

    const action = {
      action: 'create_campaign' as const,
      payload: {
        adAccountId: 'act_123',
        name: 'Test Campaign',
        objective: 'LEAD_GENERATION',
        startPaused: true,
        dailystatic: 5000,
        audience: { location: 'Brisbane, AU' },
        placements: ['facebook_feed'],
        budgetLadder: [{ days: 3, dailyMinor: 3000 }],
      },
    }

    const result = await adapter.execute(action, { tenantId: 'tenant-1' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v18.0/act_123/campaigns',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      }),
    )

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string) as Record<string, unknown>
    expect(body.name).toBe('Test Campaign')
    expect(body.objective).toBe('LEAD_GENERATION')
    expect(body.status).toBe('PAUSED')

    expect(result.externalId).toBe('23842653876')
  })

  it('stores the Meta API response in result', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => ({
        id: '23842653876',
        account_id: 'act_123',
        status: 'PAUSED',
        created_time: '2026-10-31T09:00:00+0000',
      }),
    })

    const action = {
      action: 'create_campaign' as const,
      payload: {
        adAccountId: 'act_123',
        name: 'Test Campaign',
        objective: 'LEAD_GENERATION',
        startPaused: true,
        dailyCeilingMinor: 5000,
      },
    }

    const result = await adapter.execute(action, { tenantId: 'tenant-1' })

    expect(result).toEqual({
      externalId: '23842653876',
      campaignId: '23842653876',
      accountId: 'act_123',
      status: 'PAUSED',
      createdTime: '2026-10-31T09:00:00+0000',
    })
  })

  it('stores API errors in result.error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => ({
        error: {
          message: 'Invalid parameter',
          type: 'OAuthException',
          code: 100,
        },
      }),
    })

    const action = {
      action: 'create_campaign' as const,
      payload: {
        adAccountId: 'act_123',
        name: 'Test Campaign',
        objective: 'LEAD_GENERATION',
        startPaused: true,
        dailyCeilingMinor: 5000,
      },
    }

    const result = await adapter.execute(action, { tenantId: 'tenant-1' }) as unknown as { error?: { httpStatus: number; message: string; type: string; code: number } }

    expect(result.error).toEqual({
      httpStatus: 400,
      message: 'Invalid parameter',
      type: 'OAuthException',
      code: 100,
    })
  })
})

describe('makeSetCampaignStatusAdapter', () => {
  const fetchMock = vi.fn()
  const adapter = makeSetCampaignStatusAdapter({
    accessToken: 'test-token',
    adAccounts: ['act_123'],
    fetchImpl: fetchMock,
  })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('has the right name', () => {
    expect(adapter.name).toBe('set_campaign_status')
  })

  it('calls the Meta API with the right payload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => ({
        success: true,
      }),
    })

    const action = {
      action: 'set_campaign_status' as const,
      payload: {
        campaignId: '23842653876',
        status: 'ACTIVE',
      },
    }

    const result = await adapter.execute(action, { tenantId: 'tenant-1' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v18.0/23842653876',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      }),
    )

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as Record<string, unknown>).body as string) as Record<string, unknown>
    expect(body.status).toBe('ACTIVE')

    expect(result).toEqual({
      success: true,
      previousStatus: 'PAUSED',
      newStatus: 'ACTIVE',
    })
  })
})

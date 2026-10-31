// src/marketing/meta-ads.ts
// Slice 3 adds two adapters for Meta's Marketing API: create_campaign and
// set_campaign_status. Both call the API using the configured access token and
// store the response in marketing_actions.result. The parent spec section 5
// names the endpoints and the payload shapes.

import type { DerivedAction, ActionContext, MarketingActionAdapter } from './outbox'

export interface MetaAdsConfig {
  accessToken: string
  adAccounts: string[]
  fetchImpl?: typeof fetch
}

export interface MetaApiError {
  httpStatus: number
  message: string
  type?: string
  code?: number
}

export interface CreateCampaignPayload {
  adAccountId: string
  name: string
  objective: string
  startPaused: boolean
  dailyCeilingMinor: number
  audience?: Record<string, unknown>
  placements?: string[]
  budgetLadder?: Array<{ days: number; dailyMinor: number }>
}

export interface CreateCampaignResult {
  externalId: string
  campaignId: string
  accountId: string
  status: string
  createdTime: string
  error?: MetaApiError
}

export class CampaignMustBePausedError extends Error {
  constructor() {
    super('campaign_must_be_paused')
    this.name = 'CampaignMustBePausedError'
  }
}

export class UnknownAdAccountError extends Error {
  constructor(adAccountId: string) {
    super(`unknown_ad_account: ${adAccountId}`)
    this.name = 'UnknownAdAccountError'
  }
}

const META_API_BASE = 'https://graph.facebook.com/v18.0'

export function makeCreateCampaignAdapter(config: MetaAdsConfig): MarketingActionAdapter {
  const fetchImpl = config.fetchImpl ?? fetch

  return {
    name: 'create_campaign',
    async execute(action: DerivedAction, _context: ActionContext): Promise<CreateCampaignResult> {
      const payload = action.payload as unknown as CreateCampaignPayload

      if (!payload.startPaused) {
        throw new CampaignMustBePausedError()
      }

      if (!config.adAccounts.includes(payload.adAccountId)) {
        throw new UnknownAdAccountError(payload.adAccountId)
      }

      const url = `${META_API_BASE}/${payload.adAccountId}/campaigns`
      const body = {
        name: payload.name,
        objective: payload.objective,
        status: 'PAUSED',
        special_ad_categories: [],
      }

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
      })

      const json = (await response.json()) as Record<string, unknown>

      if (!response.ok) {
        const errObj = json.error as Record<string, unknown> | undefined
        return {
          externalId: '',
          campaignId: '',
          accountId: payload.adAccountId,
          status: 'FAILED',
          createdTime: new Date().toISOString(),
          error: {
            httpStatus: response.status,
            message: (errObj?.message as string) ?? 'Unknown error',
            type: errObj?.type as string | undefined,
            code: errObj?.code as number | undefined,
          },
        }
      }

      return {
        externalId: json.id as string,
        campaignId: json.id as string,
        accountId: (json.account_id as string) ?? payload.adAccountId,
        status: (json.status as string) ?? 'PAUSED',
        createdTime: (json.created_time as string) ?? new Date().toISOString(),
      }
    },
  }
}

export interface SetCampaignStatusPayload {
  campaignId: string
  status: 'ACTIVE' | 'PAUSED'
}

export interface SetCampaignStatusResult {
  externalId: string
  success: boolean
  previousStatus: string
  newStatus: string
  error?: MetaApiError
}

export function makeSetCampaignStatusAdapter(config: MetaAdsConfig): MarketingActionAdapter {
  const fetchImpl = config.fetchImpl ?? fetch

  return {
    name: 'set_campaign_status',
    async execute(
      action: DerivedAction,
      _context: ActionContext,
    ): Promise<SetCampaignStatusResult> {
      const payload = action.payload as unknown as SetCampaignStatusPayload

      const url = `${META_API_BASE}/${payload.campaignId}`
      const body = {
        status: payload.status,
      }

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
      })

      const json = (await response.json()) as Record<string, unknown>

      if (!response.ok) {
        const errObj = json.error as Record<string, unknown> | undefined
        return {
          externalId: payload.campaignId,
          success: false,
          previousStatus: 'UNKNOWN',
          newStatus: payload.status,
          error: {
            httpStatus: response.status,
            message: (errObj?.message as string) ?? 'Unknown error',
            type: errObj?.type as string | undefined,
            code: errObj?.code as number | undefined,
          },
        }
      }

      return {
        externalId: payload.campaignId,
        success: (json.success as boolean) ?? true,
        previousStatus: 'PAUSED',
        newStatus: payload.status,
      }
    },
  }
}

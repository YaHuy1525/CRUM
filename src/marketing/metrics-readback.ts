// src/marketing/metrics-readback.ts
// Slice 3 task 5: reads campaign metrics from Meta's Ads Insights API and
// returns the raw response data so the cron job can store snapshots. The spec
// section 8 names the endpoint, query params, and response shape.

import type { MetaApiError } from './meta-ads'

export interface MetricsReadbackConfig {
  accessToken: string
  fetchImpl?: typeof fetch
}

export interface MetricsInsightRow {
  campaign_name: string
  impressions: string
  clicks: string
  spend: string
  actions: Array<{ action_type: string; value: string }>
  date_start: string
  date_stop: string
}

export interface MetricsReadbackResult {
  data: MetricsInsightRow[]
  error?: MetaApiError
}

const META_API_BASE = 'https://graph.facebook.com/v18.0'
const METRICS_FIELDS = 'campaign_name,impressions,clicks,spend,actions,date_start,date_stop'

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function defaultTimeRange(): { since: string; until: string } {
  const until = new Date()
  const since = new Date()
  since.setDate(since.getDate() - 7)
  return { since: formatDate(since), until: formatDate(until) }
}

/**
 * Calls Meta's Ads Insights API for one ad account, returning the raw `data`
 * array from the response. On network failure the error is re-thrown so the
 * caller (the cron job) can log it and exit; on an API-level error the result
 * carries the error object and an empty data array, matching the pattern the
 * other adapters in this directory use.
 */
export async function readCampaignMetrics(
  adAccountId: string,
  config: MetricsReadbackConfig,
  timeRange?: { since: string; until: string },
): Promise<MetricsReadbackResult> {
  const fetchImpl = config.fetchImpl ?? fetch
  const range = timeRange ?? defaultTimeRange()

  const params = new URLSearchParams({
    level: 'campaign',
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    time_increment: '1',
    fields: METRICS_FIELDS,
    access_token: config.accessToken,
  })

  const url = `${META_API_BASE}/act_${adAccountId}/insights?${params.toString()}`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
      },
    })
  } catch (err) {
    throw new Error(
      `metrics_readback_network_error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const json = await response.json()

  if (!response.ok) {
    return {
      data: [],
      error: {
        httpStatus: response.status,
        message: json.error?.message ?? 'Unknown error',
        type: json.error?.type,
        code: json.error?.code,
      },
    }
  }

  return {
    data: json.data ?? [],
  }
}

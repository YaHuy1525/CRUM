
import type {
  AlertActionResponse,
  AlertScanResponse,
  BillingInvoicesResponse,
  BillingProfilesResponse,
  CrmContact,
  CrmFollowup,
  CrmListResponse,
  CrmSchedule,
  CrmTask,
  CustomerRow,
  DigestResponse,
  InvoiceActionResponse,
  MailConnectUrl,
  MailDraftResponse,
  MailStatus,
  MailThreadSearchResponse,
  QueueResponse,
  RevenueOverviewResponse,
  SearchResponse,
  ThreadMessagesResponse,
  ThreadRow,
  ThreadsResponse,
  VideoAlertsResponse,
  VideoChannel,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: string

  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function errorFromBody(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const code =
      typeof record.error === 'string'
        ? record.error
        : typeof record.detail === 'string'
          ? 'request_failed'
          : 'unknown_error'
    const detail =
      typeof record.detail === 'string'
        ? record.detail
        : Array.isArray(record.issues)
          ? record.issues.join('; ')
          : undefined
    if (code === 'unauthorized' && typeof record.reason === 'string') {
      return new ApiError(status, code, `identity rejected (${record.reason})`)
    }
    return new ApiError(status, code, detail)
  }
  return new ApiError(status, 'request_failed', `HTTP ${status}`)
}

function planeUnreachable(path: string, status: number, cause: string): ApiError {
  return new ApiError(
    status,
    'network_unreachable',
    `Could not reach ${path.split('/').slice(0, 3).join('/')}. Is the server on :4113 (REST) / :4111 (chat) running? (${cause})`,
  )
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined ?? {}),
      },
    })
  } catch (err) {
    throw planeUnreachable(path, 0, err instanceof Error ? err.message : String(err))
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let parsed: unknown = null
  let answeredInJson = false
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
      answeredInJson = true
    } catch {
      parsed = { detail: text.slice(0, 300) }
    }
  }

  if (!response.ok) {
    if (!answeredInJson && text.length > 0 && response.status >= 500) {
      throw planeUnreachable(path, response.status, `proxy answered HTTP ${response.status} ${text.slice(0, 80).trim()}`)
    }
    throw errorFromBody(response.status, parsed)
  }
  return parsed as T
}

export const get = <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' })
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers ? { headers } : {}),
  })
export const patch = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, {
    method: 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers ? { headers } : {}),
  })
export const del = <T>(path: string, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, { method: 'DELETE', ...(headers ? { headers } : {}) })

export async function uploadMultipart<T>(path: string, formData: FormData): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: 'POST', body: formData, headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new ApiError(
      0,
      'network_unreachable',
      `Could not reach ${path.split('/').slice(0, 3).join('/')}. Is the server on :4113 (REST) running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }
  const text = await response.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { detail: text.slice(0, 300) }
    }
  }
  if (!response.ok) throw errorFromBody(response.status, parsed)
  return parsed as T
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503 && err.code === 'identity-not-configured') {
      return `${err.detail ?? err.code} — set the console's dev identity and restart \`next dev\`.`
    }
    return err.detail ? `${err.code} (${err.status || 'no response'}): ${err.detail}` : `${err.code} (${err.status || 'no response'})`
  }
  return err instanceof Error ? err.message : String(err)
}


export const listThreads = (): Promise<ThreadsResponse> =>
  get<ThreadsResponse>('/api/agent/threads')

export const getThread = (id: string): Promise<ThreadRow> =>
  get<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`)

export const getThreadMessages = (
  id: string,
  page = 1,
  perPage = 50,
): Promise<ThreadMessagesResponse> =>
  get<ThreadMessagesResponse>(
    `/api/agent/threads/${encodeURIComponent(id)}/messages?page=${page}&perPage=${perPage}`,
  )

export const renameThread = (id: string, title: string): Promise<ThreadRow> =>
  patch<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`, { title, source: 'user' })

export const autoTitleThread = (id: string, title: string): Promise<ThreadRow> =>
  patch<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`, { title, source: 'auto' })

export const deleteThread = (id: string): Promise<{ ok: boolean; id: string }> =>
  del<{ ok: boolean; id: string }>(`/api/agent/threads/${encodeURIComponent(id)}`)

export const searchThreads = (query: string): Promise<SearchResponse> =>
  get<SearchResponse>(`/api/agent/search?query=${encodeURIComponent(query)}`)


function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const serialised = search.toString()
  return serialised ? `?${serialised}` : ''
}

export const listCustomers = (
  params: {
    limit?: number
    offset?: number
    name?: string
    city?: string
    tags?: string[]
  } = {},
): Promise<CrmListResponse<CustomerRow>> =>
  get<CrmListResponse<CustomerRow>>(
    `/api/crm/customers${qs({
      limit: params.limit,
      offset: params.offset,
      name: params.name,
      city: params.city,
      tags: params.tags?.join(','),
    })}`,
  )

export const listContacts = (
  params: { limit?: number; offset?: number; customerId?: string; name?: string } = {},
): Promise<CrmListResponse<CrmContact>> =>
  get<CrmListResponse<CrmContact>>(
    `/api/crm/contacts${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
      name: params.name,
    })}`,
  )

export const listFollowups = (
  params: { limit?: number; offset?: number; customerId?: string } = {},
): Promise<CrmListResponse<CrmFollowup>> =>
  get<CrmListResponse<CrmFollowup>>(
    `/api/crm/followups${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
    })}`,
  )

export const listTasks = (
  params: { limit?: number; offset?: number; customerId?: string } = {},
): Promise<CrmListResponse<CrmTask>> =>
  get<CrmListResponse<CrmTask>>(
    `/api/crm/tasks${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
    })}`,
  )

export const listSchedules = (
  params: {
    limit?: number
    offset?: number
    customerId?: string
    date?: string
    from?: string
    to?: string
  } = {},
): Promise<CrmListResponse<CrmSchedule>> =>
  get<CrmListResponse<CrmSchedule>>(
    `/api/crm/schedules${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
      date: params.date,
      from: params.from,
      to: params.to,
    })}`,
  )

export const getDigest = (date: string): Promise<DigestResponse> =>
  get<DigestResponse>(`/api/digest${qs({ date })}`)

export const listPendingApprovals = (): Promise<QueueResponse> =>
  get<QueueResponse>('/api/approvals/pending')


export const getMailStatus = (): Promise<MailStatus> => get<MailStatus>('/api/mail/status')

export const getMailConnectUrl = (): Promise<MailConnectUrl> =>
  get<MailConnectUrl>('/api/mail/connect-url')

export const searchMailThreads = (q: string, maxResults = 20): Promise<MailThreadSearchResponse> =>
  get<MailThreadSearchResponse>(`/api/mail/threads${qs({ q, maxResults })}`)

export const createMailDraft = (input: {
  to: string
  subject?: string
  body: string
}): Promise<MailDraftResponse> => post<MailDraftResponse>('/api/mail/drafts', input)

// ── Video revenue (Phase 6) ─────────────────────────────────────────────────
//
// Typed wrappers over the /api/video/* routers. Identity headers are injected
// by the Next proxy/middleware, never by these helpers.

export const getRevenueOverview = (
  params: { from?: string; to?: string } = {},
): Promise<RevenueOverviewResponse> =>
  get<RevenueOverviewResponse>(`/api/video/revenue/overview${qs({ from: params.from, to: params.to })}`)

export const listVideoChannels = (
  params: {
    platform?: string
    status?: string
    ownership?: string
    customerId?: string
    limit?: number
    offset?: number
  } = {},
): Promise<CrmListResponse<VideoChannel>> =>
  get<CrmListResponse<VideoChannel>>(
    `/api/video/channels${qs({
      platform: params.platform,
      status: params.status,
      ownership: params.ownership,
      customerId: params.customerId,
      limit: params.limit,
      offset: params.offset,
    })}`,
  )

export const listVideoAlerts = (
  params: { status?: string; channelId?: string; customerId?: string; kind?: string } = {},
): Promise<VideoAlertsResponse> =>
  get<VideoAlertsResponse>(
    `/api/video/alerts${qs({
      status: params.status,
      channelId: params.channelId,
      customerId: params.customerId,
      kind: params.kind,
    })}`,
  )

export const acknowledgeVideoAlert = (id: string): Promise<AlertActionResponse> =>
  post<AlertActionResponse>(`/api/video/alerts/${encodeURIComponent(id)}/acknowledge`)

export const dismissVideoAlert = (id: string): Promise<AlertActionResponse> =>
  post<AlertActionResponse>(`/api/video/alerts/${encodeURIComponent(id)}/dismiss`)

export const scanVideoAlerts = (
  body?: { thresholds: { dropPct: number; spikePct: number } },
): Promise<AlertScanResponse> => post<AlertScanResponse>('/api/video/alerts/scan', body)

export const listBillingProfiles = (
  params: { customerId?: string; active?: boolean } = {},
): Promise<BillingProfilesResponse> =>
  get<BillingProfilesResponse>(
    `/api/video/billing/profiles${qs({
      customerId: params.customerId,
      active: params.active === undefined ? undefined : String(params.active),
    })}`,
  )

export const listBillingInvoices = (
  params: { customerId?: string; status?: string; from?: string; to?: string } = {},
): Promise<BillingInvoicesResponse> =>
  get<BillingInvoicesResponse>(
    `/api/video/billing/invoices${qs({
      customerId: params.customerId,
      status: params.status,
      from: params.from,
      to: params.to,
    })}`,
  )

export const generateBillingInvoice = (input: {
  customerId: string
  periodStart: string
  periodEnd: string
}): Promise<InvoiceActionResponse> => post<InvoiceActionResponse>('/api/video/billing/invoices', input)

export const approveBillingInvoice = (id: string): Promise<InvoiceActionResponse> =>
  post<InvoiceActionResponse>(`/api/video/billing/invoices/${encodeURIComponent(id)}/approve`)

export const issueBillingInvoice = (id: string): Promise<InvoiceActionResponse> =>
  post<InvoiceActionResponse>(`/api/video/billing/invoices/${encodeURIComponent(id)}/issue`)

export const voidBillingInvoice = (id: string): Promise<InvoiceActionResponse> =>
  post<InvoiceActionResponse>(`/api/video/billing/invoices/${encodeURIComponent(id)}/void`)

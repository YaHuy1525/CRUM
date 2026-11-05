// src/chatwoot/client.ts
// Chatwoot REST API adapter. Calls the open-source customer-chat platform's
// API for conversations, messages and contacts. Bearer-token auth, one account
// per deployment, the same shape as the WhatsApp and Twilio adapters.

import type { CrumEnv } from '../config/env'

export class ChatwootApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ChatwootApiError'
    this.status = status
  }
}

export interface ChatwootConfig {
  apiUrl: string      // Chatwoot instance URL
  apiToken: string    // API access token
  accountId: number   // Chatwoot account ID
  inboxId: number     // Default inbox ID
}

export function chatwootConfigured(env: CrumEnv): ChatwootConfig | null {
  if (!env.CRUM_CHATWOOT_URL || !env.CRUM_CHATWOOT_API_TOKEN || !env.CRUM_CHATWOOT_INBOX_ID || !env.CRUM_CHATWOOT_ACCOUNT_ID) return null
  return {
    apiUrl: env.CRUM_CHATWOOT_URL,
    apiToken: env.CRUM_CHATWOOT_API_TOKEN,
    accountId: Number(env.CRUM_CHATWOOT_ACCOUNT_ID),
    inboxId: Number(env.CRUM_CHATWOOT_INBOX_ID),
  }
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export type ConversationStatus = 'open' | 'resolved' | 'pending' | 'snoozed'

export interface ListConversationsParams {
  inboxId?: number
  status?: ConversationStatus
  page?: number
  limit?: number
}

export interface ChatwootContact {
  id: number
  name: string
  email: string
  phone_number: string | null
  company: string | null
  custom_attributes: Record<string, unknown>
}

export interface ChatwootMessage {
  content: string
  message_type: 'outgoing' | 'activity'
}

export interface ChatwootConversation {
  id: number
  status: ConversationStatus
  contact_inbox: {
    contact: {
      id: number
      name: string
      email: string
    }
  }
  messages: Array<{
    id: number
    content: string
    created_at: number
  }>
  created_at: number
}

export interface ListConversationsResponse {
  data: ChatwootConversation[]
  meta: {
    all_count: number
  }
}

export interface SendMessageResponse {
  id: number
  content: string
  message_type: number
  status: string
}

export interface CreateContactResponse {
  payload: {
    contact: ChatwootContact
  }
}

export interface CreateContactData {
  name: string
  email: string
  phone_number?: string
  company?: string
  custom_attributes?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function accountBase(config: ChatwootConfig): string {
  // Strip trailing slash from the API URL so the path join is always clean.
  const base = config.apiUrl.replace(/\/+$/, '')
  return `${base}/api/v1/accounts/${config.accountId}`
}

function authHeaders(config: ChatwootConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
  }
}

async function handleResponse<T>(res: Response, action: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = (json.message ?? json.error ?? `HTTP ${res.status}`) as string
    throw new ChatwootApiError(`chatwoot ${action} failed: ${detail}`, res.status)
  }
  return json as T
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listConversations(
  config: ChatwootConfig,
  params: ListConversationsParams = {},
): Promise<ListConversationsResponse> {
  const searchParams = new URLSearchParams()
  if (params.inboxId != null) searchParams.set('inbox_id', String(params.inboxId))
  else searchParams.set('inbox_id', String(config.inboxId))
  if (params.status) searchParams.set('status', params.status)
  searchParams.set('page', String(params.page ?? 1))
  searchParams.set('limit', String(params.limit ?? 25))

  const url = `${accountBase(config)}/conversations?${searchParams.toString()}`
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(config),
  })

  return handleResponse<ListConversationsResponse>(res, 'list conversations')
}

export async function sendMessage(
  config: ChatwootConfig,
  conversationId: number,
  message: ChatwootMessage,
): Promise<SendMessageResponse> {
  const url = `${accountBase(config)}/conversations/${conversationId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      content: message.content,
      message_type: message.message_type === 'activity' ? 2 : 1,
    }),
  })

  return handleResponse<SendMessageResponse>(res, 'send message')
}

export async function createContact(
  config: ChatwootConfig,
  contactData: CreateContactData,
): Promise<CreateContactResponse> {
  const url = `${accountBase(config)}/contacts`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      name: contactData.name,
      email: contactData.email,
      phone_number: contactData.phone_number,
      company: contactData.company,
      custom_attributes: contactData.custom_attributes,
    }),
  })

  return handleResponse<CreateContactResponse>(res, 'create contact')
}

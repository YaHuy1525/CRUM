import type { CrumEnv } from '../config/env'
import {
  GmailApiError,
  getAccessToken,
  gmailOAuthConfigured,
  insertMailMessage,
  listWatchConnections,
  searchInboundMessages,
} from './client'
import type { GmailConnectionRow, InboundMessage, Queryable } from './client'

export interface WatchPassDeps {
  env: CrumEnv
  pool?: Queryable
  listConnections?: (pool?: Queryable) => Promise<GmailConnectionRow[]>
  fetchPage?: (
    accessToken: string,
    query: string,
    maxResults: number,
    pageToken?: string,
  ) => Promise<{ messages: InboundMessage[]; nextPageToken?: string }>
  insertMessage?: (
    message: InboundMessage,
    owner: { tenantId: string; userId: string; gmailEmail: string },
    pool?: Queryable,
  ) => Promise<boolean>
}

export interface WatchConnectionResult {
  tenantId: string
  userId: string
  email: string
  inserted: number
  pages: number
  error?: string
}

export interface WatchPassResult {
  ranAt: string
  query: string
  results: WatchConnectionResult[]
}

export async function runWatchPass(
  deps: WatchPassDeps,
  options: { query?: string; pageSize?: number; maxPages?: number; tenantId?: string } = {},
): Promise<WatchPassResult> {
  const query = options.query ?? 'in:inbox'
  const pageSize = options.pageSize ?? 25
  const maxPages = options.maxPages ?? 4

  const listConnections = deps.listConnections ?? listWatchConnections
  const fetchPage = deps.fetchPage ?? searchInboundMessages
  const insertMessage = deps.insertMessage ?? insertMailMessage

  const connections = await listConnections(deps.pool)
  const targets = options.tenantId ? connections.filter((c) => c.tenant_id === options.tenantId) : connections
  const creds = gmailOAuthConfigured(deps.env)

  const results: WatchConnectionResult[] = []
  for (const row of targets) {
    const outcome: WatchConnectionResult = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      email: row.gmail_email,
      inserted: 0,
      pages: 0,
    }
    results.push(outcome)

    if (!creds) {
      outcome.error = 'gmail connector not configured'
      continue
    }

    let accessToken: string
    try {
      accessToken = await getAccessToken(row, creds.clientId, creds.clientSecret)
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err)
      continue
    }

    try {
      let pageToken: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const batch = await fetchPage(accessToken, query, pageSize, pageToken)
        outcome.pages++
        let freshOnPage = 0
        for (const message of batch.messages) {
          const insertedRow = await insertMessage(
            message,
            { tenantId: row.tenant_id, userId: row.user_id, gmailEmail: row.gmail_email },
            deps.pool,
          )
          if (insertedRow) freshOnPage++
        }
        outcome.inserted += freshOnPage
        if (freshOnPage === 0 || !batch.nextPageToken) break
        pageToken = batch.nextPageToken
      }
    } catch (err) {
      const prefix = err instanceof GmailApiError ? 'gmail api' : 'watch pass'
      outcome.error = `${prefix} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return { ranAt: new Date().toISOString(), query, results }
}

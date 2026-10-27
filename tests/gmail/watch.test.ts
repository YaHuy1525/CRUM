// tests/gmail/watch.test.ts
//
// The poller core, exercised through its injected seams. getAccessToken is the
// one collaborator that is NOT injectable (it is the real refresh path), so the
// happy rows carry a genuinely-encrypted refresh token and fetch is stubbed to
// mint an access token; the failure rows carry a corrupt ciphertext that
// throws before any socket is opened. Either way the test never reaches Google.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrumEnv } from '../../src/config/env'
import { runWatchPass } from '../../src/gmail/watch'
import { clearAccessTokenCache } from '../../src/gmail/client'
import type { GmailConnectionRow, InboundMessage } from '../../src/gmail/client'
import { encryptRefreshToken } from '../../src/gmail/crypto'

const SECRET = 'r'.repeat(40)
const TENANT_A = '550e8400-e29b-41d4-a716-446655440000'
const USER_A = 'aaaaaaaa-2222-4333-8444-555555555555'
const TENANT_B = '660e8400-e29b-41d4-a716-446655440001'
const USER_B = 'bbbbbbbb-2222-4333-8444-555555555555'

const env = {
  GMAIL_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
  APPROVAL_HMAC_SECRET: SECRET,
  DATABASE_URL: 'postgres://ignored-in-tests',
} as unknown as CrumEnv

/** A watchable connection whose stored token decrypts with SECRET. */
function liveRow(tenantId: string, userId: string, email: string): GmailConnectionRow {
  return {
    id: email,
    tenant_id: tenantId,
    user_id: userId,
    gmail_email: email,
    refresh_token_enc: encryptRefreshToken('1//refresh', SECRET),
    scopes: 'gmail.readonly gmail.compose',
    watch: true,
  }
}

/** A connection whose ciphertext cannot be decrypted: refresh throws pre-network. */
function deadRow(tenantId: string, userId: string, email: string): GmailConnectionRow {
  return { ...liveRow(tenantId, userId, email), refresh_token_enc: 'garbage-not-ciphertext' }
}

function message(id: string): InboundMessage {
  return {
    id,
    threadId: `t-${id}`,
    subject: `Mail ${id}`,
    senders: ['a@x.com'],
    recipients: ['me@x.com'],
    snippet: 'hi',
    date: 'Mon, 26 Oct 2026',
    receivedAt: '2026-10-26T09:00:00.000Z',
  }
}

/** Access-token mint for the live rows; anything else is a test failure to route. */
function stubTokenFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ access_token: 'ya29.test', expires_in: 3600 }), text: () => Promise.resolve('') })
      }
      return Promise.reject(new Error(`watch test did not expect a fetch to ${url}`))
    }),
  )
}

beforeEach(() => {
  vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
  clearAccessTokenCache(TENANT_A, USER_A)
  clearAccessTokenCache(TENANT_B, USER_B)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('runWatchPass', () => {
  it('mirrors new messages and stops at the frontier (a page with nothing new)', async () => {
    stubTokenFetch()
    const seen = new Set<string>()
    const fetchPage = vi.fn((_t: string, _q: string, _n: number, pageToken?: string) => {
      // Page 1 is all-new; page 2 repeats page 1's ids, so it contributes nothing.
      const messages = pageToken ? [message('m1'), message('m2')] : [message('m1'), message('m2'), message('m3')]
      return Promise.resolve({ messages, ...(pageToken ? {} : { nextPageToken: 'p2' }) })
    })
    const insertMessage = vi.fn((m: InboundMessage) => {
      if (seen.has(m.id)) return Promise.resolve(false)
      seen.add(m.id)
      return Promise.resolve(true)
    })

    const pass = await runWatchPass(
      { env, listConnections: () => Promise.resolve([liveRow(TENANT_A, USER_A, 'a@gmail.example')]), fetchPage, insertMessage },
      { query: 'in:inbox', pageSize: 3, maxPages: 5 },
    )

    expect(pass.query).toBe('in:inbox')
    expect(pass.results).toHaveLength(1)
    const only = pass.results[0]!
    expect(only).toMatchObject({ email: 'a@gmail.example', inserted: 3, pages: 2 })
    expect(only.error).toBeUndefined()
    // Exactly two fetches: the second page is all-known, so paging halts there.
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(fetchPage.mock.calls[1]?.[3]).toBe('p2')
  })

  it('records a dead mailbox as an error and still polls the healthy one', async () => {
    stubTokenFetch()
    const fetchPage = vi.fn(() => Promise.resolve({ messages: [message('m1')] }))
    const insertMessage = vi.fn(() => Promise.resolve(true))

    const pass = await runWatchPass(
      {
        env,
        listConnections: () => Promise.resolve([
          deadRow(TENANT_A, USER_A, 'dead@gmail.example'),
          liveRow(TENANT_B, USER_B, 'alive@gmail.example'),
        ]),
        fetchPage,
        insertMessage,
      },
      {},
    )

    expect(pass.results).toHaveLength(2)
    const [dead, alive] = pass.results
    expect(dead!).toMatchObject({ email: 'dead@gmail.example', inserted: 0 })
    expect(dead!.error).toBeTruthy()
    expect(alive!).toMatchObject({ email: 'alive@gmail.example', inserted: 1 })
    expect(alive!.error).toBeUndefined()
    // The dead mailbox never reached the API, only the live one did.
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('honours the tenant filter, polling only that tenant’s mailboxes', async () => {
    stubTokenFetch()
    const fetchPage = vi.fn(() => Promise.resolve({ messages: [] }))
    const insertMessage = vi.fn(() => Promise.resolve(true))

    const pass = await runWatchPass(
      {
        env,
        listConnections: () => Promise.resolve([
          liveRow(TENANT_A, USER_A, 'a@gmail.example'),
          liveRow(TENANT_B, USER_B, 'b@gmail.example'),
        ]),
        fetchPage,
        insertMessage,
      },
      { tenantId: TENANT_B },
    )

    expect(pass.results.map((r) => r.email)).toEqual(['b@gmail.example'])
  })

  it('reports connector-not-configured without touching the mailbox', async () => {
    const unconfigured = { APPROVAL_HMAC_SECRET: SECRET } as unknown as CrumEnv
    const fetchPage = vi.fn()
    const pass = await runWatchPass(
      { env: unconfigured, listConnections: () => Promise.resolve([liveRow(TENANT_A, USER_A, 'a@gmail.example')]), fetchPage, insertMessage: vi.fn() },
      {},
    )
    expect(pass.results[0]!.error).toMatch(/not configured/)
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

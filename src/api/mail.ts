import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import type { TenantRequestContext } from '../mastra/tenant-context'
import {
  GmailApiError,
  buildConsentUrl,
  clearAccessTokenCache,
  createState,
  createGmailDraft,
  gmailOAuthConfigured,
  loadConnection,
  searchThreadSummaries,
} from '../gmail/client'
import type { GmailConnectionRow } from '../gmail/client'
import { getAccessToken } from '../gmail/client'
import { GmailCryptoError } from '../gmail/crypto'

export interface MailRouterDeps {
  env: CrumEnv
}

const ThreadQuery = z.object({
  q: z.string().trim().min(1).max(500),
  maxResults: z.coerce.number().int().min(1).max(50).default(20),
})

const DraftInput = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().trim().max(500).default(''),
  body: z.string().trim().min(1).max(64_000),
})

type IdentityOrError = { identity: TenantRequestContext } | { error: Response }

type AccessOrError = { accessToken: string; row: GmailConnectionRow } | { error: Response }

export function createMailRouter(deps: MailRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/mail')

  const identity = async (c: Context): Promise<IdentityOrError> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  const access = async (c: Context, who: TenantRequestContext): Promise<AccessOrError> => {
    const creds = gmailOAuthConfigured(env)
    if (!creds) {
      return { error: c.json({ error: 'gmail-not-configured', detail: 'Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET.' }, 503) }
    }
    const row = await loadConnection(who.tenantId, who.userId)
    if (!row) {
      return { error: c.json({ error: 'not_connected', detail: 'No Gmail mailbox is connected for this user.' }, 404) }
    }
    try {
      return { accessToken: await getAccessToken(row, creds.clientId, creds.clientSecret), row }
    } catch (err) {
      clearAccessTokenCache(who.tenantId, who.userId)
      const reason = err instanceof GmailCryptoError ? 'stored credentials are corrupt' : 'token refresh failed'
      return {
        error: c.json(
          { error: 'reconnect_required', detail: `Stored Gmail access could not be used (${reason}): ${err instanceof Error ? err.message : String(err)}` },
          503,
        ),
      }
    }
  }

  const handleGmailError = (c: Context, err: unknown): Response => {
    const detail = err instanceof Error ? err.message : String(err)
    const status = err instanceof GmailApiError && err.status >= 400 && err.status < 500 ? 400 : 502
    return c.json({ error: 'gmail_api_failed', detail }, status)
  }

  app.get('/status', async (c) => {
    const who = await identity(c)
    if ('error' in who) return who.error

    const creds = gmailOAuthConfigured(env)
    if (!creds) {
      return c.json({ configured: false, connected: false, detail: 'Gmail connector not configured (GMAIL_OAUTH_CLIENT_ID / SECRET).' })
    }
    const row = await loadConnection(who.identity.tenantId, who.identity.userId)
    return c.json({
      configured: true,
      connected: row !== null,
      ...(row ? { email: row.gmail_email, scopes: row.scopes } : {}),
    })
  })

  app.get('/connect-url', async (c) => {
    const who = await identity(c)
    if ('error' in who) return who.error

    const creds = gmailOAuthConfigured(env)
    const secret = env.APPROVAL_HMAC_SECRET
    if (!creds || !secret) {
      return c.json({ error: 'gmail-not-configured', detail: 'Set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and APPROVAL_HMAC_SECRET.' }, 503)
    }
    const state = createState(who.identity.tenantId, who.identity.userId, secret)
    return c.json({ url: buildConsentUrl(creds, state), redirectUri: creds.redirectUri })
  })

  app.get('/threads', async (c) => {
    const who = await identity(c)
    if ('error' in who) return who.error

    const parsed = ThreadQuery.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'q is required', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }

    const tok = await access(c, who.identity)
    if ('error' in tok) return tok.error
    try {
      const threads = await searchThreadSummaries(tok.accessToken, parsed.data.q, parsed.data.maxResults)
      return c.json({ query: parsed.data.q, threads })
    } catch (err) {
      return handleGmailError(c, err)
    }
  })

  app.get('/threads/:id', async (c) => {
    const id = c.req.param('id') ?? ''
    if (!/^\d{8,25}$/.test(id)) {
      return c.json({ error: 'invalid_thread_id' }, 400)
    }

    const who = await identity(c)
    if ('error' in who) return who.error

    const tok = await access(c, who.identity)
    if ('error' in tok) return tok.error
    try {
      const threads = await searchThreadSummaries(tok.accessToken, `thread:${id}`, 1)
      const thread = threads.find((t) => t.id === id) ?? threads[0]
      if (!thread) return c.json({ error: 'thread_not_found' }, 404)
      return c.json(thread)
    } catch (err) {
      return handleGmailError(c, err)
    }
  })

  app.post('/drafts', async (c) => {
    const who = await identity(c)
    if ('error' in who) return who.error

    const parsed = DraftInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'to and body are required', detail: parsed.error.issues.map((i) => i.message) }, 400)
    }

    const tok = await access(c, who.identity)
    if ('error' in tok) return tok.error
    try {
      const draft = await createGmailDraft(tok.accessToken, parsed.data)
      return c.json({
        draftId: draft.id,
        url: `https://mail.google.com/mail/#drafts/${encodeURIComponent(draft.id)}`,
      })
    } catch (err) {
      return handleGmailError(c, err)
    }
  })

  return app
}

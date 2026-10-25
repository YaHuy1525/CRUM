// src/api/gmail.ts
//
// The two HTTP halves of the Gmail OAuth flow, registered as Mastra custom
// api routes (they ride the same server as /chat/crm, so the redirect URI is
// the port the Mastra server listens on — 4111 by default).
//
//   GET /gmail/connect?tenantId=<uuid>&userId=<uuid>
//       → 302 to Google's consent screen. The tenant/user pair travels in a
//         HMAC-signed, expiring `state`, so the callback can attribute the
//         incoming code without a server-side session (Context7 of §13.8:
//         identity that cannot be verified at request time must fail closed —
//         an unverifiable state is a hard 400, never a "default tenant").
//
//   GET /gmail/callback?code=...&state=...
//       → verifies state, exchanges the code, learns the mailbox address from
//         the fresh token, stores the refresh token encrypted, and answers a
//         minimal HTML page (this response is browser-facing).
//
// `requiresAuth: false` on both: Google's redirect cannot present Mastra's own
// auth, and the browser clicking "connect" is the same user whose identity is
// already carried (and signed) in the state parameter.
//
// The paths sit at the TOP level, NOT under `/api`: @mastra/server reserves the
// built-in apiPrefix and validateCustomRoutePaths throws at boot for any custom
// route starting with it (see DEFAULT_REDIRECT_URI in src/gmail/client.ts).
import { registerApiRoute } from '@mastra/core/server'
import type { ApiRoute } from '@mastra/core/server'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import {
  buildConsentUrl,
  createState,
  exchangeCodeForTokens,
  fetchProfileEmail,
  gmailOAuthConfigured,
  readState,
  saveConnection,
} from '../gmail/client'

const uuid = z.string().uuid()

/** The identity secret for state signing. Reuses APPROVAL_HMAC_SECRET (HKDF-domain-separated). */
function requireStateSecret(env: CrumEnv): string | null {
  return env.APPROVAL_HMAC_SECRET ?? null
}

export function createGmailConnectRoute(env: CrumEnv): ApiRoute {
  return registerApiRoute('/gmail/connect', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      const creds = gmailOAuthConfigured(env)
      const secret = requireStateSecret(env)
      if (!creds || !secret) {
        return c.json(
          { error: 'Gmail connector not configured: set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and APPROVAL_HMAC_SECRET.' },
          503,
        )
      }
      const tenantId = uuid.safeParse(c.req.query('tenantId'))
      const userId = uuid.safeParse(c.req.query('userId'))
      if (!tenantId.success || !userId.success) {
        return c.json({ error: 'tenantId and userId query params must be UUIDs' }, 400)
      }
      const state = createState(tenantId.data, userId.data, secret)
      return c.redirect(buildConsentUrl(creds, state))
    },
  })
}

export function createGmailCallbackRoute(env: CrumEnv): ApiRoute {
  return registerApiRoute('/gmail/callback', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      const creds = gmailOAuthConfigured(env)
      const secret = requireStateSecret(env)
      if (!creds || !secret) {
        return c.json({ error: 'Gmail connector not configured' }, 503)
      }

      // Google sends `error` instead of `code` when the user clicks Cancel or
      // consent was blocked; there is nothing to store, so stop here.
      const googleError = c.req.query('error')
      const code = c.req.query('code')
      const state = c.req.query('state')
      if (googleError || !code || !state) {
        return c.html(resultPage(false, 'Google did not grant access. No connection was made.'), 400)
      }

      const verified = readState(state, secret)
      if (!verified) {
        return c.html(resultPage(false, 'The login attempt expired or was tampered with. Start again from /gmail/connect.'), 400)
      }

      try {
        const { refreshToken, accessToken } = await exchangeCodeForTokens(creds, code)
        const gmailEmail = await fetchProfileEmail(accessToken)
        await saveConnection({
          tenantId: verified.tenantId,
          userId: verified.userId,
          gmailEmail,
          refreshToken,
          scopes: 'gmail.readonly gmail.compose',
        })
        return c.html(resultPage(true, `Connected ${gmailEmail}. CRUM can now search this mailbox and create drafts. Nothing is ever sent without approval.`))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.html(resultPage(false, `Connecting failed: ${message}`), 500)
      }
    },
  })
}

/** Tiny self-contained HTML: this page is the only browser-facing output. */
function resultPage(success: boolean, message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>CRUM Gmail</title></head>
<body style="font-family:system-ui;margin:3rem auto;max-width:34rem">
<h1 style="font-size:1.25rem">${success ? 'Gmail connected' : 'Gmail not connected'}</h1>
<p>${safe}</p>
</body></html>`
}

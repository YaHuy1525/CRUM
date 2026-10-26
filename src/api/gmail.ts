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

function requireStateSecret(env: CrumEnv): string | null {
  return env.APPROVAL_HMAC_SECRET ?? null
}

export function createGmailConnectRoute(env: CrumEnv): ApiRoute {
  return registerApiRoute('/gmail/connect', {
    method: 'GET',
    requiresAuth: false,
    handler: (c) => {
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

function resultPage(success: boolean, message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>CRUM Gmail</title></head>
<body style="font-family:system-ui;margin:3rem auto;max-width:34rem">
<h1 style="font-size:1.25rem">${success ? 'Gmail connected' : 'Gmail not connected'}</h1>
<p>${safe}</p>
</body></html>`
}

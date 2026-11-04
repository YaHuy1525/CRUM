import { describe, it, expect, vi, afterEach } from 'vitest'
import { twilioConfigured, sendSms } from '../../src/sms/twilio'
import { whatsappConfigured, sendWhatsAppMessage } from '../../src/whatsapp/cloud'
import { linkedinConfigured, createLinkedInPost } from '../../src/social/linkedin'
import {
  webhookConfigured,
  deliverWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../src/webhooks/outbound'
import { createCalendarEvent } from '../../src/calendar/google'
import type { CrumEnv } from '../../src/config/env'

// The tier-2/3 clients are pure REST: the tests stub global fetch and assert
// the request a provider would actually receive — URL, auth header, body
// shape — because that is the contract, and the contract is what breaks.
type FetchCall = { url: string; init: RequestInit }

/** noUncheckedIndexedAccess makes calls[0] possibly undefined; this names that check once. */
function firstCall(calls: FetchCall[]): FetchCall {
  if (!calls[0]) throw new Error('expected a fetch call, got none')
  return calls[0]
}

function stubFetch(response: { status?: number; json?: unknown; body?: string }): {
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return Promise.resolve(
        new Response(JSON.stringify(response.json ?? {}), {
          status: response.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  return { calls }
}

function envWith(overrides: Partial<Record<string, string>> = {}): CrumEnv {
  const base = {
    CRUM_TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32),
    CRUM_TWILIO_AUTH_TOKEN: 'auth-token-123456',
    CRUM_TWILIO_FROM_NUMBER: '+61400000000',
    CRUM_WHATSAPP_TOKEN: 'wa-token-1234567890',
    CRUM_WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    CRUM_LINKEDIN_ACCESS_TOKEN: 'li-token-1234567890',
    CRUM_LINKEDIN_AUTHOR_URN: 'urn:li:person:abc123',
    CRUM_WEBHOOK_URL: 'https://hooks.example.test/crum',
    CRUM_WEBHOOK_SECRET: 'whsec-1234567890',
    ...overrides,
  }
  return base as unknown as CrumEnv
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('twilioConfigured', () => {
  it('needs all three settings', () => {
    expect(twilioConfigured(envWith())).not.toBeNull()
    expect(twilioConfigured(envWith({ CRUM_TWILIO_FROM_NUMBER: '' }))).toBeNull()
    expect(twilioConfigured(envWith({ CRUM_TWILIO_ACCOUNT_SID: '' }))).toBeNull()
  })
})

describe('sendSms', () => {
  it('posts the form the Twilio API expects, with Basic auth', async () => {
    const { calls } = stubFetch({ json: { sid: 'SM123', status: 'queued', to: '+61411111111' } })
    const result = await sendSms(twilioConfigured(envWith())!, { to: '+61411111111', body: 'hi' })
    expect(result).toEqual({ sid: 'SM123', status: 'queued', to: '+61411111111' })
    expect(calls).toHaveLength(1)
    expect(firstCall(calls).url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${'AC' + '1'.repeat(32)}/Messages.json`,
    )
    const auth = String((firstCall(calls).init.headers as Record<string, string>).Authorization)
    expect(auth).toMatch(/^Basic /)
    const body = String(firstCall(calls).init.body as string)
    expect(body).toContain('To=%2B61411111111')
    expect(body).toContain('Body=hi')
  })

  it('throws with the provider message on a 400', async () => {
    stubFetch({ status: 400, json: { message: 'Invalid parameter' } })
    await expect(
      sendSms(twilioConfigured(envWith())!, { to: '+61411111111', body: 'hi' }),
    ).rejects.toThrow(/Invalid parameter/)
  })
})

describe('whatsappConfigured', () => {
  it('needs both settings', () => {
    expect(whatsappConfigured(envWith())).not.toBeNull()
    expect(whatsappConfigured(envWith({ CRUM_WHATSAPP_PHONE_NUMBER_ID: '' }))).toBeNull()
  })
})

describe('sendWhatsAppMessage', () => {
  it('sends the cloud-api text shape to the phone-number path', async () => {
    const { calls } = stubFetch({ json: { messages: [{ id: 'wamid.1' }] } })
    const result = await sendWhatsAppMessage(whatsappConfigured(envWith())!, {
      to: '61411111111',
      body: 'hello',
    })
    expect(result).toEqual({ messageId: 'wamid.1', to: '61411111111' })
    expect(firstCall(calls).url).toBe('https://graph.facebook.com/v21.0/1234567890/messages')
    const body = JSON.parse(String(firstCall(calls).init.body as string)) as Record<string, unknown>
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.recipient_type).toBe('individual')
    expect(body.to).toBe('61411111111')
    expect(body.type).toBe('text')
  })

  it('refuses a malformed phone number id before any fetch', async () => {
    const { calls } = stubFetch({})
    const config = { token: 't', phoneNumberId: '../users/me' }
    await expect(sendWhatsAppMessage(config, { to: '61411111111', body: 'hi' })).rejects.toThrow(
      /phone number id/,
    )
    expect(calls).toHaveLength(0)
  })
})

describe('linkedinConfigured', () => {
  it('needs both settings', () => {
    expect(linkedinConfigured(envWith())).not.toBeNull()
    expect(linkedinConfigured(envWith({ CRUM_LINKEDIN_AUTHOR_URN: '' }))).toBeNull()
  })
})

describe('createLinkedInPost', () => {
  it('builds the ugcPosts share body for a member author', async () => {
    const { calls } = stubFetch({ json: { id: 'urn:li:share:1' } })
    const result = await createLinkedInPost(linkedinConfigured(envWith())!, { text: 'launch day' })
    expect(result).toEqual({ postId: 'urn:li:share:1' })
    expect(firstCall(calls).url).toBe('https://api.linkedin.com/v2/ugcPosts')
    const headers = firstCall(calls).init.headers as Record<string, string>
    expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0')
    const body = JSON.parse(String(firstCall(calls).init.body as string)) as {
      author: string
      specificContent: Record<string, { shareMediaCategory: string }>
      visibility: Record<string, string>
    }
    expect(body.author).toBe('urn:li:person:abc123')
    expect(body.specificContent['com.linkedin.ugc.ShareContent']?.shareMediaCategory).toBe('NONE')
    expect(body.visibility).toHaveProperty('com.linkedin.ugc.MemberNetworkVisibility')
  })

  it('rejects a malformed author urn before any fetch', async () => {
    const { calls } = stubFetch({})
    await expect(
      createLinkedInPost({ accessToken: 't', authorUrn: 'not-a-urn' }, { text: 'x' }),
    ).rejects.toThrow(/AUTHOR_URN/)
    expect(calls).toHaveLength(0)
  })
})

describe('webhook signature contract', () => {
  it('signs "<timestamp>.<body>" with hmac-sha256 hex', () => {
    const sig = signWebhookPayload('secret', 1700000000, '{"a":1}')
    // deterministic: same inputs, same hex
    expect(sig).toBe(signWebhookPayload('secret', 1700000000, '{"a":1}'))
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    // a different timestamp or body changes the signature
    expect(sig).not.toBe(signWebhookPayload('secret', 1700000001, '{"a":1}'))
    expect(sig).not.toBe(signWebhookPayload('secret', 1700000000, '{"a":2}'))
  })

  it('verify accepts a fresh header and rejects a tampered body', () => {
    const body = JSON.stringify({ event: 'lead.received' })
    const t = Math.floor(Date.now() / 1000)
    const header = `t=${t},v1=${signWebhookPayload('secret', t, body)}`
    expect(verifyWebhookSignature(body, header, 'secret')).toBe(true)
    expect(verifyWebhookSignature(body + 'x', header, 'secret')).toBe(false)
    expect(verifyWebhookSignature(body, 'garbage', 'secret')).toBe(false)
    expect(verifyWebhookSignature(body, header, 'wrong')).toBe(false)
  })
})

describe('deliverWebhook', () => {
  it('posts the payload with a verifiable signature header', async () => {
    const { calls } = stubFetch({ status: 200, json: { ok: true } })
    const config = webhookConfigured(envWith())!
    const delivery = await deliverWebhook(config, { event: 'lead.received', data: { leadId: 'l1' } })

    expect(calls).toHaveLength(1)
    expect(firstCall(calls).url).toBe('https://hooks.example.test/crum')
    const header = String((firstCall(calls).init.headers as Record<string, string>)['X-CRUM-Signature'])
    // the receiver-side check, run on the exact bytes that went out
    expect(verifyWebhookSignature(delivery.body, header, config.secret)).toBe(true)
  })

  it('throws with the receiver status on failure', async () => {
    stubFetch({ status: 500, json: { ok: false }, body: 'nope' })
    await expect(
      deliverWebhook(webhookConfigured(envWith())!, { event: 'x', data: {} }),
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('createCalendarEvent', () => {
  it('posts the event to the primary calendar without inviting anyone', async () => {
    const { calls } = stubFetch({
      json: { id: 'evt_1', htmlLink: 'https://calendar.google.test/evt_1' },
    })
    const result = await createCalendarEvent('token', {
      summary: 'Kickoff',
      startIso: '2026-11-05T09:00:00+11:00',
      endIso: '2026-11-05T10:00:00+11:00',
      attendeeEmails: ['a@example.test'],
    })
    expect(result).toEqual({ id: 'evt_1', htmlLink: 'https://calendar.google.test/evt_1' })
    expect(firstCall(calls).url).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    const body = JSON.parse(String(firstCall(calls).init.body as string)) as Record<string, unknown>
    expect(body.summary).toBe('Kickoff')
    expect(body.start).toEqual({ dateTime: '2026-11-05T09:00:00+11:00' })
    expect(body.attendees).toEqual([{ email: 'a@example.test' }])
  })

  it('throws the calendar error message on a 400', async () => {
    stubFetch({ status: 400, json: { error: { message: 'Bad start' } } })
    await expect(
      createCalendarEvent('token', {
        summary: 'x',
        startIso: '2026-11-05T09:00:00+11:00',
        endIso: '2026-11-05T10:00:00+11:00',
      }),
    ).rejects.toThrow(/Bad start/)
  })
})

// src/sms/twilio.ts
// SMS through the Twilio REST API, no SDK: one form-encoded POST per message
// with HTTP Basic auth. All three settings are required — a from-number is the
// one thing that cannot be defaulted, because sending from the wrong number is
// not an error, it is a wrong text message.

import type { CrumEnv } from '../config/env'

const TWILIO_API_ROOT = 'https://api.twilio.com/2010-04-01'

export class TwilioError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TwilioError'
    this.status = status
  }
}

export interface TwilioConfig {
  accountSid: string
  authToken: string
  fromNumber: string
}

export function twilioConfigured(env: CrumEnv): TwilioConfig | null {
  if (!env.CRUM_TWILIO_ACCOUNT_SID || !env.CRUM_TWILIO_AUTH_TOKEN || !env.CRUM_TWILIO_FROM_NUMBER) {
    return null
  }
  return {
    accountSid: env.CRUM_TWILIO_ACCOUNT_SID,
    authToken: env.CRUM_TWILIO_AUTH_TOKEN,
    fromNumber: env.CRUM_TWILIO_FROM_NUMBER,
  }
}

export interface SmsResult {
  sid: string
  status: string
  to: string
}

export async function sendSms(config: TwilioConfig, message: { to: string; body: string }): Promise<SmsResult> {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')
  const res = await fetch(`${TWILIO_API_ROOT}/Accounts/${config.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: message.to,
      From: config.fromNumber,
      Body: message.body,
    }).toString(),
  })

  const json = (await res.json().catch(() => ({}))) as {
    sid?: string
    status?: string
    to?: string
    message?: string
  }
  if (!res.ok || !json.sid) {
    throw new TwilioError(
      `twilio messages.create failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return { sid: json.sid, status: json.status ?? 'queued', to: json.to ?? message.to }
}

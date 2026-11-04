// src/whatsapp/cloud.ts
// WhatsApp Business Cloud API (Meta Graph). One Bearer-token POST per text
// message, the same auth family as the Meta Ads adapters already in the repo,
// so one Meta developer app with the whatsapp product covers it. No session,
// no QR, no SDK.

import type { CrumEnv } from '../config/env'

const GRAPH_API_ROOT = 'https://graph.facebook.com/v21.0'

export class WhatsAppError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WhatsAppError'
    this.status = status
  }
}

export interface WhatsAppConfig {
  token: string
  phoneNumberId: string
}

export function whatsappConfigured(env: CrumEnv): WhatsAppConfig | null {
  if (!env.CRUM_WHATSAPP_TOKEN || !env.CRUM_WHATSAPP_PHONE_NUMBER_ID) return null
  return {
    token: env.CRUM_WHATSAPP_TOKEN,
    phoneNumberId: env.CRUM_WHATSAPP_PHONE_NUMBER_ID,
  }
}

export interface WhatsAppSendResult {
  messageId: string
  to: string
}

export async function sendWhatsAppMessage(
  config: WhatsAppConfig,
  message: { to: string; body: string },
): Promise<WhatsAppSendResult> {
  // The phone-number id is a config value, not user input, but it is interpolated
  // into the path, so it is shape-checked before it goes anywhere near a URL.
  if (!/^\d{3,20}$/.test(config.phoneNumberId)) {
    throw new WhatsAppError('CRUM_WHATSAPP_PHONE_NUMBER_ID must be a numeric phone number id', 400)
  }

  const res = await fetch(`${GRAPH_API_ROOT}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      text: { body: message.body },
    }),
  })

  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[]
    error?: { message?: string }
  }
  if (!res.ok || !json.messages?.[0]?.id) {
    throw new WhatsAppError(
      `whatsapp messages.send failed: ${json.error?.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return { messageId: json.messages[0].id, to: message.to }
}

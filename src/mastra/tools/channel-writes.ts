// src/mastra/tools/channel-writes.ts
// The tier-2/3 outbound channels: Google Calendar events, generic webhooks,
// Twilio SMS, WhatsApp text, LinkedIn posts. Every one of them reaches a
// person or a system outside this process, so every one requires approval —
// a scheduled event that quietly re-books a customer's afternoon is the same
// class of mistake as a text message nobody signed off on.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { parseEnv } from '../../config/env'
import { scheduleCalendarEvent } from '../../calendar/google'
import { deliverWebhook, webhookConfigured } from '../../webhooks/outbound'
import { sendSms, twilioConfigured } from '../../sms/twilio'
import { sendWhatsAppMessage, whatsappConfigured } from '../../whatsapp/cloud'
import { createLinkedInPost, linkedinConfigured } from '../../social/linkedin'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

const IsoDatetime = z.string().datetime({ offset: true })

const CalendarEventOutputSchema = z.object({
  eventId: z.string(),
  htmlLink: z.string(),
})

const WebhookOutputSchema = z.object({
  delivered: z.boolean(),
  status: z.number(),
  signature: z.string(),
})

const SmsOutputSchema = z.object({
  sid: z.string(),
  status: z.string(),
  to: z.string(),
})

const WhatsAppOutputSchema = z.object({
  messageId: z.string(),
  to: z.string(),
})

const LinkedInOutputSchema = z.object({
  postId: z.string(),
})

export const createCalendarEventTool = createTool({
  id: 'calendar.create_event',
  title: 'Create Calendar Event',
  description:
    'Create an event on the connected user\'s primary Google Calendar. Uses the Gmail connector\'s OAuth; the calendar scope must be granted by consent. Requires the Gmail connector to be configured and connected.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    summary: z.string().trim().min(1).max(200),
    startIso: IsoDatetime.describe('Event start as an ISO 8601 datetime with timezone offset'),
    endIso: IsoDatetime.describe('Event end as an ISO 8601 datetime with timezone offset'),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(500).optional(),
    attendeeEmails: z.array(z.string().email()).max(20).optional(),
  }),
  outputSchema: CalendarEventOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('calendar.create_event', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string }
      const env = parseEnv()
      const result = await scheduleCalendarEvent(env, rc.tenantId, rc.userId, {
        summary: input.summary,
        startIso: input.startIso,
        endIso: input.endIso,
        description: input.description,
        location: input.location,
        attendeeEmails: input.attendeeEmails,
      })
      return { eventId: result.id, htmlLink: result.htmlLink }
    }),
})

export const deliverWebhookTool = createTool({
  id: 'webhooks.deliver',
  title: 'Deliver Webhook',
  description:
    'POST a JSON payload to the configured webhook URL with an HMAC-SHA256 signature header. The receiver verifies CRUM_WEBHOOK_SECRET. Requires CRUM_WEBHOOK_URL and CRUM_WEBHOOK_SECRET.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    event: z.string().trim().min(1).max(64).describe('A short event name, e.g. "lead.received"'),
    data: z.record(z.string(), z.unknown()).describe('The JSON payload body'),
  }),
  outputSchema: WebhookOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('webhooks.deliver', async () => {
      const env = parseEnv()
      const config = webhookConfigured(env)
      if (!config) {
        throw new Error('Webhook not configured: set CRUM_WEBHOOK_URL and CRUM_WEBHOOK_SECRET')
      }
      const delivery = await deliverWebhook(config, { event: input.event, data: input.data })
      return { delivered: true, status: delivery.status, signature: delivery.signatureHeader }
    }),
})

export const sendSmsTool = createTool({
  id: 'sms.send',
  title: 'Send SMS',
  description:
    'Send a text message through Twilio from the configured from-number. Requires CRUM_TWILIO_ACCOUNT_SID, CRUM_TWILIO_AUTH_TOKEN and CRUM_TWILIO_FROM_NUMBER.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    to: z.string().trim().min(5).max(20).describe('Destination phone number in E.164 form, e.g. +61491570156'),
    body: z.string().trim().min(1).max(1600),
  }),
  outputSchema: SmsOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('sms.send', async () => {
      const env = parseEnv()
      const config = twilioConfigured(env)
      if (!config) {
        throw new Error(
          'Twilio not configured: set CRUM_TWILIO_ACCOUNT_SID, CRUM_TWILIO_AUTH_TOKEN and CRUM_TWILIO_FROM_NUMBER',
        )
      }
      return sendSms(config, { to: input.to, body: input.body })
    }),
})

export const sendWhatsAppTool = createTool({
  id: 'whatsapp.send',
  title: 'Send WhatsApp Message',
  description:
    'Send a WhatsApp text message from the configured business number through the Meta Cloud API. Requires CRUM_WHATSAPP_TOKEN and CRUM_WHATSAPP_PHONE_NUMBER_ID.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    to: z.string().trim().min(5).max(20).describe('Destination phone number in international form, digits only, e.g. 61491570156'),
    body: z.string().trim().min(1).max(4096),
  }),
  outputSchema: WhatsAppOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('whatsapp.send', async () => {
      const env = parseEnv()
      const config = whatsappConfigured(env)
      if (!config) {
        throw new Error('WhatsApp not configured: set CRUM_WHATSAPP_TOKEN and CRUM_WHATSAPP_PHONE_NUMBER_ID')
      }
      return sendWhatsAppMessage(config, { to: input.to, body: input.body })
    }),
})

export const createLinkedInPostTool = createTool({
  id: 'linkedin.create_post',
  title: 'Create LinkedIn Post',
  description:
    'Publish a text post as the configured member or organization. Messaging/InMail is not supported. Requires CRUM_LINKEDIN_ACCESS_TOKEN and CRUM_LINKEDIN_AUTHOR_URN.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    text: z.string().trim().min(1).max(3000),
  }),
  outputSchema: LinkedInOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('linkedin.create_post', async () => {
      const env = parseEnv()
      const config = linkedinConfigured(env)
      if (!config) {
        throw new Error('LinkedIn not configured: set CRUM_LINKEDIN_ACCESS_TOKEN and CRUM_LINKEDIN_AUTHOR_URN')
      }
      return createLinkedInPost(config, { text: input.text })
    }),
})

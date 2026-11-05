// src/mastra/tools/chatwoot.ts
// Chatwoot customer-chat tools: list conversations (read-only), send a message
// and create a contact (both approval-required, because they reach a real
// person outside the system).

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { parseEnv } from '../../config/env'
import {
  chatwootConfigured,
  listConversations,
  sendMessage,
  createContact,
} from '../../chatwoot/client'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const ConversationItemSchema = z.object({
  id: z.number(),
  status: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  lastMessage: z.string(),
  createdAt: z.string(),
})

const GetConversationsOutputSchema = z.object({
  conversations: z.array(ConversationItemSchema),
  totalCount: z.number(),
})

const SendMessageOutputSchema = z.object({
  messageId: z.number(),
  status: z.string(),
})

const CreateContactOutputSchema = z.object({
  contactId: z.number(),
  status: z.string(),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfigOrThrow() {
  const env = parseEnv()
  const config = chatwootConfigured(env)
  if (!config) {
    throw new Error(
      'Chatwoot not configured: set CRUM_CHATWOOT_URL, CRUM_CHATWOOT_API_TOKEN, CRUM_CHATWOOT_ACCOUNT_ID and CRUM_CHATWOOT_INBOX_ID',
    )
  }
  return config
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const chatwootGetConversationsTool = createTool({
  id: 'chatwoot.get_conversations',
  title: 'Get Chatwoot Conversations',
  description: 'List customer conversations from Chatwoot inbox.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    status: z.enum(['open', 'resolved', 'pending', 'snoozed']).optional(),
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: GetConversationsOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('chatwoot.get_conversations', async () => {
      const config = getConfigOrThrow()
      const result = await listConversations(config, {
        status: input.status,
        page: input.page,
        limit: input.limit,
      })

      const conversations = result.data.map((c) => ({
        id: c.id,
        status: c.status,
        contactName: c.contact_inbox?.contact?.name ?? 'Unknown',
        contactEmail: c.contact_inbox?.contact?.email ?? '',
        lastMessage: c.messages?.[0]?.content ?? '',
        createdAt: new Date(c.created_at * 1000).toISOString(),
      }))

      return {
        conversations,
        totalCount: result.meta.all_count,
      }
    }),
})

export const chatwootSendMessageTool = createTool({
  id: 'chatwoot.send_message',
  title: 'Send Chatwoot Message',
  description:
    'Send a message to a customer conversation in Chatwoot. Requires human approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    conversationId: z.number().int().positive(),
    message: z.string().trim().min(1).max(5000),
    messageType: z.enum(['outgoing', 'activity']).default('outgoing'),
  }),
  outputSchema: SendMessageOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('chatwoot.send_message', async () => {
      const config = getConfigOrThrow()
      const result = await sendMessage(config, input.conversationId, {
        content: input.message,
        message_type: input.messageType,
      })

      return {
        messageId: result.id,
        status: result.status ?? 'sent',
      }
    }),
})

export const chatwootCreateContactTool = createTool({
  id: 'chatwoot.create_contact',
  title: 'Create Chatwoot Contact',
  description:
    'Create a new contact in Chatwoot from a conversation or lead. Requires human approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email(),
    phoneNumber: z.string().trim().min(5).max(20).optional(),
    company: z.string().trim().max(200).optional(),
    customAttributes: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: CreateContactOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('chatwoot.create_contact', async () => {
      const config = getConfigOrThrow()
      const result = await createContact(config, {
        name: input.name,
        email: input.email,
        phone_number: input.phoneNumber,
        company: input.company,
        custom_attributes: input.customAttributes,
      })

      return {
        contactId: result.payload.contact.id,
        status: 'created',
      }
    }),
})

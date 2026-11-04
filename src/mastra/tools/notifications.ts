// src/mastra/tools/notifications.ts
// Tools for sending notifications through external channels (Slack, etc.).
// These are informational only — they don't change CRUM state, just notify humans.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { parseEnv } from '../../config/env'
import { slackConfigured, sendSlackMessage } from '../../notifications/slack'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

const SendSlackOutputSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  channel: z.string(),
})

export const sendSlackTool = createTool({
  id: 'notifications.send_slack',
  title: 'Send Slack Notification',
  description:
    'Send a message to the configured Slack channel. Used for campaign alerts, approval notifications, and weekly reports. Requires CRUM_SLACK_BOT_TOKEN and CRUM_SLACK_CHANNEL.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    message: z.string().trim().min(1).max(3000).describe('The message to send'),
    blocks: z
      .array(z.unknown())
      .optional()
      .describe('Optional Slack block kit blocks for rich formatting'),
  }),
  outputSchema: SendSlackOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => false,

  execute: async (input, context) =>
    context.observe.span('notifications.send_slack', async () => {
      const env = parseEnv()
      const config = slackConfigured(env)

      if (!config) {
        throw new Error('Slack not configured: set CRUM_SLACK_BOT_TOKEN and CRUM_SLACK_CHANNEL')
      }

      const result = await sendSlackMessage(config, {
        text: input.message,
        blocks: input.blocks,
      })

      return {
        ok: result.ok,
        ts: result.ts,
        channel: result.channel,
      }
    }),
})

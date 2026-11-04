// src/notifications/slack.ts
// Slack notification adapter. Sends messages to a configured channel using a bot token.
// No OAuth needed for single-workspace use; the bot token is scoped to one workspace.
// Templates are provided for common marketing events (campaign live, approval needed, etc.).

import { parseEnv } from '../config/env'

const SLACK_API_ROOT = 'https://slack.com/api'

export class SlackApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SlackApiError'
    this.status = status
  }
}

export interface SlackConfig {
  botToken: string
  channel: string
}

export function slackConfigured(env: ReturnType<typeof parseEnv>): SlackConfig | null {
  if (!env.CRUM_SLACK_BOT_TOKEN || !env.CRUM_SLACK_CHANNEL) return null
  return {
    botToken: env.CRUM_SLACK_BOT_TOKEN,
    channel: env.CRUM_SLACK_CHANNEL,
  }
}

export interface SlackMessage {
  channel: string
  text: string
  blocks?: unknown[]
}

export interface SlackSendResult {
  ok: boolean
  ts: string
  channel: string
  message?: { text: string }
}

/**
 * Send a message to a Slack channel. Uses chat.postMessage.
 * The bot token must have chat:write scope.
 */
export async function sendSlackMessage(
  config: SlackConfig,
  message: { text: string; blocks?: unknown[] },
): Promise<SlackSendResult> {
  const res = await fetch(`${SLACK_API_ROOT}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.botToken}`,
    },
    body: JSON.stringify({
      channel: config.channel,
      text: message.text,
      blocks: message.blocks,
    }),
  })

  const json = (await res.json()) as { ok?: boolean; error?: string; ts?: string; channel?: string; message?: { text?: string } }

  if (!res.ok || !json.ok) {
    throw new SlackApiError(
      `slack chat.postMessage failed: ${json.error ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }

  return {
    ok: true,
    ts: json.ts ?? '',
    channel: json.channel ?? config.channel,
    message: json.message ? { text: json.message.text ?? '' } : undefined,
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

export function campaignLiveMessage(bundleId: string, url: string): { text: string; blocks: unknown[] } {
  return {
    text: `Campaign ${bundleId} is now live at ${url}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Campaign Live* :rocket:\nBundle: \`${bundleId}\`\nURL: ${url}`,
        },
      },
    ],
  }
}

export function approvalNeededMessage(bundleId: string, brief: string): { text: string; blocks: unknown[] } {
  return {
    text: `Approval needed for bundle ${bundleId}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Approval Needed* :eyes:\nBundle: \`${bundleId}\`\nBrief: ${brief}`,
        },
      },
    ],
  }
}

export function weeklyReportMessage(metrics: { campaigns: number; leads: number; spend: number }): { text: string; blocks: unknown[] } {
  return {
    text: `Weekly report: ${metrics.campaigns} campaigns, ${metrics.leads} leads, $${metrics.spend} spend`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Weekly Report* :chart_with_upwards_trend:\n• Campaigns: ${metrics.campaigns}\n• Leads: ${metrics.leads}\n• Spend: $${metrics.spend.toFixed(2)}`,
        },
      },
    ],
  }
}

import { Agent } from '@mastra/core/agent'

/**
 * §9.1 — Digest agent for morning priorities summary.
 *
 * Generates a natural-language digest from the structured output of the
 * digest workflow. Uses a lightweight model since the task is summarisation,
 * not reasoning.
 *
 * The digest agent has no tools — it is a pure generation agent that
 * receives structured data and produces a human-readable summary.
 */
export const digestAgent = new Agent({
  id: 'digest',
  name: 'Digest Agent',
  description:
    'Generates a morning priorities summary from structured CRM digest data.',
  instructions:
    'You are a CRM digest assistant. Given structured data about overdue tasks, ' +
    "today's schedule, and stale followups, produce a concise morning priorities " +
    'summary. Lead with the most urgent items. Group by category. Keep it under ' +
    '200 words. Do not invent data that is not present in the input.',
  model: 'anthropic/claude-sonnet-5-5',
  tools: {},
})

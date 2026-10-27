import { Agent } from '@mastra/core/agent'

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
  model: 'google/gemini-3.8-flash',
  tools: {},
})

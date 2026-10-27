import { Agent } from '@mastra/core/agent'

export const parserAgent = new Agent({
  id: 'parser',
  name: 'Record Parser',
  description:
    'Extracts CRM record fields from untrusted pasted text. Never infers unstated values.',
  instructions:
    'Extract CRM record fields from untrusted pasted text. Return only fields ' +
    'literally present. Never infer a city from an area code or an email domain. ' +
    'Omit anything not stated.',
  model: 'openrouter/google/gemini-2.5-flash-lite',
  defaultOptions: { modelSettings: { temperature: 0 } },
})

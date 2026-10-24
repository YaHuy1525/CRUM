import { Agent } from '@mastra/core/agent'

/**
 * §6.2 — Parser agent for structured prefill.
 *
 * Uses `google/gemini-3.8-flash` with `temperature: 0`. Callers pass
 * `structuredOutput: { schema, errorStrategy: 'fallback', fallbackValue }`
 * and `jsonPromptInjection: true` (required for Gemini with tools).
 *
 * A schema-validation failure degrades to the fallback value and a visible
 * "could not parse" state in the console, not a 500.
 */
export const parserAgent = new Agent({
  id: 'parser',
  name: 'Record Parser',
  description:
    'Extracts CRM record fields from untrusted pasted text. Never infers unstated values.',
  instructions:
    'Extract CRM record fields from untrusted pasted text. Return only fields ' +
    'literally present. Never infer a city from an area code or an email domain. ' +
    'Omit anything not stated.',
  model: 'google/gemini-3.8-flash',
  defaultOptions: { temperature: 0 },
})

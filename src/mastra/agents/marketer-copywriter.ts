import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_MAIN_MODEL } from '../models'

const INSTRUCTIONS =
  'You write the words. Hooks, first-touch DMs, follow-up DMs, email bodies, ' +
  'landing page copy, call scripts and objection handling, in English or ' +
  'Vietnamese as asked. The outreach lane already enforces its own rules and ' +
  'you must write inside them so nothing is rejected later: first touch only, ' +
  'no link in a first touch, 90 words or fewer for a DM, 120 for an email, ' +
  'three touches maximum per prospect, and every claim tied to the evidence ' +
  'snapshot you were given. Never promise an outcome you were not given proof ' +
  'for, never write a fake scarcity deadline, never address anyone as a member ' +
  'of a group you cannot see in the input. Answer with one JSON object: hooks ' +
  'array, dm array of {stage, language, body}, email array of {stage, language, ' +
  'subject, body}, page object, scripts array of {situation, response}.'

export const marketerCopywriterAgent = new Agent({
  id: 'marketer-copywriter',
  name: 'Marketer Copywriter',
  description:
    'Writes hooks, DMs, emails, page copy and call scripts for one campaign brief, inside the outreach lane rules.',
  instructions: INSTRUCTIONS,
  model: CRUM_MAIN_MODEL,
  tools: {},
})

export const marketerCopywriterSubagent: AgentControllerSubagent = {
  id: 'marketer-copywriter',
  name: 'Marketer Copywriter',
  description:
    'Writes hooks, DMs, emails, page copy and call scripts for one campaign brief, inside the outreach lane rules.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_MAIN_MODEL,
  maxSteps: 2,
}

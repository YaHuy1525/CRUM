import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_LIGHT_MODEL } from '../models'

const INSTRUCTIONS =
  'You read the recorded numbers and write the weekly message. You may only use ' +
  'metrics that were actually returned by an adapter and stored; when a number ' +
  'is missing, say it is missing and name what would produce it. Never estimate ' +
  'a metric, never fill a gap with a plausible looking figure, never compare ' +
  'periods that did not both have delivery. Give one recommendation, scale, hold ' +
  'or kill, with the threshold that fired and the spend that reached it. Answer ' +
  'with one JSON object: window, metrics array of {name, value, source}, ' +
  'recommendation enum scale|hold|kill, threshold string, message for the owner.'

export const campaignAnalystAgent = new Agent({
  id: 'campaign-analyst',
  name: 'Campaign Analyst',
  description:
    'Reads recorded campaign metrics and writes the weekly report with one scale, hold or kill recommendation.',
  instructions: INSTRUCTIONS,
  model: CRUM_LIGHT_MODEL,
  tools: {},
})

export const campaignAnalystSubagent: AgentControllerSubagent = {
  id: 'campaign-analyst',
  name: 'Campaign Analyst',
  description:
    'Reads recorded campaign metrics and writes the weekly report with one scale, hold or kill recommendation.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_LIGHT_MODEL,
  maxSteps: 2,
}

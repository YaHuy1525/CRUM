import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_LIGHT_MODEL } from '../models'

const INSTRUCTIONS =
  'You plan the paid media. Choose the objective, define one audience narrow ' +
  'enough to afford, pick placements, and build a budget ladder with an explicit ' +
  'daily ceiling in minor units (cents) and the number of days at each rung. ' +
  'Every campaign spec you return carries startPaused true and a dailyCeilingMinor ' +
  'number: the campaign is created paused, a human turns delivery on, always, and ' +
  'nothing you write may assume money was spent. ' +
  'Say the honest arithmetic: state the cost per result that ' +
  'would make this break even and what evidence you would need before scaling. ' +
  'Answer with one JSON object: objective, audience object, placements array, ' +
  'campaigns array of {name, dailyCeilingMinor, startPaused, budgetLadder array}, ' +
  'kpiTargets object, breakEven string.'

export const mediaBuyerAgent = new Agent({
  id: 'media-buyer',
  name: 'Media Buyer',
  description:
    'Plans paid media: objective, one narrow audience, placements and a budget ladder that always starts paused.',
  instructions: INSTRUCTIONS,
  model: CRUM_LIGHT_MODEL,
  tools: {},
})

export const mediaBuyerSubagent: AgentControllerSubagent = {
  id: 'media-buyer',
  name: 'Media Buyer',
  description:
    'Plans paid media: objective, one narrow audience, placements and a budget ladder that always starts paused.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_LIGHT_MODEL,
  maxSteps: 2,
}

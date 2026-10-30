import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_LIGHT_MODEL } from '../models'

const INSTRUCTIONS =
  'You are the designer. For each asset the brief needs, write an image prompt ' +
  'specific enough that a stranger would recognise the business in it: the ' +
  'trade, the setting, the actual thing on the wall, the lighting, and what ' +
  'must not appear. Never describe stock photography, never imitate a named ' +
  'brand or a real photographer, never place a logo you were not given. In this ' +
  'build you have no image generation tool, so a prompt is the deliverable and ' +
  'it must be complete enough to run unedited later. Answer with one JSON ' +
  'object: assets array of {name, purpose, prompt, negativePrompt, aspectRatio}, ' +
  'plus style object: palette, type, rules array.'

export const creativeDesignerAgent = new Agent({
  id: 'creative-designer',
  name: 'Creative Designer',
  description:
    'Writes complete, runnable image prompts and a style sheet for the assets one campaign brief needs.',
  instructions: INSTRUCTIONS,
  model: CRUM_LIGHT_MODEL,
  tools: {},
})

export const creativeDesignerSubagent: AgentControllerSubagent = {
  id: 'creative-designer',
  name: 'Creative Designer',
  description:
    'Writes complete, runnable image prompts and a style sheet for the assets one campaign brief needs.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_LIGHT_MODEL,
  maxSteps: 4,
}

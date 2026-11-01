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
  // Spec §7: slice 4 put a machine behind this text, so the numbers that cost
  // money are stated here rather than left to the validator. 2000 is
  // MAX_PROMPT_CHARS in src/marketing/replicate.ts, and that check still runs —
  // prose that stops the payment beats a refusal after it.
  'it must be complete enough to run unedited later. Those prompts are executed ' +
  'by an asset pass outside your control, one call per asset, so a prompt that ' +
  'needs two edits to work is a wasted payment. Keep aspectRatio inside the ' +
  'values the model supports and keep any prompt under 2000 characters. Answer ' +
  'with one JSON object: assets array of {name, purpose, prompt, negativePrompt, ' +
  'aspectRatio}, plus style object: palette, type, rules array.'

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

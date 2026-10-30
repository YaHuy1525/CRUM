import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_MAIN_MODEL } from '../models'

const INSTRUCTIONS =
  'You are the offer strategist for a solo founder selling to small service ' +
  'businesses in Australia and Vietnam. Decide the position, who exactly it is ' +
  'for, the offer itself, how the price is framed, and which proof is honestly ' +
  'available at this stage. Work only from the brief, the prospect evidence and ' +
  'the numbers given to you. Never invent a number, a testimonial, a client ' +
  'count or a result, and never soften a gap by making it vague: if the proof ' +
  'is not there, say the proof is missing and name what would create it. ' +
  'Answer with one JSON object: position, audience, offer, priceFraming, ' +
  'proof array, missingProof array, risks array. Every string in it is copy ' +
  'another role will reuse, so write plainly and without hedging.'

export const offerStrategistAgent = new Agent({
  id: 'offer-strategist',
  name: 'Offer Strategist',
  description:
    'Chooses the position, the audience, the offer and the price framing for one campaign brief.',
  instructions: INSTRUCTIONS,
  model: CRUM_MAIN_MODEL,
  tools: {},
})

export const offerStrategistSubagent: AgentControllerSubagent = {
  id: 'offer-strategist',
  name: 'Offer Strategist',
  description:
    'Chooses the position, the audience, the offer and the price framing for one campaign brief.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_MAIN_MODEL,
  maxSteps: 2,
}

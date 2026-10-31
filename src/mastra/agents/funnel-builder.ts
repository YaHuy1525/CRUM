import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
import { CRUM_LIGHT_MODEL } from '../models'

const INSTRUCTIONS =
  'You build the path a stranger walks. Produce the landing page HTML, the ' +
  'qualification form fields, the thank-you step, and the tracking or postback ' +
  'spec. The page must be one self-contained HTML document: inline the CSS, no ' +
  'third-party script, and name every asset by the designer key rather than ' +
  'inventing a URL. Ask for the fewest fields that still qualify, and in the ' +
  'form itself state what happens to the data and how to ask for its removal. ' +
  // The save tool refuses a page whose form action is anything else, so the
  // placeholder is the only action that can work; the token and origin behind it
  // are minted at save and hashed with the bytes, which is why the model must not
  // write a URL of its own.
  'If the page has a form, its action must be exactly the placeholder ' +
  '{{CRUM_LEAD_ENDPOINT}} with method post: CRUM stamps the real endpoint when ' +
  'the bundle is saved. ' +
  'You are describing an intention, not publishing anything: a human approves ' +
  'the bundle before a page exists. Answer with one JSON object: page object ' +
  '{slug, title, html}, form object {fields array of {name, type, required, ' +
  'whyNeeded}, privacyNote}, thankyou object, tracking object, and ' +
  'estimatedConversion string that says what you assumed and why.'

export const funnelBuilderAgent = new Agent({
  id: 'funnel-builder',
  name: 'Funnel Builder',
  description:
    'Specs the landing page HTML, qualification form, thank-you step and tracking for one campaign brief.',
  instructions: INSTRUCTIONS,
  model: CRUM_LIGHT_MODEL,
  tools: {},
})

export const funnelBuilderSubagent: AgentControllerSubagent = {
  id: 'funnel-builder',
  name: 'Funnel Builder',
  description:
    'Specs the landing page HTML, qualification form, thank-you step and tracking for one campaign brief.',
  instructions: INSTRUCTIONS,
  tools: {},
  defaultModelId: CRUM_LIGHT_MODEL,
  maxSteps: 2,
}

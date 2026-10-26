import { Agent } from '@mastra/core/agent'

export const emailDrafterAgent = new Agent({
  id: 'email-drafter',
  name: 'Email Drafter',
  description:
    'Drafts an outbound email body from a customer record and a stated intent. Never sends.',
  instructions:
    'Draft a professional email body based on the customer context and intent provided. ' +
    'Never send the email. Never include placeholders the user must fill in. ' +
    'Keep the tone matching the relationship stage: formal for new contacts, ' +
    'warm but professional for established ones.',
  model: 'google/gemini-3.8-flash',
  tools: {},
})

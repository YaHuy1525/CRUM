import { Agent } from '@mastra/core/agent'

/**
 * §6.1 — Email drafter controller subagent.
 *
 * Pure generation: no tools, strong model, maxSteps: 1. The harness enforces
 * the step ceiling rather than trusting the prompt. Drafts an outbound email
 * body from a customer record and a stated intent. Never sends — mail.send
 * is a separate approval-class tool.
 */
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
  model: 'anthropic/claude-sonnet-5-5',
  tools: {},
})

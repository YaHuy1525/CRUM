// console/lib/starters.ts
/**
 * The curated starter prompts for the launch view and the empty conversation.
 * §"Chats section / Frontend": "starter prompt cards drawn from a curated static
 * set in a single console config module."
 *
 * These are starting *moves*, not navigation: choosing one fills the composer
 * with a real prompt the `crm-assistant` agent can answer against the live
 * pipeline. They stay a static, hand-written set on purpose — a generated or
 * server-driven list would be a second source of truth for what the assistant
 * can do, and would drift from the governed tool surface. The `id` is stable so
 * a card can be keyed and a test can address one by name.
 */
export interface StarterPrompt {
  id: string
  /** Short card label, in the imperative. */
  label: string
  /** The full prompt sent when the card is chosen. */
  prompt: string
}

export const STARTERS: readonly StarterPrompt[] = [
  {
    id: 'today',
    label: 'What should I work on today?',
    prompt: 'What should I work on today? Check overdue follow-ups and deals at risk.',
  },
  {
    id: 'summarize',
    label: 'Summarize a customer',
    prompt: 'Summarize my open deals and the last activity for my most active customer.',
  },
  {
    id: 'draft-followup',
    label: 'Draft a follow-up',
    prompt: 'Draft a follow-up task for the deal that went quiet longest.',
  },
  {
    id: 'at-risk',
    label: 'Find deals at risk',
    prompt: 'Which open deals look at risk this week, and why? Rank them by urgency.',
  },
  {
    id: 'capture',
    label: 'Turn notes into a record',
    prompt:
      'I met with a prospect who asked for pricing next week. Draft a follow-up and stage any record changes for my approval.',
  },
] as const

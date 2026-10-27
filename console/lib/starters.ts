export interface StarterPrompt {
  id: string
  label: string
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

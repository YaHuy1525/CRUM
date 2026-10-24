// src/mastra/goals.ts
import type { Agent } from '@mastra/core/agent'

const INBOX_CLEARING_OBJECTIVE = `Clear the user's approval-free inbox: for every customer contacted in the last 7 days, check whether a followup has been logged. If not, log one using crm.log_followup (an auto-class tool). Do not create customers, send emails, or call any approval-class tool. Stop when every contacted customer has a followup or the budget is exhausted.`

export async function startInboxClearingGoal(
  agent: Agent,
  options: { threadId: string; resourceId: string },
) {
  return agent.setObjective(INBOX_CLEARING_OBJECTIVE, {
    threadId: options.threadId,
    resourceId: options.resourceId,
    judgeModelId: 'anthropic/claude-sonnet-5-5',
    maxRuns: 12,
  })
}

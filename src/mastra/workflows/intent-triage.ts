import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { intentClassifier } from '../classifiers/intent'

/**
 * §6.5.6 — Intent triage workflow.
 *
 * Routes user messages into schedule/task/clarify paths based on the
 * intentClassifier's two questions. The workflow form is fail-closed (opposite
 * of the processor's warn): a triage workflow that cannot triage has nothing
 * useful to do.
 *
 * Three branches:
 * - schedule: intent.choice === 'schedule' && hasTimeRange.probability > 0.7
 * - task: intent.choice === 'task'
 * - clarify: everything else (including 'other' and all refusals)
 *
 * `.classifier()` does not apply fail-open behaviour. Classifier errors fail
 * the step. This is why the injection guard is a processor and the intent
 * router is a workflow step (§6.5.6).
 */

const branchInputSchema = z.object({
  message: z.string(),
})

const branchOutputSchema = z.object({
  action: z.enum(['schedule', 'task', 'clarify']),
  message: z.string(),
})

const scheduleStep = createStep({
  id: 'schedule-action',
  inputSchema: branchInputSchema,
  outputSchema: branchOutputSchema,
  execute: async ({ inputData }) => {
    return { action: 'schedule' as const, message: inputData.message }
  },
})

const taskStep = createStep({
  id: 'task-action',
  inputSchema: branchInputSchema,
  outputSchema: branchOutputSchema,
  execute: async ({ inputData }) => {
    return { action: 'task' as const, message: inputData.message }
  },
})

const clarifyStep = createStep({
  id: 'clarify-action',
  inputSchema: branchInputSchema,
  outputSchema: branchOutputSchema,
  execute: async ({ inputData }) => {
    return { action: 'clarify' as const, message: inputData.message }
  },
})

export const intentTriageFlow = createWorkflow({
  id: 'crum-intent-triage',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: branchOutputSchema,
})
  .map(async ({ inputData }) => ({ message: inputData.message }))
  .classifier(intentClassifier)
  .branch([
    [
      async ({ inputData }) =>
        inputData.answers.intent.choice === 'schedule' &&
        inputData.answers.hasTimeRange.probability > 0.7,
      scheduleStep,
    ],
    [
      async ({ inputData }) => inputData.answers.intent.choice === 'task',
      taskStep,
    ],
    [async () => true, clarifyStep],
  ])
  .commit()

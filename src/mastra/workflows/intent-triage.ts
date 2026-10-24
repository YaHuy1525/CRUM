import { createWorkflow, createStep } from '@mastra/core/workflows'
import type { ClassifierStepOutput } from '@mastra/core/workflows'
import type { StandardSchemaWithJSON } from '@mastra/core/schema'
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
 * - schedule: intent.choice === 'schedule' && hasTimeRange is a boolean answer
 *   with probability > 0.7
 * - task: intent.choice === 'task'
 * - clarify: everything else (including 'other' and all refusals)
 *
 * `.classifier()` does not apply fail-open behaviour. Classifier errors fail
 * the step. This is why the injection guard is a processor and the intent
 * router is a workflow step (§6.5.6).
 */

const workflowInputSchema = z.object({ message: z.string() })

type TriageClassifierOutput = ClassifierStepOutput<typeof intentClassifier.questions>

/**
 * `.branch()` types every target step's input as the classifier step's output,
 * which is `{ answers, usage }` — never the workflow's own input. `satisfies`
 * pins this schema to the classifier's inferred answer types so a question
 * change breaks the build here instead of at run time.
 */
const classifierOutputSchema = z
  .object({
    answers: z.object({
      intent: z.union([
        z.object({
          type: z.literal('choice'),
          choice: z.enum(['schedule', 'task', 'other']),
        }),
        z.object({ type: z.literal('refusal') }),
      ]),
      hasTimeRange: z.union([
        z.object({ type: z.literal('boolean'), probability: z.number() }),
        z.object({ type: z.literal('refusal') }),
      ]),
    }),
    usage: z.object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number(),
    }),
  }) satisfies StandardSchemaWithJSON<TriageClassifierOutput>

const branchOutputSchema = z.object({
  action: z.enum(['schedule', 'task', 'clarify']),
  message: z.string(),
})

const scheduleStep = createStep({
  id: 'schedule-action',
  inputSchema: classifierOutputSchema,
  outputSchema: branchOutputSchema,
  execute: async (ctx) => {
    return {
      action: 'schedule' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }
  },
})

const taskStep = createStep({
  id: 'task-action',
  inputSchema: classifierOutputSchema,
  outputSchema: branchOutputSchema,
  execute: async (ctx) => {
    return {
      action: 'task' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }
  },
})

const clarifyStep = createStep({
  id: 'clarify-action',
  inputSchema: classifierOutputSchema,
  outputSchema: branchOutputSchema,
  execute: async (ctx) => {
    return {
      action: 'clarify' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }
  },
})

export const intentTriageFlow = createWorkflow({
  id: 'crum-intent-triage',
  inputSchema: workflowInputSchema,
  outputSchema: branchOutputSchema,
})
  .map(async ({ inputData }) => ({ message: inputData.message }))
  .classifier(intentClassifier)
  .branch([
    [
      async ({ inputData }) =>
        inputData.answers.intent.choice === 'schedule' &&
        inputData.answers.hasTimeRange.type === 'boolean' &&
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

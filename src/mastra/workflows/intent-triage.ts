import { createWorkflow, createStep } from '@mastra/core/workflows'
import type { ClassifierStepOutput } from '@mastra/core/workflows'
import type { StandardSchemaWithJSON } from '@mastra/core/schema'
import { z } from 'zod'
import { intentClassifier } from '../classifiers/intent'


const workflowInputSchema = z.object({ message: z.string() })

type TriageClassifierOutput = ClassifierStepOutput<typeof intentClassifier.questions>

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
  execute: (ctx) =>
    Promise.resolve({
      action: 'schedule' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }),
})

const taskStep = createStep({
  id: 'task-action',
  inputSchema: classifierOutputSchema,
  outputSchema: branchOutputSchema,
  execute: (ctx) =>
    Promise.resolve({
      action: 'task' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }),
})

const clarifyStep = createStep({
  id: 'clarify-action',
  inputSchema: classifierOutputSchema,
  outputSchema: branchOutputSchema,
  execute: (ctx) =>
    Promise.resolve({
      action: 'clarify' as const,
      message: ctx.getInitData<z.infer<typeof workflowInputSchema>>().message,
    }),
})

export const intentTriageFlow = createWorkflow({
  id: 'crum-intent-triage',
  inputSchema: workflowInputSchema,
  outputSchema: branchOutputSchema,
})
  .map(({ inputData }) => Promise.resolve({ message: inputData.message }))
  .classifier(intentClassifier)
  .branch([
    [
      ({ inputData }) =>
        Promise.resolve(
          inputData.answers.intent.choice === 'schedule' &&
            inputData.answers.hasTimeRange.type === 'boolean' &&
            inputData.answers.hasTimeRange.probability > 0.7,
        ),
      scheduleStep,
    ],
    [
      ({ inputData }) => Promise.resolve(inputData.answers.intent.choice === 'task'),
      taskStep,
    ],
    [() => Promise.resolve(true), clarifyStep],
  ])
  .commit()

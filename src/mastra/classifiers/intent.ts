import { Classifier } from '@mastra/core/classifier'
import { crumDecisionModel } from '../decision-model'

const model = crumDecisionModel()

const safeModel =
  model ??
  ({
    provider: 'crum-unavailable',
    modelId: 'crum-unavailable',
    specificationVersion: 'v4' as const,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    doDecide: () => {
      throw new Error('Decision model unavailable: no API key configured')
    },
  }) as unknown as NonNullable<ReturnType<typeof crumDecisionModel>>

export const intentClassifier = new Classifier({
  id: 'crum-intent',
  model: safeModel,
  questions: {
    intent: {
      type: 'choice',
      instructions:
        'What does the user want CRUM to do with the time information in this message?',
      criteria: {
        schedule:
          'A concrete start and end time is given or implied: a meeting, a call, a block on the calendar.',
        task: 'A deadline or an outcome is given without a start and end time: follow up, send, prepare, chase.',
        other:
          'Neither. A question, a lookup, or something unrelated to time-bound work.',
      },
    },
    hasTimeRange: {
      type: 'boolean',
      instructions:
        'Does the message state or clearly imply both a start and an end time?',
      criteria: {
        true: 'Both are present, e.g. "Thursday 2 to 3".',
        false: 'A deadline or a single point in time only, or no time at all.',
      },
    },
  },
})

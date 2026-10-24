import { Classifier } from '@mastra/core/classifier'
import { crumDecisionModel } from '../decision-model'

/**
 * §6.5.4 — Intent classifier: routes user messages into schedule/task/other.
 *
 * Two questions are sent in one request against shared state. `hasTimeRange`
 * looks redundant next to `intent` and is not: the two questions disagree in
 * a specific, useful way — a message classified `schedule` while
 * `hasTimeRange` is false means the user asked for a meeting without giving
 * an end time, which is a clarifying question, not a guess.
 *
 * Refusal falls through to the §4.4 prompt rule. Mis-routing a task to a
 * schedule is recoverable by the user in one turn; a total outage of the
 * assistant is not (§6.5.5).
 *
 * Requires crumDecisionModel() to be defined. The Mastra instance registers
 * this classifier only when the model is available.
 */
const model = crumDecisionModel()

/**
 * When no API key is configured, crumDecisionModel() returns undefined. The
 * Classifier constructor accesses model.provider at construction time, which
 * would crash. A stub model is provided instead: it constructs safely but
 * throws at classification time. The workflow step's error handling catches
 * that and falls through to the clarify branch (§6.5.6).
 */
const safeModel =
  model ??
  ({
    provider: 'crum-unavailable',
    modelId: 'crum-unavailable',
    specificationVersion: 'v4' as const,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    doDecide: async () => {
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

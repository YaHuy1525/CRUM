import { ModelSelectionProcessor } from '@mastra/core/processors'
import { typeSafeAi } from '@ai-sdk/typesafe-ai'

/**
 * Create the ModelSelectionProcessor for CRUM.
 *
 * §4.3.2: model routing based on request complexity. Phase 2 uses a single
 * model; Phase 3 will add fallback chains and criteria-based routing.
 *
 * Note: The Mastra API requires at least 2 choices and a decision model instance.
 * Phase 2 provides two placeholder choices that both route to the same model.
 * Phase 3 will differentiate these into actual routing criteria.
 */
export function createModelSelectionProcessor(): ModelSelectionProcessor {
  return new ModelSelectionProcessor({
    model: typeSafeAi.decisionModel('jev-latest'),
    choices: [
      {
        model: 'anthropic/claude-sonnet-5-5',
        criteria: 'default request',
        name: 'default',
      },
      {
        model: 'anthropic/claude-sonnet-5-5',
        criteria: 'complex request',
        name: 'complex',
      },
    ],
  })
}

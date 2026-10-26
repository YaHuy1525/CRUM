import { ModelSelectionProcessor } from '@mastra/core/processors'
import { typeSafeAi } from '@ai-sdk/typesafe-ai'

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

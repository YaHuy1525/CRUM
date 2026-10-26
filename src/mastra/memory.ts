import { Memory } from '@mastra/memory'
import type { CrumStorage } from './storage'
import { CRUM_WORKING_MEMORY_TEMPLATE } from './working-memory'

export function buildCrumMemory(storage: CrumStorage): Memory {
  return new Memory({
    storage,
    options: {
      messageHistory: {
        maxTokens: 24_000,
        atMaxRemoveTokens: 6_000,
      },
      workingMemory: {
        enabled: true,
        template: CRUM_WORKING_MEMORY_TEMPLATE,
        scope: 'resource',
      },
    },
  })
}

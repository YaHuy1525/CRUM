import { Memory } from '@mastra/memory'
import type { CrumStorage } from './storage'
import { CRUM_WORKING_MEMORY_TEMPLATE } from './working-memory'

// 4.3.4 — messageHistory.maxTokens, NOT lastMessages.
// messageHistory removes history in chunks, keeping the prefix stable across
// several turns. lastMessages slides forward on every request and invalidates
// the provider prompt cache every single turn.
export function buildCrumMemory(storage: CrumStorage): Memory {
  return new Memory({
    storage,
    options: {
      messageHistory: {
        maxTokens: 24_000,
        atMaxRemoveTokens: 6_000, // default is 25% of maxTokens
      },
      workingMemory: {
        enabled: true,
        template: CRUM_WORKING_MEMORY_TEMPLATE,
        scope: 'resource', // cross-thread facts live HERE, not in OM
      },
    },
  })
}

import { Memory } from '@mastra/memory'
import type { CrumStorage } from './storage'
import type { CrumEnv } from '../config/env'
import { CRUM_LIGHT_MODEL } from './models'
import { CRUM_WORKING_MEMORY_TEMPLATE } from './working-memory'

export function buildCrumMemory(storage: CrumStorage, env: CrumEnv): Memory {
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
      // Level 4: background Observer/Reflector compress old turns. Kill-switch
      // off omits the key entirely, restoring the pre-upgrade options object.
      ...(env.CRUM_OM_ENABLED ? { observationalMemory: { model: CRUM_LIGHT_MODEL } } : {}),
    },
  })
}

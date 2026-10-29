import { Memory } from '@mastra/memory'
import type { CrumStorage } from './storage'
import type { CrumEnv } from '../config/env'
import type { RecallDeps } from './recall'
import { CRUM_LIGHT_MODEL } from './models'
import { CRUM_WORKING_MEMORY_TEMPLATE } from './working-memory'

export function buildCrumMemory(
  storage: CrumStorage,
  env: CrumEnv,
  recall?: RecallDeps,
): Memory {
  return new Memory({
    storage,
    // Level 3 recall needs BOTH constructor keys; omit entirely when the
    // kill-switch is off OR deps are absent, leaving message-history recall
    // byte-identical to the base. Gating on the flag here (not just deps) makes
    // the coupling self-enforcing rather than relying on buildRecallDeps to
    // return undefined. Coupling: without vector/embedder, OM observation
    // indexing goes silent and memory.searchMessages throws (research doc §4).
    ...(env.CRUM_RECALL_ENABLED && recall
      ? { vector: recall.vector, embedder: recall.embedder }
      : {}),
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
      // Level 3: cross-thread recall for the same resource (spec §5). Gated on
      // BOTH the kill-switch and the lazily-built deps, so an off switch keeps
      // the options byte-identical to the base. NO static filter: the tenant
      // predicate varies per caller and is supplied on the recall query (doc §4/§5).
      ...(env.CRUM_RECALL_ENABLED && recall
        ? {
            semanticRecall: {
              topK: 4,
              messageRange: 2,
              scope: 'resource' as const,
              // indexConfig is consumed by createEmbeddingIndex; omitting it
              // builds ivfflat (PgVector default). Mirrors CRUM_VECTOR_CONFIG.
              indexConfig: {
                type: 'hnsw' as const,
                metric: 'cosine' as const,
                hnsw: { m: 16, efConstruction: 64 },
              },
            },
          }
        : {}),
    },
  })
}

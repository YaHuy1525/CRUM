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
    // kill-switch is off OR deps are absent, so no recall additions leak in
    // (the ungated generateTitle/working-memory constant changes still apply —
    // spec §6 sanctions them without flags). Gating on the flag here (not just
    // deps) makes the coupling self-enforcing rather than relying on
    // buildRecallDeps to return undefined. Coupling: without vector/embedder,
    // OM observation indexing goes silent and memory.searchMessages throws
    // (research doc §4; the GET /api/agent/search route answers 503 instead).
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
      // Server-generated thread titles for new chats (spec §6). Runs async on the
      // light model. The console PATCH auto-flow only fills an empty, unpinned
      // title, so this coexists; a user-pinned title still wins.
      generateTitle: { model: CRUM_LIGHT_MODEL },
      // Level 4: background Observer/Reflector compress old turns. Kill-switch
      // off omits the key entirely (no observationalMemory addition leaks in).
      ...(env.CRUM_OM_ENABLED ? { observationalMemory: { model: CRUM_LIGHT_MODEL } } : {}),
      // Level 3: cross-thread recall for the same resource (spec §5). Gated on
      // BOTH the kill-switch and the lazily-built deps, so an off switch omits
      // the semanticRecall key entirely. NO static filter: the shipped boundary
      // is the injective server-derived resourceId (doc §4 ruling 2026-10-30).
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

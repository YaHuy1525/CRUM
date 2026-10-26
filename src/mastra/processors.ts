import type { Processor } from '@mastra/core/processors'
import {
  TokenLimiter,
  ModerationProcessor,
} from '@mastra/core/processors'
import { ObjectBindingProcessor } from './processors/object-binding'
import { EnsureFinalResponseProcessor } from './processors/ensure-final-response'
import { WriteClaimGuardProcessor } from './processors/write-claim-guard'
import { CitationGuardProcessor } from './processors/citation-guard'
import { InjectionGuardProcessor } from './processors/injection-guard'
import { CRUM_MAIN_MODEL } from './models'

// §4.3 — processor pipeline. TokenLimiter goes LAST (§4.3 rule 1).
// Phase 1 wires the minimum viable set; Phase 2 adds the rest.

/**
 * The moderation model. It has to be a route with a real key behind it.
 *
 * `ModerationProcessor` sits on the output pipeline, so Mastra calls it from
 * `moderateStreamPart` for every streamed part of a turn, and a guardrail call
 * that fails is caught and logged as "Agent moderation failed, allowing content"
 * — it fails open. On `CRUM_MODEL_LIGHT` (an OpenRouter shared free pool,
 * `is_byok:false`, `limit_source:upstream_provider_shared_pool`) every one of
 * those calls came back `429 ... temporarily rate-limited upstream`: 35 attempts,
 * 35 failures in a single "what should I work on today" turn, which took 283 s
 * and still never reached a finish event. So the free route bought nothing except
 * a stalled transcript, and the console showed `Internal Server Error` over an
 * empty conversation. The main route answered the same turn without a single 429,
 * so moderation runs on it. The cost of that honesty is one extra model call per
 * output part, which is why this stays the *light*-weight question the processor
 * asks rather than a full re-generation.
 */
const GUARDRAIL_MODEL = CRUM_MAIN_MODEL
const MAX_STEPS = 6

export const crumInputProcessors: Processor[] = [
  new ObjectBindingProcessor(),
  new EnsureFinalResponseProcessor(MAX_STEPS),
  new InjectionGuardProcessor(),
  new ModerationProcessor({
    model: GUARDRAIL_MODEL,
    threshold: 0.7,
    strategy: 'block',
    categories: ['hate', 'harassment', 'violence'],
  }),
  new TokenLimiter(24_000),
]

export const crumOutputProcessors: Processor[] = [
  new WriteClaimGuardProcessor(),
  new CitationGuardProcessor(),
  new ModerationProcessor({
    model: GUARDRAIL_MODEL,
    strategy: 'block',
  }),
]

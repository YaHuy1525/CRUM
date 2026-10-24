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

// §4.3 — processor pipeline. TokenLimiter goes LAST (§4.3 rule 1).
// Phase 1 wires the minimum viable set; Phase 2 adds the rest.

const GUARDRAIL_MODEL = 'openrouter/openai/gpt-oss-safeguard-20b'
const MAX_STEPS = 6

export const crumInputProcessors: Processor[] = [
  new ObjectBindingProcessor(),
  new EnsureFinalResponseProcessor(MAX_STEPS),
  new InjectionGuardProcessor(), // §6.5.6 — before ModerationProcessor
  new ModerationProcessor({
    model: GUARDRAIL_MODEL,
    threshold: 0.7,
    strategy: 'block',
    categories: ['hate', 'harassment', 'violence'],
  }),
  // TokenLimiter is the final budget guard, placed last (§4.3 rule 1, §4.3.4)
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

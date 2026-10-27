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
import { StreamModerationGateProcessor } from './processors/stream-moderation-gate'
import { CRUM_MAIN_MODEL } from './models'


const GUARDRAIL_MODEL = CRUM_MAIN_MODEL

/**
 * Characters of answer text the output guardrail judges at once. A normal turn writes
 * a few thousand characters, so this is a handful of calls rather than one per token.
 */
const GUARDRAIL_WINDOW_CHARS = 400

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
    // One call per turn instead of one per message per step. Without this the
    // processor loops over the whole conversation history, and the agent re-runs the
    // input pipeline on every step of the loop, so a turn with a long tool result
    // paid for the same old messages again and again.
    lastMessageOnly: true,
  }),
  new TokenLimiter(24_000),
]

export const crumOutputProcessors: Processor[] = [
  new WriteClaimGuardProcessor(),
  new CitationGuardProcessor(),
  // Windowed: one guardrail call per `GUARDRAIL_WINDOW_CHARS` of answer instead of
  // one per text-delta. See stream-moderation-gate.ts for why the plain processor is
  // not usable on this route.
  new StreamModerationGateProcessor(
    { model: GUARDRAIL_MODEL, strategy: 'block' },
    GUARDRAIL_WINDOW_CHARS,
  ),
]

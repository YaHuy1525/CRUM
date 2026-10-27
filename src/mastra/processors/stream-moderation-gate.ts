import {
  ModerationProcessor,
  type ModerationOptions,
  type ProcessOutputStreamArgs,
} from '@mastra/core/processors'
import type { ChunkType } from '@mastra/core/stream'

/**
 * Output-side moderation that costs one model call per window of prose instead of
 * one per streamed token.
 *
 * Why it exists. `ModerationProcessor` already sits on `crumOutputProcessors`, but
 * on this server it is unusably slow. Its own buffering (`bufferSize`) is implemented
 * by `processBufferedTextStream`, which begins with
 * `if (!writer) return part.type === 'text-delta' ? check(part) : part`. The writer
 * only exists for workflow runs; `Agent#stream` forwards `options.outputWriter`, and
 * the `/chat/crm` route (`chatRoute` from `@mastra/ai-sdk`) does not pass one. So
 * every `text-delta` is moderated on its own. Measured on this machine with the
 * guardrail on the paid main route: a "what should I work on today?" turn streamed
 * 232 deltas and ran past 19 minutes without reaching a finish event, twice, on the
 * `bufferSize: 200` build as well as without it. The same server answers "hi" in 23 s.
 *
 * Why the framework's answer cannot be copied here. Holding text back until a window
 * is judged means dropping parts, and re-emitting the held text needs that same writer
 * (`return null` simply deletes the part). So on this route a processor must forward
 * every part it is given, which means moderation here gates the *turn* rather than
 * screening the *tokens*: content that trips the guardrail has already been streamed
 * when the abort fires. That is the trade the window makes, and it is the same trade
 * `processOutputResult` makes, only earlier and with the run stopped mid-answer
 * instead of after it.
 *
 * What is preserved: the abort itself (strategy `'block'` throws a tripwire, so the
 * turn is not persisted), the fail-open behaviour on moderation errors (the framework
 * catches them and logs "Stream moderation failed"), and the exact transcript text,
 * because parts are returned untouched.
 */

/** Characters of answer text judged at once. The ceiling for any single call. */
const DEFAULT_WINDOW_CHARS = 400

/**
 * Below this length a completed sentence is not worth a call, because a reply made of
 * "Ok." / "Sure." / "Yes." chains would otherwise cost one request per word.
 */
const MIN_SENTENCE_CHARS = 80

const SENTENCE_END = /[.!?]\s*$/

/**
 * Chunk types that close a stretch of answer text, so accumulated text must be judged
 * before one of them is passed on.
 *
 * This is a whitelist and not "any part that is not a text-delta", because the runner
 * hands the output pipeline a `response-metadata` part after *every* delta. Measured:
 * a nine-delta "hi" turn flushed nine windows and spent 14.8 s of its 26.6 s inside the
 * guardrail, which is the per-token cost this processor exists to remove.
 */
const TEXT_BOUNDARIES = new Set([
  'text-end',
  'step-finish',
  'finish-step',
  'finish',
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-output-denied',
  'file',
  'source',
  'error',
  'abort',
  'tripwire',
])

const WINDOW_STATE_KEY = 'crumOutputStreamModerationWindow'

/** Per-request accumulator. `id` is the latest text block, kept for the synthetic part. */
type ModerationWindow = { text: string; id: string }

/**
 * Decide what the gate does with a delta. Returns the text to judge, or `null` to keep
 * collecting. Pure so the policy is testable without a model behind it.
 */
export function planWindow(
  window: ModerationWindow,
  delta: string,
  options: { windowChars?: number; minSentenceChars?: number } = {},
): string | null {
  const windowChars = options.windowChars ?? DEFAULT_WINDOW_CHARS
  const minSentenceChars = options.minSentenceChars ?? MIN_SENTENCE_CHARS

  window.text += delta
  if (!window.text.trim()) {
    // Whitespace-only stretches (table padding, newlines) would otherwise queue a
    // moderation call that has nothing to judge.
    window.text = ''
    return null
  }
  if (window.text.length >= windowChars) return take(window)
  if (window.text.length >= minSentenceChars && SENTENCE_END.test(window.text)) {
    return take(window)
  }
  return null
}

function take(window: ModerationWindow): string {
  const text = window.text
  window.text = ''
  return text
}

function readWindow(state: Record<string, unknown>): ModerationWindow {
  const existing = state[WINDOW_STATE_KEY] as ModerationWindow | undefined
  if (existing) return existing
  const created: ModerationWindow = { text: '', id: 'text-0' }
  state[WINDOW_STATE_KEY] = created
  return created
}

export class StreamModerationGateProcessor extends ModerationProcessor {
  readonly windowChars: number
  readonly minSentenceChars: number

  constructor(options: ModerationOptions, windowChars = DEFAULT_WINDOW_CHARS) {
    // A non-zero bufferSize is not the window itself, it is what selects the framework
    // branch that judges `part.payload.text`. With 0 it judges `buildContextFromChunks
    // (streamParts)` instead, which is the raw deltas and not the window handed over.
    super({ ...options, bufferSize: Math.max(1, options.bufferSize ?? windowChars) })
    this.windowChars = windowChars
    this.minSentenceChars = MIN_SENTENCE_CHARS
  }

  override async processOutputStream(args: ProcessOutputStreamArgs): Promise<ChunkType> {
    const window = readWindow(args.state)

    if (args.part.type === 'text-delta') {
      window.id = args.part.payload.id ?? window.id
      const flush = planWindow(window, args.part.payload.text ?? '', {
        windowChars: this.windowChars,
        minSentenceChars: this.minSentenceChars,
      })
      if (flush) await this.judge(args, flush, window.id)
      // Always the original part: the answer must stream exactly as the model wrote it.
      return args.part
    }

    // A real boundary means no further delta will arrive for this stretch of text, so
    // the remainder is judged now rather than waiting for a threshold it cannot reach.
    if (TEXT_BOUNDARIES.has(args.part.type) && window.text.trim()) {
      const flush = take(window)
      await this.judge(args, flush, window.id)
    }
    return args.part
  }

  /**
   * Ask the framework's guardrail about one window of finished text. `writer` is pinned
   * to undefined so the call can never take the buffered branch that holds parts back;
   * the return value is discarded because this processor forwards the real part itself.
   */
  async judge(args: ProcessOutputStreamArgs, text: string, id: string): Promise<void> {
    const part: ChunkType = {
      runId: args.part.runId,
      from: args.part.from,
      type: 'text-delta',
      payload: { id, text },
    }
    await super.processOutputStream({ ...args, part, writer: undefined })
  }
}

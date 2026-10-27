import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MockInstance } from 'vitest'
import type { ProcessOutputStreamArgs } from '@mastra/core/processors'
import type { ChunkType } from '@mastra/core/stream'
import {
  StreamModerationGateProcessor,
  planWindow,
} from '../../../src/mastra/processors/stream-moderation-gate'

const delta = (text: string, id = 't1'): ChunkType =>
  ({ type: 'text-delta', payload: { id, text }, runId: 'r1', from: 'AGENT' }) as ChunkType

const partOfType = (type: string): ChunkType =>
  ({ type, payload: {}, runId: 'r1', from: 'AGENT' }) as unknown as ChunkType

const argsFor = (
  part: ChunkType,
  state: Record<string, unknown> = {},
): ProcessOutputStreamArgs =>
  ({
    part,
    streamParts: [part],
    state,
    abort: vi.fn(),
  }) as unknown as ProcessOutputStreamArgs

describe('planWindow', () => {
  it('collects until the window is full, then hands the whole window over', () => {
    const window = { text: '', id: 't1' }
    expect(planWindow(window, 'short', { windowChars: 25 })).toBeNull()
    expect(planWindow(window, ' more text here', { windowChars: 25 })).toBeNull()
    const flush = planWindow(window, ' and over', { windowChars: 25 })
    expect(window.text).toBe('')
    expect(flush).toBe('short more text here and over')
  })

  it('judges a finished sentence early once it is long enough to be worth a call', () => {
    const window = { text: '', id: 't1' }
    const sentence = 'The Acme renewal is due on Friday and the owner has not replied yet.'
    expect(planWindow(window, sentence, { windowChars: 400, minSentenceChars: 40 })).toBe(
      sentence,
    )
  })

  it('does not spend a call on a sentence shorter than the floor', () => {
    const window = { text: '', id: 't1' }
    expect(planWindow(window, 'Done.', { windowChars: 400, minSentenceChars: 40 })).toBeNull()
  })

  it('drops whitespace-only runs instead of queueing them for moderation', () => {
    const window = { text: '', id: 't1' }
    expect(planWindow(window, '\n  \n', { windowChars: 400 })).toBeNull()
    expect(window.text).toBe('')
  })
})

describe('StreamModerationGateProcessor', () => {
  let judge: MockInstance<(args: ProcessOutputStreamArgs, text: string, id: string) => Promise<void>>

  beforeEach(() => {
    // Spy the delegation seam: the guardrail agent behind it would need a live model.
    judge = vi
      .spyOn(StreamModerationGateProcessor.prototype, 'judge')
      .mockResolvedValue(undefined)
  })

  const newProcessor = (windowChars = 400) =>
    new StreamModerationGateProcessor(
      { model: 'openai/gpt-4o-mini', strategy: 'block' },
      windowChars,
    )

  it('keeps the guardrail configuration from the base processor', () => {
    const processor = newProcessor()
    const state = processor as unknown as {
      strategy?: string
      bufferSize?: number
      windowChars?: number
    }
    expect(state.strategy).toBe('block')
    // Non-zero bufferSize selects the framework branch that reads the part text we
    // hand it, which is the whole point of the delegation below.
    expect(state.bufferSize).toBeGreaterThan(0)
    expect(state.windowChars).toBe(400)
  })

  it('forwards every text-delta exactly as it arrived', async () => {
    const processor = newProcessor(20)
    const state: Record<string, unknown> = {}
    const first = argsFor(delta('one'), state)
    const second = argsFor(delta('two words here'), state)

    await expect(processor.processOutputStream(first)).resolves.toBe(first.part)
    await expect(processor.processOutputStream(second)).resolves.toBe(second.part)
  })

  it('asks the guardrail once per window instead of once per delta', async () => {
    const processor = newProcessor(20)
    const state: Record<string, unknown> = {}
    for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      await processor.processOutputStream(argsFor(delta(word), state))
    }
    const judged = judge.mock.calls.map((call) => call[1]).join('')
    expect(judge.mock.calls.length).toBeLessThanOrEqual(2)
    // Nothing is lost: the judged windows together are the answer text.
    expect(judged).toBe('alphabetagammadeltaepsilon')
  })

  it('judges the tail at a step boundary, when no further delta will arrive', async () => {
    const processor = newProcessor(400)
    const state: Record<string, unknown> = {}
    await processor.processOutputStream(argsFor(delta('a short answer'), state))
    expect(judge).not.toHaveBeenCalled()

    await processor.processOutputStream(argsFor(partOfType('text-end'), state))
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]?.[1]).toBe('a short answer')
  })

  it('passes non-text parts through untouched and unrejudged', async () => {
    const processor = newProcessor(400)
    const state: Record<string, unknown> = {}
    const finish = argsFor(partOfType('finish'), state)
    await expect(processor.processOutputStream(finish)).resolves.toBe(finish.part)
    expect(judge).not.toHaveBeenCalled()
  })

  it('never moderates an empty window', async () => {
    const processor = newProcessor(400)
    const state: Record<string, unknown> = {}
    await processor.processOutputStream(argsFor(delta('text'), state))
    await processor.processOutputStream(argsFor(delta('   '), state))
    await processor.processOutputStream(argsFor(partOfType('finish-step'), state))
    expect(judge.mock.calls.every((call) => call[1].trim().length > 0)).toBe(true)
  })

  it('judges what it has at a step boundary and starts a fresh window', async () => {
    // Tool calls sit between text blocks, so a boundary is the last chance to see the
    // text before it. The window must empty there rather than carry on growing, or a
    // long turn would re-judge the same sentences over and over.
    const processor = newProcessor(400)
    const state: Record<string, unknown> = {}
    await processor.processOutputStream(argsFor(delta('a'.repeat(200)), state))
    await processor.processOutputStream(argsFor(partOfType('step-finish'), state))
    await processor.processOutputStream(argsFor(delta('b'.repeat(200)), state))
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]?.[1]).toHaveLength(200)

    await processor.processOutputStream(argsFor(partOfType('finish'), state))
    expect(judge).toHaveBeenCalledTimes(2)
    expect(judge.mock.calls[1]?.[1]).toHaveLength(200)
  })

  it('ignores the bookkeeping parts the runner emits between deltas', async () => {
    // Regression: the run hands the output pipeline a `response-metadata` part after
    // every single text-delta. Treating that as a boundary flushed one window per
    // token, which cost a nine-delta turn 14.8 s of its 26.6 s.
    const processor = newProcessor(400)
    const state: Record<string, unknown> = {}
    for (const word of ['one', 'two', 'three']) {
      await processor.processOutputStream(argsFor(delta(word), state))
      await processor.processOutputStream(argsFor(partOfType('response-metadata'), state))
    }
    expect(judge).not.toHaveBeenCalled()
  })
})

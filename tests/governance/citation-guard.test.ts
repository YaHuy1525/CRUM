import { describe, it, expect, vi } from 'vitest'
import type { MastraDBMessage } from '@mastra/core/agent'
import type { ProcessOutputStepArgs, ProcessToolResultArgs } from '@mastra/core/processors'
import { CitationGuardProcessor } from '../../src/mastra/processors/citation-guard'

const SOURCES_STATE_KEY = 'crumRetrievalHasSources'

const RETRIEVED = [{ id: 'doc-abc' }, { id: 'doc-def' }]

function makeMessage(text: string): MastraDBMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text }] },
  } as MastraDBMessage
}

function makeOutputArgs(overrides: Partial<ProcessOutputStepArgs> = {}): ProcessOutputStepArgs {
  return {
    messages: [],
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    systemMessages: [],
    // Minimal stubs for required fields the processor does not read.
    messageList: {},
    abort: vi.fn(),
    ...overrides,
  } as unknown as ProcessOutputStepArgs
}

function makeToolResultArgs(
  overrides: Partial<ProcessToolResultArgs> = {},
): ProcessToolResultArgs {
  return {
    messages: [],
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    systemMessages: [],
    toolName: 'knowledge.retrieve',
    toolCallId: 'call-1',
    args: {},
    result: { sources: RETRIEVED },
    messageList: {},
    abort: vi.fn(),
    ...overrides,
  } as unknown as ProcessToolResultArgs
}

describe('CitationGuardProcessor', () => {
  it('has the correct id', () => {
    expect(new CitationGuardProcessor().id).toBe('crum-citation-guard')
  })

  it('has a name', () => {
    expect(new CitationGuardProcessor().name).toBe('Citation Guard Processor')
  })

  it('implements processOutputStep', () => {
    expect(typeof new CitationGuardProcessor().processOutputStep).toBe('function')
  })

  describe('processToolResult', () => {
    it('records that retrieval returned sources', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeToolResultArgs()
      await processor.processToolResult(args)
      expect(args.state[SOURCES_STATE_KEY]).toBe(true)
    })

    it('ignores a retrieval that returned no sources', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeToolResultArgs({ result: { sources: [] } })
      await processor.processToolResult(args)
      expect(args.state[SOURCES_STATE_KEY]).toBeUndefined()
    })

    it('ignores other tools', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeToolResultArgs({ toolName: 'crm.log_followup' })
      await processor.processToolResult(args)
      expect(args.state[SOURCES_STATE_KEY]).toBeUndefined()
    })
  })

  describe('processOutputStep', () => {
    it('does nothing when no retrieval returned sources', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeOutputArgs({ text: 'Some response without citations.' })
      await processor.processOutputStep(args)
      expect(args.abort).not.toHaveBeenCalled()
    })

    it('does nothing while the step still calls tools', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeOutputArgs({
        state: { [SOURCES_STATE_KEY]: true },
        text: 'A response that forgot to cite its sources.',
        toolCalls: [{ toolName: 'crm.log_followup', toolCallId: 'call-1', args: {} }],
      })
      await processor.processOutputStep(args)
      expect(args.abort).not.toHaveBeenCalled()
    })

    it('does nothing on an empty step', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeOutputArgs({ state: { [SOURCES_STATE_KEY]: true }, text: '' })
      await processor.processOutputStep(args)
      expect(args.abort).not.toHaveBeenCalled()
    })

    it('clears the flag once the response carries citations', async () => {
      const processor = new CitationGuardProcessor()
      const state = { [SOURCES_STATE_KEY]: true }
      const args = makeOutputArgs({
        state,
        text: 'The answer is here [doc-abc:12] and also [doc-def:34].',
      })
      await processor.processOutputStep(args)
      expect(args.abort).not.toHaveBeenCalled()
      expect(state[SOURCES_STATE_KEY]).toBeUndefined()
    })

    it('aborts with retry when sources exist but text has no citations (first retry)', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeOutputArgs({
        state: { [SOURCES_STATE_KEY]: true },
        text: 'A response that forgot to cite its sources.',
        retryCount: 0,
      })
      await processor.processOutputStep(args)
      expect(args.abort).toHaveBeenCalledTimes(1)
      expect(args.abort).toHaveBeenCalledWith(
        expect.stringContaining('CITATION_MISSING'),
        expect.objectContaining({ retry: true }),
      )
    })

    it('aborts with tripwire on second retry when citations still missing', async () => {
      const processor = new CitationGuardProcessor()
      const args = makeOutputArgs({
        state: { [SOURCES_STATE_KEY]: true },
        text: 'Still no citations after retry.',
        retryCount: 1,
      })
      await processor.processOutputStep(args)
      expect(args.abort).toHaveBeenCalledTimes(1)
      expect(args.abort).toHaveBeenCalledWith(
        'citation-missing-tripwire',
        expect.objectContaining({ metadata: expect.any(Object) }),
      )
    })

    it('returns messages unchanged', async () => {
      const processor = new CitationGuardProcessor()
      const msgs = [makeMessage('hi')]
      const args = makeOutputArgs({ messages: msgs })
      expect(await processor.processOutputStep(args)).toBe(msgs)
    })
  })

  it('enforces the contract across the two hooks of one request', async () => {
    const processor = new CitationGuardProcessor()
    const state: Record<string, unknown> = {}

    await processor.processToolResult(makeToolResultArgs({ state }))

    const midStep = makeOutputArgs({
      state,
      text: 'Let me look that up.',
      toolCalls: [{ toolName: 'knowledge.retrieve', toolCallId: 'call-1', args: {} }],
    })
    await processor.processOutputStep(midStep)
    expect(midStep.abort).not.toHaveBeenCalled()

    const finalStep = makeOutputArgs({
      state,
      text: 'The customer is Acme Corp.',
      retryCount: 0,
    })
    await processor.processOutputStep(finalStep)
    expect(finalStep.abort).toHaveBeenCalledWith(
      expect.stringContaining('CITATION_MISSING'),
      expect.objectContaining({ retry: true }),
    )
  })
})

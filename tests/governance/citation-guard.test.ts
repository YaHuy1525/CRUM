import { describe, it, expect, vi } from 'vitest'
import { CitationGuardProcessor } from '../../src/mastra/processors/citation-guard'

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    text: '',
    toolCalls: [],
    messages: [],
    retryCount: 0,
    abort: vi.fn(),
    ...overrides,
  } as any
}

describe('CitationGuardProcessor', () => {
  it('has the correct id', () => {
    const processor = new CitationGuardProcessor()
    expect(processor.id).toBe('crum-citation-guard')
  })

  it('has a name', () => {
    const processor = new CitationGuardProcessor()
    expect(processor.name).toBe('Citation Guard Processor')
  })

  it('implements processOutputStep', () => {
    const processor = new CitationGuardProcessor()
    expect(typeof processor.processOutputStep).toBe('function')
  })

  it('does nothing when knowledge.retrieve was not called', async () => {
    const processor = new CitationGuardProcessor()
    const args = makeArgs({
      text: 'Some response without citations.',
      toolCalls: [{ toolName: 'crm.log_followup', result: {} }],
    })
    await processor.processOutputStep(args)
    expect(args.abort).not.toHaveBeenCalled()
  })

  it('does nothing when knowledge.retrieve returned no sources', async () => {
    const processor = new CitationGuardProcessor()
    const args = makeArgs({
      text: 'No sources found response.',
      toolCalls: [
        { toolName: 'knowledge.retrieve', result: { sources: [] } },
      ],
    })
    await processor.processOutputStep(args)
    expect(args.abort).not.toHaveBeenCalled()
  })

  it('does nothing when knowledge.retrieve returned sources but text has citations', async () => {
    const processor = new CitationGuardProcessor()
    const args = makeArgs({
      text: 'The answer is here [doc-abc:12] and also [doc-def:34].',
      toolCalls: [
        {
          toolName: 'knowledge.retrieve',
          result: { sources: [{ id: 'doc-abc' }, { id: 'doc-def' }] },
        },
      ],
    })
    await processor.processOutputStep(args)
    expect(args.abort).not.toHaveBeenCalled()
  })

  it('aborts with retry when sources exist but text has no citations (first retry)', async () => {
    const processor = new CitationGuardProcessor()
    const args = makeArgs({
      text: 'A response that forgot to cite its sources.',
      toolCalls: [
        {
          toolName: 'knowledge.retrieve',
          result: { sources: [{ id: 'doc-abc' }] },
        },
      ],
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
    const args = makeArgs({
      text: 'Still no citations after retry.',
      toolCalls: [
        {
          toolName: 'knowledge.retrieve',
          result: { sources: [{ id: 'doc-abc' }] },
        },
      ],
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
    const msgs = [{ role: 'assistant', content: 'hi' }] as any
    const args = makeArgs({ messages: msgs })
    const result = await processor.processOutputStep(args)
    expect(result).toBe(msgs)
  })
})

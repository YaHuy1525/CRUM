// tests/api/message-mapping.test.ts
import { describe, expect, it } from 'vitest'
import type { MastraDBMessage } from '@mastra/core/agent/message-list'
import {
  extractTraceIds,
  hasTraceIds,
  mapMessage,
  mapMessages,
  mapPart,
  mapRecallPage,
  messagesHaveTraceIds,
  type RecallPage,
  type UiToolPart,
} from '../../src/api/message-mapping'

/**
 * The mapping module is new code with no vendor helper, so these tests are the
 * contract (spec: "Risks and assumptions"). They cover every part family the
 * console renders — text, reasoning, tool call, tool result — plus the degrade
 * rules: unknown parts skip without throwing, and trace ids are reported
 * honestly (Mastra does not write them into stored metadata today).
 */

const AT = new Date('2026-10-20T09:00:00.000Z')

/** Build a stored v2 message. Parts are the framework's own union shape. */
function db(parts: unknown[], over: Partial<MastraDBMessage> & { contentMetadata?: Record<string, unknown> } = {}): MastraDBMessage {
  const { contentMetadata, ...rest } = over
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: AT,
    content: {
      format: 2,
      parts,
      ...(contentMetadata ? { metadata: contentMetadata } : {}),
    },
    ...rest,
  } as unknown as MastraDBMessage
}

function toolPart(invocation: Record<string, unknown>) {
  return { type: 'tool-invocation', toolInvocation: invocation }
}

describe('mapPart — text and reasoning', () => {
  it('maps a text part and preserves its string', () => {
    expect(mapPart({ type: 'text', text: 'Hello there' })).toEqual({ type: 'text', text: 'Hello there' })
  })

  it('maps a reasoning part', () => {
    expect(mapPart({ type: 'reasoning', text: 'Thinking it through' })).toEqual({
      type: 'reasoning',
      text: 'Thinking it through',
    })
  })

  it('coerces a text part with a non-string body to empty text rather than throwing', () => {
    expect(mapPart({ type: 'text', text: 42 })).toEqual({ type: 'text', text: '' })
  })
})

describe('mapPart — tool invocations', () => {
  it('maps a pending call (state "call") to input-available with its args', () => {
    const part = mapPart(
      toolPart({ state: 'call', toolCallId: 'c1', toolName: 'lookup_customer', args: { id: 'cust_1' } }),
    ) as UiToolPart
    expect(part).toEqual({
      type: 'dynamic-tool',
      toolName: 'lookup_customer',
      toolCallId: 'c1',
      state: 'input-available',
      input: { id: 'cust_1' },
    })
  })

  it('maps a partial call to input-streaming', () => {
    const part = mapPart(
      toolPart({ state: 'partial-call', toolCallId: 'c2', toolName: 'search', args: { q: 'ac' } }),
    ) as UiToolPart
    expect(part.state).toBe('input-streaming')
    expect(part.input).toEqual({ q: 'ac' })
  })

  it('maps a successful result to output-available carrying args and result', () => {
    const part = mapPart(
      toolPart({
        state: 'result',
        toolCallId: 'c3',
        toolName: 'lookup_customer',
        args: { id: 'cust_1' },
        result: { name: 'Acme' },
      }),
    ) as UiToolPart
    expect(part).toEqual({
      type: 'dynamic-tool',
      toolName: 'lookup_customer',
      toolCallId: 'c3',
      state: 'output-available',
      input: { id: 'cust_1' },
      output: { name: 'Acme' },
    })
  })

  it('maps a result flagged isError to output-error with the error text', () => {
    const part = mapPart(
      toolPart({
        state: 'result',
        toolCallId: 'c4',
        toolName: 'send_email',
        args: {},
        isError: true,
        errorText: 'SMTP refused',
      }),
    ) as UiToolPart
    expect(part.state).toBe('output-error')
    expect(part.errorText).toBe('SMTP refused')
    expect(part.output).toBeUndefined()
  })

  it('maps a denied call to output-error using the approval reason', () => {
    const part = mapPart(
      toolPart({
        state: 'output-denied',
        toolCallId: 'c5',
        toolName: 'delete_record',
        args: {},
        approval: { id: 'a1', approved: false, reason: 'policy:needs-signature' },
      }),
    ) as UiToolPart
    expect(part.state).toBe('output-error')
    expect(part.errorText).toBe('policy:needs-signature')
  })

  it('degrades an unknown tool state to input-available rather than throwing', () => {
    const part = mapPart(
      toolPart({ state: 'some-future-state', toolCallId: 'c6', toolName: 'x', args: { a: 1 } }),
    ) as UiToolPart
    expect(part.state).toBe('input-available')
  })

  it('passes through an already-v5 dynamic-tool part', () => {
    const part = mapPart({
      type: 'dynamic-tool',
      toolName: 'lookup',
      toolCallId: 'c7',
      state: 'output-available',
      input: { id: 1 },
      output: { ok: true },
    }) as UiToolPart
    expect(part).toMatchObject({ type: 'dynamic-tool', toolCallId: 'c7', state: 'output-available', output: { ok: true } })
  })
})

describe('mapPart — unknown parts skip', () => {
  it.each([
    ['step-start', { type: 'step-start' }],
    ['error', { type: 'error', error: { name: 'E', message: 'boom' } }],
    ['file', { type: 'file', url: 'x', mediaType: 'image/png' }],
    ['source-url', { type: 'source-url', sourceId: 's', url: 'u' }],
    ['data-*', { type: 'data-custom', data: { anything: true } }],
    ['totally unknown', { type: 'mystery', value: 1 }],
    ['null', null],
    ['non-object', 'a string'],
  ])('skips a %s part to null', (_label, part) => {
    expect(mapPart(part)).toBeNull()
  })
})

describe('mapMessage', () => {
  it('preserves id, role and createdAt (as an ISO string)', () => {
    const ui = mapMessage(db([{ type: 'text', text: 'hi' }], { id: 'msg_42', role: 'user', createdAt: AT }))
    expect(ui.id).toBe('msg_42')
    expect(ui.role).toBe('user')
    expect(ui.createdAt).toBe('2026-10-20T09:00:00.000Z')
  })

  it('maps a mixed message: reasoning + text + tool call + tool result, dropping the step marker', () => {
    const ui = mapMessage(
      db([
        { type: 'step-start' },
        { type: 'reasoning', text: 'Let me look that up.' },
        { type: 'text', text: 'Checking the record.' },
        toolPart({ state: 'result', toolCallId: 'c1', toolName: 'lookup', args: { id: 1 }, result: { name: 'Acme' } }),
      ]),
    )
    expect(ui.parts.map((p) => p.type)).toEqual(['reasoning', 'text', 'dynamic-tool'])
  })

  it('maps an unknown role to system instead of throwing', () => {
    const ui = mapMessage(db([{ type: 'text', text: 'x' }], { role: 'signal' as unknown as 'assistant' }))
    expect(ui.role).toBe('system')
  })

  it('tolerates a message with no parts array', () => {
    const ui = mapMessage({ id: 'm', role: 'user', createdAt: AT, content: { format: 2 } } as unknown as MastraDBMessage)
    expect(ui.parts).toEqual([])
  })
})

describe('mapMessages', () => {
  it('maps a list in order', () => {
    const list = mapMessages([
      db([{ type: 'text', text: 'a' }], { id: 'm1', role: 'user' }),
      db([{ type: 'text', text: 'b' }], { id: 'm2', role: 'assistant' }),
    ])
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('trace id extraction', () => {
  it('finds camelCase trace and span ids in content metadata', () => {
    const msg = db([{ type: 'text', text: 'x' }], { contentMetadata: { traceId: 'tr_1', spanId: 'sp_1' } })
    expect(extractTraceIds(msg)).toEqual({ traceId: 'tr_1', spanId: 'sp_1' })
    expect(hasTraceIds(msg)).toBe(true)
  })

  it('finds snake_case spellings too', () => {
    const msg = db([{ type: 'text', text: 'x' }], { contentMetadata: { trace_id: 'tr_2' } })
    expect(extractTraceIds(msg)).toEqual({ traceId: 'tr_2' })
    expect(hasTraceIds(msg)).toBe(true)
  })

  it('returns null when metadata carries no trace ids (the real stored shape today)', () => {
    const msg = db([{ type: 'text', text: 'x' }], { contentMetadata: { anything: 'else' } })
    expect(extractTraceIds(msg)).toBeNull()
    expect(hasTraceIds(msg)).toBe(false)
  })

  it('treats a lone spanId as not feedback-usable (traceId is required)', () => {
    const msg = db([{ type: 'text', text: 'x' }], { contentMetadata: { spanId: 'sp_only' } })
    expect(extractTraceIds(msg)).toEqual({ spanId: 'sp_only' })
    expect(hasTraceIds(msg)).toBe(false)
  })

  it('attaches trace ids to the mapped message metadata when present', () => {
    const ui = mapMessage(db([{ type: 'text', text: 'x' }], { contentMetadata: { traceId: 'tr_9', spanId: 'sp_9' } }))
    expect(ui.metadata).toEqual({ traceId: 'tr_9', spanId: 'sp_9' })
  })

  it('omits metadata when no trace ids exist', () => {
    const ui = mapMessage(db([{ type: 'text', text: 'x' }]))
    expect(ui.metadata).toBeUndefined()
  })

  it('messagesHaveTraceIds is true when any message on the page has one', () => {
    const withTrace = db([{ type: 'text', text: 'a' }], { id: 'a', contentMetadata: { traceId: 'tr' } })
    const without = db([{ type: 'text', text: 'b' }], { id: 'b' })
    expect(messagesHaveTraceIds([without, withTrace])).toBe(true)
    expect(messagesHaveTraceIds([without])).toBe(false)
  })
})

describe('mapRecallPage — pagination passthrough', () => {
  const page: RecallPage = {
    messages: [db([{ type: 'text', text: 'hi' }], { id: 'm1' })],
    total: 120,
    page: 2,
    perPage: 50,
    hasMore: true,
  }

  it('passes total/page/perPage/hasMore through and maps the messages', () => {
    const mapped = mapRecallPage(page)
    expect(mapped.total).toBe(120)
    expect(mapped.page).toBe(2)
    expect(mapped.perPage).toBe(50)
    expect(mapped.hasMore).toBe(true)
    expect(mapped.messages).toHaveLength(1)
    expect(mapped.messages[0]!.parts[0]).toEqual({ type: 'text', text: 'hi' })
  })

  it('reports trace_available false when no message carries a trace id', () => {
    expect(mapRecallPage(page).trace_available).toBe(false)
  })

  it('reports trace_available true when a message carries a trace id', () => {
    const traced: RecallPage = {
      ...page,
      messages: [db([{ type: 'text', text: 'hi' }], { id: 'm1', contentMetadata: { traceId: 'tr' } })],
    }
    expect(mapRecallPage(traced).trace_available).toBe(true)
  })

  it('preserves perPage: false (fetch-all) untouched', () => {
    expect(mapRecallPage({ ...page, perPage: false }).perPage).toBe(false)
  })
})

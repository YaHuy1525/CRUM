import type { MastraDBMessage, MastraToolInvocation } from '@mastra/core/agent/message-list'


export type UiMessageRole = 'user' | 'assistant' | 'system'

export interface UiTextPart {
  type: 'text'
  text: string
}

export interface UiReasoningPart {
  type: 'reasoning'
  text: string
}

export type UiToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error'

export interface UiToolPart {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: UiToolState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type UiPart = UiTextPart | UiReasoningPart | UiToolPart

export interface TraceIds {
  traceId?: string
  spanId?: string
}

export interface UiMessage {
  id: string
  role: UiMessageRole
  createdAt: string
  parts: UiPart[]
  metadata?: TraceIds
}

export interface RecallPage {
  messages: MastraDBMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
}

export interface MappedPage {
  messages: UiMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
  trace_available: boolean
}

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  if (typeof value === 'number') return new Date(value).toISOString()
  return new Date(0).toISOString()
}

function toUiRole(role: unknown): UiMessageRole {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : 'system'
}

function readMetadata(message: MastraDBMessage): Record<string, unknown> {
  const content = message?.content as { metadata?: Record<string, unknown> } | undefined
  const topLevel = (message as { metadata?: Record<string, unknown> }).metadata
  return { ...(topLevel ?? {}), ...(content?.metadata ?? {}) }
}

export function extractTraceIds(message: MastraDBMessage): TraceIds | null {
  const metadata = readMetadata(message)
  const traceId = pickString(metadata, ['traceId', 'trace_id', 'traceID'])
  const spanId = pickString(metadata, ['spanId', 'span_id', 'spanID'])
  if (!traceId && !spanId) return null
  const ids: TraceIds = {}
  if (traceId) ids.traceId = traceId
  if (spanId) ids.spanId = spanId
  return ids
}

export function hasTraceIds(message: MastraDBMessage): boolean {
  return Boolean(extractTraceIds(message)?.traceId)
}

export function messagesHaveTraceIds(messages: MastraDBMessage[]): boolean {
  return messages.some(hasTraceIds)
}

function mapToolInvocation(invocation: MastraToolInvocation): UiToolPart {
  const toolName = invocation.toolName ?? 'unknown'
  const toolCallId = invocation.toolCallId ?? ''
  const input: unknown = (invocation.args ?? invocation.rawInput) as unknown

  switch (invocation.state) {
    case 'partial-call':
      return { type: 'dynamic-tool', toolName, toolCallId, state: 'input-streaming', input }
    case 'result': {
      if (invocation.isError) {
        return {
          type: 'dynamic-tool',
          toolName,
          toolCallId,
          state: 'output-error',
          input,
          errorText: invocation.errorText ?? 'Tool execution failed',
        }
      }
      return { type: 'dynamic-tool', toolName, toolCallId, state: 'output-available', input, output: invocation.result }
    }
    case 'output-error':
      return {
        type: 'dynamic-tool',
        toolName,
        toolCallId,
        state: 'output-error',
        input,
        errorText: invocation.errorText ?? 'Tool execution failed',
      }
    case 'output-denied':
      return {
        type: 'dynamic-tool',
        toolName,
        toolCallId,
        state: 'output-error',
        input,
        errorText: invocation.errorText ?? invocation.approval?.reason ?? 'Tool call denied',
      }
    default:
      return { type: 'dynamic-tool', toolName, toolCallId, state: 'input-available', input }
  }
}

function mapNativeToolPart(part: Record<string, unknown>): UiToolPart | null {
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
  const toolName =
    typeof part.toolName === 'string'
      ? part.toolName
      : typeof part.type === 'string' && part.type.startsWith('tool-')
        ? part.type.slice('tool-'.length)
        : 'unknown'
  const rawState = typeof part.state === 'string' ? part.state : 'input-available'
  const state: UiToolState =
    rawState === 'input-streaming' || rawState === 'input-available' || rawState === 'output-available' || rawState === 'output-error'
      ? rawState
      : 'input-available'
  const tool: UiToolPart = { type: 'dynamic-tool', toolName, toolCallId, state, input: part.input }
  if (state === 'output-available') tool.output = part.output
  if (state === 'output-error') tool.errorText = typeof part.errorText === 'string' ? part.errorText : 'Tool execution failed'
  return tool
}

export function mapPart(part: unknown): UiPart | null {
  if (!part || typeof part !== 'object') return null
  const record = part as Record<string, unknown>
  const type = record.type

  if (type === 'text') {
    const text = typeof record.text === 'string' ? record.text : ''
    return { type: 'text', text }
  }

  if (type === 'reasoning') {
    const text = typeof record.text === 'string' ? record.text : ''
    return { type: 'reasoning', text }
  }

  if (type === 'tool-invocation') {
    const invocation = record.toolInvocation as MastraToolInvocation | undefined
    if (!invocation || typeof invocation !== 'object') return null
    return mapToolInvocation(invocation)
  }

  if (type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'))) {
    return mapNativeToolPart(record)
  }

  return null
}

export function mapParts(parts: unknown[]): UiPart[] {
  const mapped: UiPart[] = []
  for (const part of parts) {
    const ui = mapPart(part)
    if (ui) mapped.push(ui)
  }
  return mapped
}

export function mapMessage(message: MastraDBMessage): UiMessage {
  const content = (message?.content ?? {}) as { parts?: unknown[] }
  const parts = Array.isArray(content.parts) ? content.parts : []

  const ui: UiMessage = {
    id: typeof message?.id === 'string' ? message.id : '',
    role: toUiRole(message?.role),
    createdAt: toIso(message?.createdAt),
    parts: mapParts(parts),
  }

  const trace = extractTraceIds(message)
  if (trace) ui.metadata = trace
  return ui
}

export function mapMessages(messages: MastraDBMessage[]): UiMessage[] {
  return (messages ?? []).map(mapMessage)
}

export function mapRecallPage(page: RecallPage): MappedPage {
  return {
    messages: mapMessages(page.messages ?? []),
    total: page.total,
    page: page.page,
    perPage: page.perPage,
    hasMore: page.hasMore,
    trace_available: messagesHaveTraceIds(page.messages ?? []),
  }
}

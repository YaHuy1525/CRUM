// src/api/message-mapping.ts
import type { MastraDBMessage, MastraToolInvocation } from '@mastra/core/agent/message-list'

/**
 * Stored-message → chat-UI-message mapping. §Chats/Backend.
 *
 * The memory layer persists conversation turns as `MastraDBMessage`: a v2
 * content envelope whose `parts` are the framework's own union (v4 UI parts,
 * Mastra tool-invocation parts, step/error markers, data parts). The browser's
 * `useChat` speaks the AI SDK v5 `UIMessage` shape instead, and no vendor helper
 * converts between the two — the pinned `@mastra/core` / `@mastra/memory` export
 * no `dbMessageToUiMessage`. This module is that converter, and its unit tests
 * are the contract (see tests/api/message-mapping.test.ts).
 *
 * Design rules, all in service of "a reopen of a saved transcript never throws
 * and never invents content":
 * - Text, reasoning and tool parts are mapped faithfully; every other part type
 *   degrades to a text-free skip rather than an error or a guessed string.
 * - Tool state is normalised onto the four v5 states the console renders
 *   (input-streaming / input-available / output-available / output-error), so a
 *   stored approval or denial still displays instead of vanishing.
 * - `id`, `role` and `createdAt` are preserved; `createdAt` is serialised to an
 *   ISO string because this shape crosses an HTTP boundary.
 * - Trace/span ids are extracted from stored metadata *when present*. Mastra
 *   does not currently write OpenTelemetry ids into message metadata, so in
 *   practice `extractTraceIds` returns null and `trace_available` is false. That
 *   is the honest Phase 3 signal: the feedback control must not post a vote it
 *   cannot attribute to a real span. `hasTraceIds` keys off `traceId` because
 *   the feedback endpoint requires it (spanId is optional there).
 */

/** The three roles an AI SDK v5 `UIMessage` accepts. */
export type UiMessageRole = 'user' | 'assistant' | 'system'

export interface UiTextPart {
  type: 'text'
  text: string
}

export interface UiReasoningPart {
  type: 'reasoning'
  text: string
}

/** The four tool states the console's collapsed inspector renders. */
export type UiToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error'

export interface UiToolPart {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: UiToolState
  /** Tool arguments (`args`), or the partial/raw input while streaming. */
  input?: unknown
  /** Tool result, present only in `output-available`. */
  output?: unknown
  /** Failure text, present only in `output-error`. */
  errorText?: string
}

export type UiPart = UiTextPart | UiReasoningPart | UiToolPart

/** Trace identifiers lifted from stored metadata, when the framework wrote them. */
export interface TraceIds {
  traceId?: string
  spanId?: string
}

export interface UiMessage {
  id: string
  role: UiMessageRole
  /** ISO string, because this shape is JSON-serialised over HTTP. */
  createdAt: string
  parts: UiPart[]
  /** Present only when trace ids were found; feeds the Phase 3 feedback control. */
  metadata?: TraceIds
}

/**
 * The page envelope `Memory.recall` resolves to. Reused by the threads router so
 * the recall contract and the mapping contract cannot drift apart.
 */
export interface RecallPage {
  messages: MastraDBMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
}

/** The router's `/messages` response body: mapped messages plus pagination and trace flag. */
export interface MappedPage {
  messages: UiMessage[]
  total: number
  page: number
  perPage: number | false
  hasMore: boolean
  trace_available: boolean
}

/** Read a non-empty string field from a loose record, else undefined. */
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

/**
 * Merge every place a stored message could carry metadata: the v2 content
 * envelope and (defensively) a top-level field. Content metadata wins on
 * conflict because that is where the framework writes message-scoped data.
 */
function readMetadata(message: MastraDBMessage): Record<string, unknown> {
  const content = message?.content as { metadata?: Record<string, unknown> } | undefined
  const topLevel = (message as { metadata?: Record<string, unknown> }).metadata
  return { ...(topLevel ?? {}), ...(content?.metadata ?? {}) }
}

/**
 * Extract trace/span ids from a stored message's metadata, or null when neither
 * is present. Returns whatever it finds; `hasTraceIds` is the stricter gate the
 * feedback decision relies on.
 */
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

/**
 * Whether a message can back a feedback vote. Keyed off `traceId` specifically:
 * the feedback endpoint requires it, so a lone `spanId` is not enough.
 */
export function hasTraceIds(message: MastraDBMessage): boolean {
  return Boolean(extractTraceIds(message)?.traceId)
}

/** Whether any message on a page carries a usable trace id. */
export function messagesHaveTraceIds(messages: MastraDBMessage[]): boolean {
  return messages.some(hasTraceIds)
}

/**
 * Normalise a stored tool invocation onto a v5 dynamic-tool part. Every stored
 * state maps onto one of the four states the console renders; an unrecognised
 * state degrades to `input-available` (we know it was called, not how it ended).
 */
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
    // 'call', 'approval-requested', 'approval-responded' and anything unknown:
    // the call exists with its input but has no output yet.
    default:
      return { type: 'dynamic-tool', toolName, toolCallId, state: 'input-available', input }
  }
}

/**
 * A stored part may already be a v5 tool part (`dynamic-tool`, or a static
 * `tool-<name>` normalised upstream). Fold those onto the same output shape
 * rather than dropping them.
 */
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

/**
 * Map a single stored part to a UI part, or null to skip it. Skipping is the
 * only failure mode: an unrecognised part never throws and never fabricates
 * text, so a framework version that adds a part type degrades gracefully.
 */
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

  // Already-v5 tool parts: dynamic-tool or a static tool-<name>.
  if (type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'))) {
    return mapNativeToolPart(record)
  }

  // step-start, error, file, source-*, custom, data-*, and anything unknown.
  return null
}

/** Map every part of a stored message, dropping the ones that skip to null. */
export function mapParts(parts: unknown[]): UiPart[] {
  const mapped: UiPart[] = []
  for (const part of parts) {
    const ui = mapPart(part)
    if (ui) mapped.push(ui)
  }
  return mapped
}

/**
 * Convert one stored message to the chat-UI shape. Pure and total: it never
 * throws, whatever the stored content looks like.
 */
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

/** Convert a list of stored messages, preserving order. */
export function mapMessages(messages: MastraDBMessage[]): UiMessage[] {
  return (messages ?? []).map(mapMessage)
}

/**
 * Map a whole `recall` page: convert the messages, pass the pagination fields
 * through untouched, and report whether any message on the page carried trace
 * ids (the Phase 3 feedback gate).
 */
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

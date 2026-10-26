'use client'

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/**
 * The collapsed tool inspector. §"Design system foundation" ("tool calls as a
 * collapsed mono inspector") and §"Chats section / Frontend".
 *
 * A tool call is evidence, not prose: it belongs in a mono, collapsed drawer the
 * operator opens when they want to see what the agent actually invoked, with what
 * arguments, and what came back — not in the reading flow of the answer. So the
 * default is a single quiet row (chevron, tool name, state badge) that expands to
 * the input, the output, and any error text.
 *
 * The row is a real `<button>` with `aria-expanded`, so it is keyboard operable
 * and its accessible name (tool name + state) is what the migrated tests address
 * by role, replacing the old `[data-tool=…]` class selector. `data-tool` is kept
 * as a stable hook for anything that still wants it, but nothing depends on it.
 */

/** A tool part is either a static `tool-<name>` or a `dynamic-tool`. */
export type ToolPart = ToolUIPart | DynamicToolUIPart

/**
 * Whether a message part is a tool call. A static tool part is typed
 * `tool-${NAME}` and a dynamic one is `dynamic-tool` with a `toolName` field, so
 * both are covered by these two tests rather than a name list that would go stale
 * the next time a tool is added to the agent.
 */
export function isToolPart(part: UIMessage['parts'][number]): part is ToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** The tool's display name, from whichever of the two shapes the part has. */
export function toolNameOf(part: UIMessage['parts'][number]): string {
  if (part.type === 'dynamic-tool') return part.toolName
  return part.type.slice('tool-'.length)
}

/**
 * A short human verdict on the state, in the vocabulary of the framework's own
 * `state` union (`input-streaming`, `input-available`, `result`, `output-error`,
 * and the two approval states). Unknown states render as themselves instead of
 * being mapped onto a guess. The stored-transcript mapping only ever produces four
 * of these, but a *live* stream can carry the approval and result states too.
 */
export function stateLabel(state: string): string {
  switch (state) {
    case 'input-streaming':
      return 'calling…'
    case 'input-available':
      return 'running'
    case 'approval-requested':
      return 'waiting for approval'
    case 'approval-responded':
      return 'approval recorded'
    case 'output-denied':
      return 'denied'
    case 'result':
    case 'output-available':
      return 'done'
    case 'output-error':
      return 'error'
    default:
      return state
  }
}

/** Badge tone per state: failures red, in-flight amber, completion green. */
function stateVariant(state: string): 'default' | 'secondary' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'result':
    case 'output-available':
      return 'success'
    case 'output-error':
    case 'output-denied':
      return 'danger'
    case 'input-streaming':
    case 'approval-requested':
      return 'warning'
    default:
      return 'secondary'
  }
}

/** Pretty-print a tool input/output for the mono drawer, tolerating anything. */
function stringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ToolInspector({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const name = toolNameOf(part)
  // The framework types each tool state as its own variant (an `output-available`
  // part forbids `errorText`, an `output-error` part forbids `output`, and so on).
  // Read the fields through one structural view instead: `isToolPart` already
  // proved this is a tool call, and the inspector renders whatever is present
  // rather than branching on the state discriminant a second time.
  const view = part as { state: string; input?: unknown; output?: unknown; errorText?: string }
  const state = view.state
  const label = stateLabel(state)
  const input = view.input
  const output = view.output
  const errorText = view.errorText

  return (
    <div className="my-1.5 rounded-md border border-border bg-bg-sunken">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        data-tool={name}
        className="focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-bg-hover"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')}
        />
        <span className="font-mono text-xs text-text-secondary">{name}</span>
        <Badge variant={stateVariant(state)} className="ml-auto font-mono text-[11px]">
          {label}
        </Badge>
      </button>

      {open && (
        <div id={panelId} className="border-t border-border px-2.5 py-2 font-mono text-xs">
          {errorText ? (
            <p className="whitespace-pre-wrap break-words text-danger">{errorText}</p>
          ) : (
            <>
              {input !== undefined && (
                <div className="mb-2">
                  <p className="mb-0.5 text-[11px] uppercase tracking-[0.06em] text-text-muted">input</p>
                  <pre className="whitespace-pre-wrap break-words text-text-secondary">{stringify(input)}</pre>
                </div>
              )}
              {output !== undefined && (
                <div>
                  <p className="mb-0.5 text-[11px] uppercase tracking-[0.06em] text-text-muted">output</p>
                  <pre className="whitespace-pre-wrap break-words text-text-secondary">{stringify(output)}</pre>
                </div>
              )}
              {input === undefined && output === undefined && (
                <p className="text-text-muted">No input or output recorded for this call.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

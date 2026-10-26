'use client'

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'


export type ToolPart = ToolUIPart | DynamicToolUIPart

export function isToolPart(part: UIMessage['parts'][number]): part is ToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

export function toolNameOf(part: UIMessage['parts'][number]): string {
  if (part.type === 'dynamic-tool') return part.toolName
  return part.type.slice('tool-'.length)
}

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

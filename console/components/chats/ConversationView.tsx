'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { notFound } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import { ChevronRight, RotateCw, Send, Sparkles, Square, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ApiError, describeError, getThread, getThreadMessages, post } from '@/lib/api'
import { readAndClearPendingMessage } from '@/lib/pending'
import { STARTERS } from '@/lib/starters'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolInspector, isToolPart } from './ToolInspector'

/**
 * The single conversation surface. §"Chats section / Frontend" and the transport
 * contract proven by the pane it replaces.
 *
 * It owns three things the old `ChatPane` did not:
 *
 * **Hydration.** A deep-linked `/chats/[id]` first reads the thread's metadata
 * (a 404 means the id is missing or belongs to another user — both render
 * not-found, never a leak), then pages the stored transcript into `useChat` via
 * `setMessages`, so a reopened conversation shows its history before the live
 * stream continues in place.
 *
 * **The launch handoff.** `/chats/new` mints the id in the browser and parks the
 * first message in `sessionStorage`; this view reads and clears it and sends it
 * once. A launch is a *brand-new* thread — it has no stored row yet, because the
 * row is created server-side when the first turn lands — so the existence check
 * is deliberately skipped for it. Only a genuine reopen (no pending message)
 * requires the thread to exist.
 *
 * **One origin, no identity.** `api` stays the relative `/chat/crm` (Next rewrites
 * it to Mastra on :4111) and the thread id travels per turn in `x-thread-id`,
 * exactly as before. No `x-tenant-id` is ever set here; `middleware.ts` injects
 * identity server-side. A client that named a tenant could read one.
 *
 * `hydrate` is the seam that lets Home keep working: Home mints a fresh thread id
 * that is not in storage until its first turn, so it renders this view with
 * `hydrate={false}` — no existence check, no transcript fetch, just the live
 * streaming surface the replaced pane provided. Phase 4 turns Home into a pointer
 * dashboard and drops the transcript entirely.
 */

interface ConversationViewProps {
  /** The conversation this surface is bound to. Remount with a React `key` to switch. */
  threadId: string
  /**
   * A first message to send once on mount (the launch flow). When omitted, the
   * `crum:pending:<threadId>` sessionStorage handoff is read instead.
   */
  initialMessage?: string
  /**
   * Whether this view owns a *stored* conversation. True (the default) hydrates
   * the transcript and renders not-found on a 404 metadata read. Home passes false
   * for a freshly minted, not-yet-persisted thread.
   */
  hydrate?: boolean
}

/** A reasoning part is muted, collapsible evidence — quiet by default. */
function ReasoningPart({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle reasoning"
        className="focus-ring inline-flex items-center gap-1 rounded text-xs text-text-muted transition-colors hover:text-text-secondary"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn('transition-transform', open && 'rotate-90')}
        />
        Reasoning
      </button>
      {open && (
        <p className="mt-1 whitespace-pre-wrap border-l border-border pl-3 text-sm italic leading-relaxed text-text-muted">
          {text}
        </p>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    return (
      <div role="group" aria-label="Your message" className="flex justify-end py-1.5">
        <div className="max-w-[80%] rounded-pill rounded-br-md bg-accent-soft px-4 py-2 text-[15px] leading-relaxed text-text-primary">
          {message.parts.map((part, i) =>
            part.type === 'text' && part.text.length > 0 ? (
              <span key={i} className="whitespace-pre-wrap">
                {part.text}
              </span>
            ) : null,
          )}
        </div>
      </div>
    )
  }

  const isSystem = message.role === 'system'
  return (
    <div
      role="group"
      aria-label={isSystem ? 'System message' : 'Assistant message'}
      className="py-2"
    >
      <div className="max-w-[68ch] space-y-1.5">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return part.text.length > 0 ? (
              <p
                key={i}
                className={cn(
                  'whitespace-pre-wrap text-[15px] leading-relaxed',
                  isSystem ? 'text-text-muted' : 'text-text-primary',
                )}
              >
                {part.text}
              </p>
            ) : null
          }
          if (part.type === 'reasoning') {
            return part.text.length > 0 ? <ReasoningPart key={i} text={part.text} /> : null
          }
          if (isToolPart(part)) {
            const key = (part as { toolCallId?: string }).toolCallId ?? `tool-${i}`
            return <ToolInspector key={key} part={part} />
          }
          return null
        })}
      </div>
    </div>
  )
}

export function ConversationView({ threadId, initialMessage, hydrate = true }: ConversationViewProps) {
  const [input, setInput] = useState('')
  const [hydrating, setHydrating] = useState(hydrate)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  // The launch decision is made once and cached in a ref, so a StrictMode
  // double-invoke (or a Retry re-run) never re-reads sessionStorage after it was
  // cleared and mistakes a launch for a deep link to a thread that does not exist
  // yet. `sentInitial` likewise guards the first turn against a double send.
  const launchDecided = useRef(false)
  const launchText = useRef<string | null>(null)
  const sentInitial = useRef(false)

  // Stable across renders: a new transport every render would rebuild the chat and
  // drop an in-flight stream.
  const transport = useMemo(() => new DefaultChatTransport({ api: '/chat/crm' }), [])

  const { messages, sendMessage, setMessages, status, stop, error, clearError } = useChat({
    transport,
  })

  const busy = status === 'streaming' || status === 'submitted'

  useEffect(() => {
    if (!hydrate) {
      setHydrating(false)
      return
    }
    if (!launchDecided.current) {
      launchDecided.current = true
      launchText.current = initialMessage ?? readAndClearPendingMessage(threadId)
    }
    const first = launchText.current

    // A launch: the thread is brand-new, so there is no row to existence-check and
    // no transcript to hydrate. Send the first turn (which creates the thread
    // server-side) and let the stream run.
    if (first) {
      setHydrating(false)
      if (!sentInitial.current) {
        sentInitial.current = true
        void sendMessage({ text: first }, { headers: { 'x-thread-id': threadId } })
      }
      return
    }

    let cancelled = false
    async function run() {
      setHydrating(true)
      setLoadError(null)
      try {
        await getThread(threadId)
      } catch (err) {
        if (cancelled) return
        // A 404 is "missing or not yours"; both render not-found rather than an
        // error banner, because there is nothing here to retry.
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true)
          return
        }
        setLoadError(describeError(err))
        setHydrating(false)
        return
      }
      try {
        const page = await getThreadMessages(threadId, 1, 50)
        if (cancelled) return
        setMessages(page.messages as unknown as UIMessage[])
        setHydrating(false)
      } catch (err) {
        if (cancelled) return
        setLoadError(describeError(err))
        setHydrating(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [hydrate, threadId, initialMessage, sendMessage, setMessages, reloadNonce])

  const send = () => {
    const text = input.trim()
    if (text.length === 0 || busy) return
    setInput('')
    void sendMessage(
      { text },
      // Per-turn options: the documented `ChatRequestOptions` slot for a
      // request-scoped header. The server reads the thread from a header so it
      // never buffers the streamed body to find out who is speaking.
      { headers: { 'x-thread-id': threadId } },
    )
  }

  const onStop = () => {
    stop()
    // The interrupt is an out-of-band signal addressed by the session id, which is
    // the thread id. It needs no body; a failure to reach it must not throw on the
    // click path (the local `stop()` already halted the stream).
    void post('/api/signals/interrupt', undefined, { 'x-session-id': threadId }).catch(() => {})
  }

  // All hooks have run, so raising not-found here is safe. In production this
  // throws into Next's not-found boundary; the render below is unreachable.
  if (missing) {
    notFound()
    return null
  }

  const showSkeleton = hydrating && messages.length === 0
  const showEmpty = !hydrating && messages.length === 0 && !loadError

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation messages"
        className="min-h-0 flex-1 overflow-y-auto px-1 py-3"
      >
        {showSkeleton && (
          <div className="space-y-3" aria-label="Loading conversation">
            <Skeleton className="ml-auto h-10 w-2/3 rounded-pill" />
            <Skeleton className="h-4 w-full max-w-[68ch]" />
            <Skeleton className="h-4 w-4/5 max-w-[54ch]" />
            <Skeleton className="h-4 w-3/5 max-w-[40ch]" />
          </div>
        )}

        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}

        {busy && (
          <div className="flex items-center gap-2 py-2 text-xs text-text-muted">
            <span
              aria-hidden="true"
              className="inline-block h-4 w-[2px] animate-cursor-blink bg-accent"
            />
            Agent is working…
          </div>
        )}

        {showEmpty && (
          <div className="py-6">
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Sparkles size={15} aria-hidden="true" className="text-accent-bright" />
              Start a conversation — this talks to the live <code className="font-mono">crm-assistant</code> agent.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Suggested prompts">
              {STARTERS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setInput(s.prompt)}
                  className="focus-ring rounded-lg border border-border bg-bg-card p-3 text-left transition-colors hover:bg-bg-hover"
                >
                  <span className="block text-sm font-medium text-text-primary">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="mt-2 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{loadError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setReloadNonce((n) => n + 1)}
            aria-label="Retry loading conversation"
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            <RotateCw size={14} aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{error.message}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearError}
            aria-label="Dismiss error"
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            <X size={14} aria-hidden="true" />
            Dismiss
          </Button>
        </div>
      )}

      <div className="mt-3 flex items-end gap-2 rounded-lg border border-border-strong bg-bg-sunken p-2 focus-within:border-accent">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          placeholder="Type a message..."
          aria-label="Message input"
          className="min-h-9 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
        />
        {busy ? (
          <Button onClick={onStop} aria-label="Stop generation" variant="secondary" size="icon">
            <Square size={14} aria-hidden="true" className="fill-current" />
          </Button>
        ) : (
          <Button onClick={send} aria-label="Send message" size="icon">
            <Send size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}

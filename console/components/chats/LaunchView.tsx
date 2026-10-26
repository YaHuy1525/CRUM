'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUp, Sparkles } from 'lucide-react'

import { storePendingMessage } from '@/lib/pending'
import { STARTERS } from '@/lib/starters'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/**
 * The launch surface for `/chats/new`. §"Route map": "Centered composer with the
 * single reserved prompt gradient and starter prompt cards. Sending mints the
 * thread and redirects into it."
 *
 * The page owns almost nothing: the composer text, and the handoff. It mints the
 * thread id here (the server creates the row when the first turn lands), parks
 * the first message in `sessionStorage` through `lib/pending`, and navigates to
 * `/chats/[id]`. Sending is deliberately *not* done here — the conversation view
 * owns the single `useChat` transport, so a launch is a normal first turn on the
 * real route rather than a second streaming path that could drift from it.
 *
 * The gradient is the one reserved token (`--grad-composer`). It is applied as a
 * background-image on the composer card only, never on a second surface, which is
 * what keeps it reading as an accent instead of a theme.
 */

export function LaunchView() {
  const router = useRouter()
  const [input, setInput] = useState('')
  const [starting, setStarting] = useState(false)

  const start = (text: string) => {
    const message = text.trim()
    if (message.length === 0 || starting) return
    // Guarded against a double submit: the navigation is async, so a second click
    // before the route changes would otherwise mint a second, empty conversation.
    setStarting(true)
    const threadId = crypto.randomUUID()
    storePendingMessage(threadId, message)
    router.push(`/chats/${threadId}`)
  }

  return (
    <div className="mt-6">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          start(input)
        }}
      >
        <div className="rounded-xl border border-border-strong p-3 shadow-sm [background-image:var(--grad-composer)]">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                start(input)
              }
            }}
            rows={3}
            placeholder="Ask about a customer, a deal, or what to work on today…"
            aria-label="Message"
            className="resize-none border-0 bg-transparent text-[15px] shadow-none focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-text-muted">
              Enter to start, Shift+Enter for a new line.
            </p>
            <Button
              type="submit"
              aria-label="Start conversation"
              disabled={input.trim().length === 0 || starting}
            >
              <ArrowUp size={16} aria-hidden="true" />
              Start
            </Button>
          </div>
        </div>
      </form>

      <div className="mt-8">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <Sparkles size={15} aria-hidden="true" className="text-accent-bright" />
          Or start from one of these.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Starter prompts">
          {STARTERS.map((starter) => (
            <button
              key={starter.id}
              type="button"
              onClick={() => setInput(starter.prompt)}
              className="focus-ring rounded-lg border border-border bg-bg-card p-3 text-left transition-colors hover:bg-bg-hover"
            >
              <span className="block text-sm font-medium text-text-primary">
                {starter.label}
              </span>
              <span className="mt-1 block text-sm text-text-muted">{starter.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

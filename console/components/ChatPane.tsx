'use client'

import { useMemo, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'

/**
 * The chat pane: a real streaming conversation with the `crm-assistant` agent.
 * §4.1, §10.2, §13.6.
 *
 * It replaces the Phase 1 mock (a `setTimeout` that echoed the input back), so
 * the pane now proves the thing the phase was actually about — that the agent is
 * reachable from a browser and that its tool calls are visible while they happen.
 *
 * Three decisions worth stating:
 *
 * **One origin.** `api` is the relative `/chat/crm`, which Next rewrites to the
 * Mastra server (:4111). The browser never learns a port, there is no CORS
 * surface, and no `NEXT_PUBLIC_*` value holds a credential (§13.6).
 *
 * **Identity is not here.** The request carries no `x-tenant-id`; the
 * middleware (`console/middleware.ts`) attaches it server-side. If this file were
 * ever edited to put a tenant in the request, that would be a security bug, not a
 * convenience.
 *
 * **The thread id travels per turn**, in the `x-thread-id` header, because
 * `src/mastra/index.ts` reads the thread from a header rather than the body — it
 * must not buffer a streamed request to find out who is speaking. The id is minted
 * by the console (`newThreadId()` in `app/page.tsx`) rather than adopted from the
 * server, because the v7 UI stream does not send the minted id back to the client;
 * a console-supplied uuid is honoured as-is, which is what makes a brand-new
 * conversation immediately listable and continuable.
 */

/**
 * Whether a message part is a tool call. A static tool part is typed
 * `tool-${NAME}` and a dynamic one is `dynamic-tool` with a `toolName` field, so
 * both are covered by these two tests rather than by a name list that would go stale
 * the next time a tool is added to the agent. A type predicate, so the render below
 * gets the real `state` / `input` / `errorText` fields instead of a cast.
 */
function isToolPart(part: UIMessage['parts'][number]): part is ToolUIPart | DynamicToolUIPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** The tool's display name, from whichever of the two shapes the part has. */
function toolNameOf(part: UIMessage['parts'][number]): string {
  if (part.type === 'dynamic-tool') return part.toolName
  return part.type.slice('tool-'.length)
}

/**
 * A short human verdict on the state, in the vocabulary of the framework's own
 * `state` union (`input-streaming`, `input-available`, `result`, `output-error`,
 * and the two approval states). Unknown states render as themselves instead of
 * being mapped onto a guess.
 */
function stateLabel(state: string): string {
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
      return 'done'
    case 'output-error':
      return 'error'
    default:
      return state
  }
}

interface ChatPaneProps {
  /**
   * The conversation this turn belongs to. The parent remounts this component
   * (with a React `key`) when the user picks another session, which is why it is
   * safe for the transcript to live in `useChat`'s own state: there is no
   * second, stale copy to keep in sync.
   */
  threadId: string
}

/**
 * Suggestions for the empty canvas, in Cedar's card-grid grammar. They are not
 * navigation: clicking one fills the composer with a real prompt the agent can
 * answer, so the card is a starting move, not a shortcut to another page.
 */
const SUGGESTIONS = [
  {
    title: 'What should I do today?',
    desc: 'Ask the assistant to rank today\u2019s follow-ups from the live pipeline.',
    prompt: 'What should I work on today? Check overdue follow-ups and deals at risk.',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
  {
    title: 'Summarize a customer',
    desc: 'Deals, tasks and notes for one account, from the rows you can see.',
    prompt: 'Summarize my open deals and the last activity for my most active customer.',
    icon: (
      <>
        <path d="M3 20V10l9-6 9 6v10" />
        <path d="M9 20v-6h6v6" />
      </>
    ),
  },
  {
    title: 'Draft a next step',
    desc: 'A follow-up staged as a draft \u2014 it waits for your approval, always.',
    prompt: 'Draft a follow-up task for the deal that went quiet longest.',
    icon: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </>
    ),
  },
]

export function ChatPane({ threadId }: ChatPaneProps) {
  const [input, setInput] = useState('')

  // Stable across renders: a new transport on every render would rebuild the chat
  // and drop the in-flight stream.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: '/chat/crm' }),
    [],
  )

  const { messages, sendMessage, status, stop, error, clearError } = useChat({ transport })

  const busy = status === 'streaming' || status === 'submitted'

  const send = () => {
    const text = input.trim()
    if (text.length === 0 || busy) return
    setInput('')
    void sendMessage(
      { text },
      // Per-turn options, which is the documented `ChatRequestOptions` slot for
      // exactly this kind of request-scoped header.
      { headers: { 'x-thread-id': threadId } },
    )
  }

  return (
    <>
      <div className="messages" role="log" aria-live="polite" aria-label="Conversation messages">
        {messages.length === 0 && (
          <>
            <div className="empty-state">
              Start a conversation — this talks to the live `crm-assistant` agent.
            </div>
            <div className="suggest-grid" aria-label="Suggested prompts">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  className="suggest-card focus-ring"
                  onClick={() => setInput(s.prompt)}
                >
                  <span className="suggest-icon" aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      {s.icon}
                    </svg>
                  </span>
                  <span className="suggest-title">{s.title}</span>
                  <span className="suggest-desc">{s.desc}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.parts.map((part, index) => {
              if (part.type === 'text') {
                // The `token` span is what the styles and the tests address; a
                // text part with no text yet (pre-first-chunk) renders nothing.
                return part.text.length > 0 ? (
                  <span key={index} className="token">
                    {part.text}
                  </span>
                ) : null
              }

              if (part.type === 'reasoning') {
                return part.text.length > 0 ? (
                  <span key={index} className="token reasoning">
                    {part.text}
                  </span>
                ) : null
              }

              if (!isToolPart(part)) return null

              const title = part.errorText ?? JSON.stringify(part.input ?? {})
              return (
                <span
                  key={part.toolCallId ?? index}
                  className={`tool-chip state-${part.state}`}
                  data-tool={toolNameOf(part)}
                  title={title}
                >
                  <span className="tool-name">{toolNameOf(part)}</span>
                  <span className="tool-state">{stateLabel(part.state)}</span>
                </span>
              )
            })}
          </div>
        ))}

        {busy && <div className="status-line">Agent is working…</div>}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error.message}</span>
          <button onClick={clearError} aria-label="Dismiss error" className="focus-ring">
            Dismiss
          </button>
        </div>
      )}

      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Type a message..."
          aria-label="Message input"
          className="focus-ring"
        />
        {busy ? (
          <button onClick={stop} aria-label="Stop generation" className="stop focus-ring">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button onClick={send} aria-label="Send message" className="focus-ring">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </>
  )
}

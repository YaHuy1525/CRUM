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
          <div className="empty-state">
            Start a conversation — this talks to the live `crm-assistant` agent.
          </div>
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
          <button onClick={stop} aria-label="Stop generation" className="focus-ring">
            Stop
          </button>
        ) : (
          <button onClick={send} aria-label="Send message" className="focus-ring">
            Send
          </button>
        )}
      </div>
    </>
  )
}

// console/lib/pending.ts
/**
 * The launch → conversation handoff. §"Chats section / Frontend".
 *
 * `/chats/new` mints a thread id and navigates to `/chats/[id]`, but the first
 * user message must be *sent* by the conversation view (which owns the live
 * `useChat` transport), not by the launch view. The message cannot travel in the
 * URL — it is arbitrary user text, and a query string is both length-limited and
 * logged — so it is parked in `sessionStorage` under a per-thread key, read back
 * once on mount, and cleared.
 *
 * `sessionStorage` (not `local`) is deliberate: the handoff is meaningful only
 * within the tab that minted the id, and it must not survive to leak a draft
 * first message into an unrelated later session. Every access is wrapped because
 * `sessionStorage` throws in some privacy modes and is absent during SSR.
 */

/** The storage key for a thread's pending first message. */
export function pendingKey(threadId: string): string {
  return `crum:pending:${threadId}`
}

/** Park a first message for a thread the launch view is about to open. */
export function storePendingMessage(threadId: string, text: string): void {
  try {
    sessionStorage.setItem(pendingKey(threadId), text)
  } catch {
    // Storage unavailable: the conversation still opens, just without the
    // pre-filled first turn. Better than throwing on the send path.
  }
}

/** Read and clear a thread's pending first message, or null when there is none. */
export function readAndClearPendingMessage(threadId: string): string | null {
  try {
    const key = pendingKey(threadId)
    const value = sessionStorage.getItem(key)
    if (value !== null) sessionStorage.removeItem(key)
    return value
  } catch {
    return null
  }
}

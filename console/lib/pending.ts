
export function pendingKey(threadId: string): string {
  return `crum:pending:${threadId}`
}

export function storePendingMessage(threadId: string, text: string): void {
  try {
    sessionStorage.setItem(pendingKey(threadId), text)
  } catch {
  }
}

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

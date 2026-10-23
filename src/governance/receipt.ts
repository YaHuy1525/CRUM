import { createHmac, createHash } from 'node:crypto'
import { parseEnv } from '../config/env'

function getHmacSecret(): string {
  const env = parseEnv()
  if (!env.APPROVAL_HMAC_SECRET) {
    throw new Error('APPROVAL_HMAC_SECRET is not set')
  }
  return env.APPROVAL_HMAC_SECRET
}

export interface ReceiptInput {
  pendingWriteId: string
  runId: string
  scope: string
  actionHash: string
  approvedBy: string
}

/**
 * HMAC-SHA256 over the receipt input. §12.3.
 * The secret is read from the validated environment on every call so that
 * tests can set it per-describe without a module-level cache.
 */
export function signReceipt(input: ReceiptInput): string {
  return createHmac('sha256', getHmacSecret())
    .update(JSON.stringify(input))
    .digest('hex')
}

export function verifyReceipt(input: ReceiptInput, signature: string): boolean {
  const expected = signReceipt(input)
  if (expected.length !== signature.length) return false
  // Constant-time comparison to prevent timing attacks on the signature.
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/**
 * SHA-256 hash of the draft payload, used as the actionHash in receipt signing
 * and as the draftHash idempotency key for approval-class tools.
 */
export function computeActionHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
}

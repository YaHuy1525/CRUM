import { createHmac, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_VERSION = 'v1'
const HKDF_SALT = 'crum-gmail-v1'

export class GmailCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailCryptoError'
  }
}

function deriveKey(secret: string, domain: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(domain, 'utf8'), 32))
}

export function encryptRefreshToken(plaintext: string, secret: string): string {
  const key = deriveKey(secret, 'crum-gmail-refresh-token')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [TOKEN_VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
}

export function decryptRefreshToken(encoded: string, secret: string): string {
  const parts = encoded.split('.')
  const version = parts[0]
  const ivB64 = parts[1]
  const tagB64 = parts[2]
  const ctB64 = parts[3]
  if (parts.length !== 4 || version !== TOKEN_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new GmailCryptoError('unrecognised refresh-token envelope')
  }
  const key = deriveKey(secret, 'crum-gmail-refresh-token')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new GmailCryptoError(`refresh-token decryption failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function signState(payload: { tenantId: string; userId: string; exp: number; nonce: string }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', deriveKey(secret, 'crum-gmail-oauth-state')).update(body).digest('base64url')
  return `${body}.${mac}`
}

export interface OAuthState {
  tenantId: string
  userId: string
  exp: number
  nonce: string
}

export function verifyState(state: string, secret: string, now: number = Date.now()): OAuthState | null {
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null
  const body = state.slice(0, dot)
  const mac = state.slice(dot + 1)
  const expected = createHmac('sha256', deriveKey(secret, 'crum-gmail-oauth-state')).update(body).digest('base64url')
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload: Partial<OAuthState>
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthState>
  } catch {
    return null
  }
  if (
    typeof payload.tenantId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string'
  ) {
    return null
  }
  if (payload.exp <= now) return null
  return { tenantId: payload.tenantId, userId: payload.userId, exp: payload.exp, nonce: payload.nonce }
}

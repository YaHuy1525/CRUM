// tests/gmail/crypto.test.ts
// Unit coverage for the two primitives the Gmail connector trusts its
// security properties to: AES-256-GCM token envelopes and HMAC state.
import { describe, it, expect } from 'vitest'
import {
  encryptRefreshToken,
  decryptRefreshToken,
  GmailCryptoError,
  signState,
  verifyState,
} from '../../src/gmail/crypto'

const SECRET = 'a'.repeat(40)
const OTHER_SECRET = 'b'.repeat(40)

describe('refresh-token envelope', () => {
  it('round-trips a token', () => {
    const enc = encryptRefreshToken('1//4/hangul...real-refresh-token', SECRET)
    expect(decryptRefreshToken(enc, SECRET)).toBe('1//4/hangul...real-refresh-token')
  })

  it('uses a fresh IV per call, so the same token encrypts differently', () => {
    expect(encryptRefreshToken('same', SECRET)).not.toBe(encryptRefreshToken('same', SECRET))
  })

  it('rejects a tampered ciphertext', () => {
    const enc = encryptRefreshToken('token', SECRET)
    const parts = enc.split('.')
    const ct = parts[3] as string
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)
    expect(() => decryptRefreshToken(parts.join('.'), SECRET)).toThrow(GmailCryptoError)
  })

  it('rejects decryption under the wrong key', () => {
    const enc = encryptRefreshToken('token', SECRET)
    expect(() => decryptRefreshToken(enc, OTHER_SECRET)).toThrow(GmailCryptoError)
  })

  it('rejects a foreign envelope version', () => {
    expect(() => decryptRefreshToken('v9.aaa.bbb.ccc', SECRET)).toThrow(GmailCryptoError)
  })
})

describe('oauth state', () => {
  const payload = { tenantId: 't-1', userId: 'u-1', exp: Date.now() + 60_000, nonce: 'deadbeef' }

  it('round-trips a valid state', () => {
    const state = signState(payload, SECRET)
    expect(verifyState(state, SECRET)).toEqual(payload)
  })

  it('rejects a modified payload', () => {
    const state = signState(payload, SECRET)
    const forged = Buffer.from(
      JSON.stringify({ ...payload, tenantId: 'victim-tenant' }),
      'utf8',
    ).toString('base64url')
    const mac = state.split('.')[1]
    expect(verifyState(`${forged}.${mac}`, SECRET)).toBeNull()
  })

  it('rejects an expired state', () => {
    const past = signState({ ...payload, exp: Date.now() - 1 }, SECRET)
    expect(verifyState(past, SECRET)).toBeNull()
  })

  it('rejects a state signed with a different secret', () => {
    const state = signState(payload, SECRET)
    expect(verifyState(state, OTHER_SECRET)).toBeNull()
  })

  it('rejects malformed input without throwing', () => {
    expect(verifyState('', SECRET)).toBeNull()
    expect(verifyState('no-dot-here', SECRET)).toBeNull()
    expect(verifyState('bW9jaw==.bWFj', SECRET)).toBeNull()
  })
})

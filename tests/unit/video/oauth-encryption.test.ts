// tests/unit/video/oauth-encryption.test.ts
// Unit coverage for the AES-256-GCM primitives that protect video-platform
// OAuth tokens at rest.
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptToken,
  decryptToken,
  generateEncryptionKey,
  packEncrypted,
  unpackEncrypted,
  OAuthEncryptionError,
} from '../../../src/video/oauth-encryption'

const KEY = generateEncryptionKey()
const OTHER_KEY = generateEncryptionKey()

describe('generateEncryptionKey', () => {
  it('returns a 32-byte Buffer', () => {
    const key = generateEncryptionKey()
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('produces unique keys on every call', () => {
    expect(generateEncryptionKey().toString('hex')).not.toBe(generateEncryptionKey().toString('hex'))
  })
})

describe('encryptToken / decryptToken round-trip', () => {
  it('round-trips a refresh token', () => {
    const plaintext = '1//4/youtube-refresh-token-value'
    const { encrypted, iv, tag } = encryptToken(plaintext, KEY)
    expect(decryptToken(encrypted, KEY, iv, tag)).toBe(plaintext)
  })

  it('uses a fresh IV per call, so the same token encrypts differently', () => {
    const a = encryptToken('same', KEY)
    const b = encryptToken('same', KEY)
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.encrypted.equals(b.encrypted)).toBe(false)
  })

  it('handles empty strings', () => {
    const { encrypted, iv, tag } = encryptToken('', KEY)
    expect(decryptToken(encrypted, KEY, iv, tag)).toBe('')
  })

  it('handles unicode payloads', () => {
    const plaintext = 'tok\u00e9n-\ud83d\udd11-\u00ea'
    const { encrypted, iv, tag } = encryptToken(plaintext, KEY)
    expect(decryptToken(encrypted, KEY, iv, tag)).toBe(plaintext)
  })
})

describe('encryptToken – invalid key', () => {
  it('rejects a key that is too short', () => {
    expect(() => encryptToken('data', randomBytes(16))).toThrow(OAuthEncryptionError)
    expect(() => encryptToken('data', randomBytes(16))).toThrow(/32-byte/)
  })

  it('rejects a key that is too long', () => {
    expect(() => encryptToken('data', randomBytes(64))).toThrow(OAuthEncryptionError)
  })

  it('rejects a non-Buffer key', () => {
    // @ts-expect-error – deliberate misuse
    expect(() => encryptToken('data', 'not-a-buffer')).toThrow(OAuthEncryptionError)
  })
})

describe('decryptToken – invalid components', () => {
  it('rejects a wrong key', () => {
    const { encrypted, iv, tag } = encryptToken('secret', KEY)
    expect(() => decryptToken(encrypted, OTHER_KEY, iv, tag)).toThrow(OAuthEncryptionError)
  })

  it('rejects tampered ciphertext', () => {
    const { encrypted, iv, tag } = encryptToken('token', KEY)
    encrypted[0] = (encrypted[0] as number) ^ 0xff
    expect(() => decryptToken(encrypted, KEY, iv, tag)).toThrow(OAuthEncryptionError)
  })

  it('rejects a tampered auth tag', () => {
    const { encrypted, iv, tag } = encryptToken('token', KEY)
    tag[0] = (tag[0] as number) ^ 0xff
    expect(() => decryptToken(encrypted, KEY, iv, tag)).toThrow(OAuthEncryptionError)
  })

  it('rejects an IV with the wrong length', () => {
    const { encrypted, tag } = encryptToken('token', KEY)
    expect(() => decryptToken(encrypted, KEY, randomBytes(8), tag)).toThrow(OAuthEncryptionError)
  })

  it('rejects a tag with the wrong length', () => {
    const { encrypted, iv } = encryptToken('token', KEY)
    expect(() => decryptToken(encrypted, KEY, iv, randomBytes(8))).toThrow(OAuthEncryptionError)
  })
})

describe('packEncrypted / unpackEncrypted', () => {
  it('round-trips the three components into a single Buffer', () => {
    const { encrypted, iv, tag } = encryptToken('pack-me', KEY)
    const packed = packEncrypted(encrypted, iv, tag)
    const out = unpackEncrypted(packed)
    expect(out.iv.equals(iv)).toBe(true)
    expect(out.encrypted.equals(encrypted)).toBe(true)
    expect(out.tag.equals(tag)).toBe(true)
  })

  it('packed buffer decrypts correctly end-to-end', () => {
    const plaintext = 'end-to-end-token'
    const { encrypted, iv, tag } = encryptToken(plaintext, KEY)
    const packed = packEncrypted(encrypted, iv, tag)
    const { encrypted: ct, iv: unpackedIv, tag: unpackedTag } = unpackEncrypted(packed)
    expect(decryptToken(ct, KEY, unpackedIv, unpackedTag)).toBe(plaintext)
  })

  it('rejects a buffer that is too short', () => {
    expect(() => unpackEncrypted(Buffer.alloc(20))).toThrow(OAuthEncryptionError)
  })
})

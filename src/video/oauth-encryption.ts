import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

export class OAuthEncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthEncryptionError'
  }
}

/**
 * Generate a random 32-byte key suitable for AES-256-GCM.
 * Store the result as hex (`key.toString('hex')`) in OAUTH_ENCRYPTION_KEY.
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/**
 * Encrypt `plaintext` with AES-256-GCM.
 *
 * Returns the raw components so the caller can persist them.  The conventional
 * on-disk layout is a single bytea column that concatenates
 * `iv || ciphertext || tag` -- see {@link packEncrypted} / {@link unpackEncrypted}.
 */
export function encryptToken(
  plaintext: string,
  key: Buffer,
): { encrypted: Buffer; iv: Buffer; tag: Buffer } {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new OAuthEncryptionError(
      `encryption key must be a ${KEY_LENGTH}-byte Buffer (got ${key?.length ?? 'non-Buffer'})`,
    )
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { encrypted: ct, iv, tag }
}

/**
 * Decrypt a ciphertext produced by {@link encryptToken}.
 */
export function decryptToken(
  encrypted: Buffer,
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new OAuthEncryptionError(
      `decryption key must be a ${KEY_LENGTH}-byte Buffer (got ${key?.length ?? 'non-Buffer'})`,
    )
  }
  if (!Buffer.isBuffer(iv) || iv.length !== IV_LENGTH) {
    throw new OAuthEncryptionError(`IV must be a ${IV_LENGTH}-byte Buffer`)
  }
  if (!Buffer.isBuffer(tag) || tag.length !== TAG_LENGTH) {
    throw new OAuthEncryptionError(`auth tag must be a ${TAG_LENGTH}-byte Buffer`)
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new OAuthEncryptionError(
      `token decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers for the single-column storage layout
// ---------------------------------------------------------------------------

/**
 * Pack the three components into a single Buffer: `iv || ciphertext || tag`.
 * This is the format stored in the video_revenue_channels token bytea column.
 */
export function packEncrypted(
  encrypted: Buffer,
  iv: Buffer,
  tag: Buffer,
): Buffer {
  return Buffer.concat([iv, encrypted, tag])
}

/**
 * Inverse of {@link packEncrypted}.
 */
export function unpackEncrypted(packed: Buffer): {
  encrypted: Buffer
  iv: Buffer
  tag: Buffer
} {
  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new OAuthEncryptionError('packed ciphertext is too short to contain iv + tag + data')
  }
  const iv = packed.subarray(0, IV_LENGTH)
  const tag = packed.subarray(packed.length - TAG_LENGTH)
  const encrypted = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH)
  return { encrypted, iv, tag }
}

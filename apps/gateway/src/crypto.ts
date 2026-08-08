/**
 * AES-256-GCM encryption for secrets at rest (API keys, etc.).
 * Replaces the old Base64 "encoding" which was trivially reversible.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // GCM standard IV length
const TAG_LEN = 16

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY ?? ''
  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  }
  return Buffer.from(keyHex, 'hex')
}

/** Encrypt a plaintext string. Returns `enc:v1:<iv>:<tag>:<ciphertext>` all in hex. */
export function encrypt(plain: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/** Decrypt an `enc:v1:...` string. Returns the plaintext. Throws on tampering/auth failure. */
export function decrypt(encoded: string): string {
  const parts = encoded.split(':')
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('not an encrypted string')
  }
  const key = getKey()
  const iv = Buffer.from(parts[2], 'hex')
  const tag = Buffer.from(parts[3], 'hex')
  const enc = Buffer.from(parts[4], 'hex')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

/**
 * Decrypt a stored secret, supporting both the new AES-256-GCM format
 * (`enc:v1:...`) and the legacy Base64 format (transparent migration).
 * Returns the plaintext string.
 */
export function decryptSecret(stored: string): string {
  // New encrypted format
  if (stored.startsWith('enc:v1:')) {
    return decrypt(stored)
  }
  // Legacy Base64 — transparent migration (old data still readable)
  return Buffer.from(stored, 'base64').toString('utf-8')
}

/** Check if encryption is configured (ENCRYPTION_KEY is set and valid). */
export function encryptionConfigured(): boolean {
  const key = process.env.ENCRYPTION_KEY ?? ''
  return key.length === 64 && /^[0-9a-f]+$/i.test(key)
}

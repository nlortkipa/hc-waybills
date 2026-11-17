/**
 * Encryption at rest for secrets stored in the database (the RS.ge service password).
 *
 * AES-256-GCM with the key in HC_SECRET_KEY (32 bytes, base64). A copy or backup of hc.db is
 * useless without the key, so keep the key out of those backups. On first start without a key
 * one is generated and appended to .env.
 *
 * Stored form: "enc:v1:<iv>:<tag>:<ciphertext>" (base64url). Anything without that prefix is
 * plain text from before encryption and is re-encrypted on startup.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { ENV_PATH } from './env.ts'

const PREFIX = 'enc:v1:'

function loadKey(): Buffer {
  const raw = process.env.HC_SECRET_KEY?.trim()
  if (raw) {
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) throw new Error('[secret] HC_SECRET_KEY must be 32 bytes, base64 (generate one with: openssl rand -base64 32)')
    return key
  }
  const key = randomBytes(32)
  const before = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const sep = before && !before.endsWith('\n') ? '\n' : ''
  appendFileSync(ENV_PATH, `${sep}# Encrypts the RS.ge password in the database. Keep it: without it the password must be entered again.\nHC_SECRET_KEY=${key.toString('base64')}\n`)
  try {
    chmodSync(ENV_PATH, 0o600)
  } catch {
    /* not fatal */
  }
  console.log(`[secret] generated HC_SECRET_KEY in ${ENV_PATH}`)
  return key
}

const KEY = loadKey()

export const isEncrypted = (s: string) => s.startsWith(PREFIX)

export function encrypt(plain: string): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', KEY, iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join(':')
}

/** Plain text of a stored value. Throws if it was encrypted with a different key or was altered. */
export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', KEY, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

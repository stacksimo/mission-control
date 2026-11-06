import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// AES-256-GCM encryption at rest for platform credentials (e.g. ClickBank keys).
// Key is derived from AUTH_SECRET, which is auto-generated and persisted on first run.
const KEY_SALT = 'mc-platform-integrations-v1'

function getKey(): Buffer {
  const secret = (process.env.AUTH_SECRET || '').trim()
  if (!secret) throw new Error('AUTH_SECRET is not configured')
  return scryptSync(secret, KEY_SALT, 32)
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':')
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted payload')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}

export function maskSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null
  if (plaintext.length <= 4) return '****'
  return `${plaintext.slice(0, 2)}****${plaintext.slice(-2)}`
}

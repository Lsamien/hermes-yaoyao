import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { HttpError } from './errors.js'

const PAIRING_TTL_MS = 2 * 60 * 1_000
const MAX_PENDING_PAIRINGS = 32

interface PendingAccountPairing {
  id: string
  userID: string
  secretHash: Buffer
  expiresAt: number
  claimed: boolean
}

export interface AccountPairingSession {
  id: string
  secret: string
  expiresAt: number
}

function canonicalPairingID(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, '登录配对码无效', 'invalid_account_pairing')
  }
  return normalized
}

function digest(id: string, secret: string): Buffer {
  return createHash('sha256').update(`${id}:${secret}`, 'utf8').digest()
}

export class AccountLoginPairingStore {
  readonly #pending = new Map<string, PendingAccountPairing>()
  readonly #clock: () => number

  constructor(clock: () => number = Date.now) {
    this.#clock = clock
  }

  create(userID: string): AccountPairingSession {
    this.#prune()
    while (this.#pending.size >= MAX_PENDING_PAIRINGS) {
      const oldest = this.#pending.keys().next().value as string | undefined
      if (!oldest) break
      this.#pending.delete(oldest)
    }
    const id = randomUUID().toLowerCase()
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.#clock() + PAIRING_TTL_MS
    this.#pending.set(id, {
      id, userID, secretHash: digest(id, secret), expiresAt, claimed: false,
    })
    return { id, secret, expiresAt }
  }

  status(pairingID: string): { state: 'pending' | 'claimed' | 'expired' } {
    const id = canonicalPairingID(pairingID)
    const pairing = this.#pending.get(id)
    if (!pairing || pairing.expiresAt <= this.#clock()) {
      this.#pending.delete(id)
      return { state: 'expired' }
    }
    return { state: pairing.claimed ? 'claimed' : 'pending' }
  }

  claim(pairingID: string, secret: string): string {
    this.#prune()
    const id = canonicalPairingID(pairingID)
    const pairing = this.#pending.get(id)
    if (!pairing || pairing.expiresAt <= this.#clock()) {
      this.#pending.delete(id)
      throw new HttpError(410, '登录配对码已过期', 'account_pairing_expired')
    }
    if (pairing.claimed) {
      throw new HttpError(409, '登录配对码已使用', 'account_pairing_already_used')
    }
    const supplied = digest(id, secret)
    if (supplied.byteLength !== pairing.secretHash.byteLength
      || !timingSafeEqual(supplied, pairing.secretHash)) {
      throw new HttpError(401, '登录配对密钥无效', 'invalid_account_pairing_secret')
    }
    pairing.claimed = true
    return pairing.userID
  }

  #prune(): void {
    const now = this.#clock()
    for (const [id, pairing] of this.#pending) {
      if (pairing.expiresAt <= now) this.#pending.delete(id)
    }
  }
}

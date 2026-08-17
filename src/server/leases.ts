import { randomBytes } from 'node:crypto'
import { HttpError } from './errors.js'

export type RealtimeChannel = 'chat' | 'groups'
export type UpstreamCredential = { name: 'ticket' | 'token'; value: string }

export interface RealtimeLease {
  id: string
  channel: RealtimeChannel
  credential: UpstreamCredential
  origin: string
  accountKeys: ReadonlySet<string>
  epoch?: string
  cursor?: number
  expiresAt: number
}

export interface IssueLeaseInput {
  channel: RealtimeChannel
  credential: UpstreamCredential
  origin: string
  accountKeys: Iterable<string>
  epoch?: string
  cursor?: number
}

export class RealtimeLeaseStore {
  readonly #leases = new Map<string, RealtimeLease>()

  constructor(
    readonly ttlMs = 20_000,
    readonly now: () => number = Date.now,
  ) {}

  issue(input: IssueLeaseInput): RealtimeLease {
    this.prune()
    const accountKeys = new Set([...input.accountKeys].filter(Boolean))
    if (accountKeys.size === 0) throw new HttpError(401, 'Missing account scope', 'missing_account')
    const activeForAccount = [...this.#leases.values()].filter((lease) =>
      [...accountKeys].some((key) => lease.accountKeys.has(key)),
    ).length
    if (activeForAccount >= 16) {
      throw new HttpError(429, 'Too many pending realtime leases', 'lease_limit')
    }
    const id = randomBytes(32).toString('base64url')
    const lease: RealtimeLease = {
      id,
      channel: input.channel,
      credential: input.credential,
      origin: input.origin,
      accountKeys,
      epoch: input.epoch,
      cursor: input.cursor,
      expiresAt: this.now() + this.ttlMs,
    }
    this.#leases.set(id, lease)
    return lease
  }

  consume(
    id: string,
    channel: RealtimeChannel,
    origin: string,
    accountKey: string,
  ): RealtimeLease {
    this.prune()
    const lease = this.#leases.get(id)
    if (!lease || lease.channel !== channel || lease.origin !== origin || !lease.accountKeys.has(accountKey)) {
      throw new HttpError(401, 'Realtime lease is invalid or expired', 'invalid_lease')
    }
    this.#leases.delete(id)
    return lease
  }

  prune(): void {
    const now = this.now()
    for (const [id, lease] of this.#leases) {
      if (lease.expiresAt <= now) this.#leases.delete(id)
    }
  }

  get size(): number {
    this.prune()
    return this.#leases.size
  }
}

export function canonicalEpoch(value: unknown): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new HttpError(400, 'epoch must be a canonical lowercase UUID', 'invalid_epoch')
  }
  return value
}

export function groupCursor(value: unknown): number {
  const cursor = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, 'cursor must be a non-negative integer', 'invalid_cursor')
  }
  return cursor
}

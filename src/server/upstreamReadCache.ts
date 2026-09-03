import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpError } from './errors.js'
import type { UpstreamResponse } from './upstream.js'

export interface ReadCacheContext { scope: string; fresh?: boolean }
export const readCacheContext = new AsyncLocalStorage<ReadCacheContext>()
export interface ReadPolicy { tags: string[]; freshMs: number; staleMs: number }
interface Entry { value: UpstreamResponse; policy: ReadPolicy; savedAt: number; bytes: number }
interface Flight { promise: Promise<UpstreamResponse>; tags: string[]; invalidated: boolean }

/** Application-data cache. Only authenticated HTTP request scopes opt in; background
 * recovery, authentication and command acknowledgement reads remain authoritative. */
export class UpstreamReadCache {
  private entries = new Map<string, Entry>()
  private flights = new Map<string, Flight>()
  private bytes = 0
  private loading = 0
  private closed = false
  private counters = { hits: 0, misses: 0, staleHits: 0, coalesced: 0, evictions: 0 }
  constructor(readonly now = Date.now, readonly maxBytes = 64 * 1024 * 1024,
    readonly maxEntries = 512, readonly maxEntryBytes = 2 * 1024 * 1024) {}

  stats() { return { ...this.counters, entries: this.entries.size, bytes: this.bytes, inFlight: this.loading } }

  async read(key: string, policy: ReadPolicy, load: () => Promise<UpstreamResponse>): Promise<UpstreamResponse> {
    const entry = this.entries.get(key)
    if (entry) {
      const age = this.now() - entry.savedAt
      if (age < policy.freshMs) {
        this.counters.hits++; this.touch(key, entry)
        return copy(entry.value)
      }
      if (age < policy.freshMs + policy.staleMs) {
        this.counters.staleHits++; this.touch(key, entry)
        if (!this.flights.has(key) && this.loading < 128) void this.refresh(key, policy, load).catch(() => {})
        return copy(entry.value)
      }
      this.remove(key)
    }
    const flight = this.flights.get(key)
    if (flight) { this.counters.coalesced++; return copy(await flight.promise) }
    this.counters.misses++
    return copy(await this.refresh(key, policy, load))
  }

  invalidate(tags?: readonly string[]): void {
    const matches = (entryTags: string[]) => !tags || entryTags.some(tag => tags.includes(tag))
    for (const [key, entry] of this.entries) if (matches(entry.policy.tags)) this.remove(key)
    for (const [key, flight] of this.flights) if (matches(flight.tags)) {
      flight.invalidated = true
      this.flights.delete(key) // A newer request must not join an obsolete snapshot.
    }
  }

  close(): void { this.closed = true; this.invalidate() }

  private refresh(key: string, policy: ReadPolicy, load: () => Promise<UpstreamResponse>): Promise<UpstreamResponse> {
    if (this.loading >= 128) return Promise.reject(new HttpError(429, 'Too many pending reads', 'read_capacity'))
    this.loading++
    const flight: Flight = { tags: policy.tags, invalidated: false, promise: Promise.resolve(undefined as never) }
    // Defer load until the flight is registered, so synchronous invalidations cannot be lost.
    flight.promise = Promise.resolve().then(load).then(value => {
      if (!flight.invalidated && !this.closed && cacheable(value) && value.body.byteLength <= this.maxEntryBytes) {
        this.remove(key)
        const bytes = value.body.byteLength + key.length * 2 + 512
        this.entries.set(key, { value: copy(value), policy, savedAt: this.now(), bytes })
        this.bytes += bytes
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
          this.remove(this.entries.keys().next().value!); this.counters.evictions++
        }
      }
      return value
    }).finally(() => {
      this.loading--
      if (this.flights.get(key) === flight) this.flights.delete(key)
    })
    this.flights.set(key, flight)
    return flight.promise
  }

  private touch(key: string, entry: Entry): void { this.entries.delete(key); this.entries.set(key, entry) }
  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }
}

function copy(value: UpstreamResponse): UpstreamResponse {
  return { status: value.status, headers: new Headers(value.headers), body: Buffer.from(value.body) }
}
function cacheable(value: UpstreamResponse): boolean {
  return value.status === 200
    && (value.headers.get('content-type') ?? '').includes('application/json')
    && !/\bno-store\b/i.test(value.headers.get('cache-control') ?? '')
    && value.headers.get('vary') !== '*'
    && !value.headers.has('set-cookie')
}

export function readPolicy(path: string, search?: URLSearchParams): ReadPolicy | undefined {
  if (path === '/api/profiles') {
    return { tags: ['profiles'], freshMs: 5_000, staleMs: 15_000 }
  }
  if (path === '/api/model/options') return { tags: ['models'], freshMs: 30_000, staleMs: 60_000 }
  if (path === '/api/sessions' || path === '/api/profiles/sessions') {
    return { tags: ['sessions', 'session-list'], freshMs: 2_000, staleMs: 0 }
  }
  const session = /^\/api\/sessions\/([^/]+)(?:\/messages)?$/.exec(path)
  if (session && !['search', 'unread', 'prune', 'export'].includes(session[1]!)) {
    const oldPage = Number(search?.get('offset') ?? 0) > 0
    return { tags: ['sessions', `session:${decodeURIComponent(session[1]!)}`], freshMs: oldPage ? 10_000 : 1_000, staleMs: 0 }
  }

}

export function mutationTags(path: string): string[] | undefined {
  if (path.startsWith('/auth/') || path.startsWith('/api/auth/')) return undefined
  const session = /^\/api\/sessions\/([^/]+)/.exec(path)
  if (session) return ['session-list', `session:${decodeURIComponent(session[1]!)}`]
  if (path.startsWith('/api/sessions')) return ['sessions']
  if (/^\/api\/(profiles|model|config|env|providers|dashboard\/agent-plugins)/.test(path)) return ['profiles', 'models', 'sessions', 'groups']
  return undefined
}

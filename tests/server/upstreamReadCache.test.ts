// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { CookieJar, UpstreamClient, type UpstreamResponse } from '../../src/server/upstream.js'
import { readPolicy, UpstreamReadCache } from '../../src/server/upstreamReadCache.js'

function value(n: number, status = 200): UpstreamResponse {
  return { status, headers: new Headers({ 'content-type': 'application/json' }), body: Buffer.from(JSON.stringify({ n })) }
}
function gate<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const policy = { tags: ['sessions', 'session:one'], freshMs: 1000, staleMs: 0 }

describe('bounded upstream read cache', () => {
  it('coalesces cold reads, copies responses and expires fresh entries', async () => {
    let now = 0
    const cache = new UpstreamReadCache(() => now), load = vi.fn(async () => value(1))
    const [a, b] = await Promise.all([cache.read('one', policy, load), cache.read('one', policy, load)])
    expect(load).toHaveBeenCalledTimes(1)
    a.body.fill(0); a.headers.set('private', 'changed')
    expect(b.body.toString()).toBe('{"n":1}')
    expect((await cache.read('one', policy, load)).headers.has('private')).toBe(false)
    now = 1001
    await cache.read('one', policy, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.stats()).toMatchObject({ hits: 1, coalesced: 1 })
  })
  it('refreshes stale metadata once in the background, without extending failed freshness', async () => {
    let now = 0
    const cache = new UpstreamReadCache(() => now), p = { ...policy, staleMs: 1000 }
    await cache.read('one', p, async () => value(1))
    now = 1001
    const pending = gate<UpstreamResponse>(), load = vi.fn(() => pending.promise)
    expect((await cache.read('one', p, load)).body.toString()).toContain('1')
    await cache.read('one', p, load)
    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve(value(2))
    await vi.waitFor(() => expect(cache.stats().inFlight).toBe(0))
    expect((await cache.read('one', p, load)).body.toString()).toContain('2')
    now = 4000
    await expect(cache.read('one', p, async () => { throw new Error('offline') })).rejects.toThrow('offline')
  })
  it('does not refill from a read that overlapped invalidation', async () => {
    const cache = new UpstreamReadCache(), pending = gate<UpstreamResponse>()
    const old = cache.read('one', policy, () => pending.promise)
    cache.invalidate(['session:one'])
    await cache.read('one', policy, async () => value(2))
    pending.resolve(value(1)); await old
    const fetched = await cache.read('one', policy, async () => value(3))
    expect(fetched.body.toString()).toContain('2')
  })
  it('enforces both byte and entry limits and never caches errors or no-store', async () => {
    const cache = new UpstreamReadCache(Date.now, 2000, 2, 1024)
    for (let i = 0; i < 10; i++) await cache.read(String(i), policy, async () => value(i))
    expect(cache.stats().entries).toBeLessThanOrEqual(2)
    expect(cache.stats().bytes).toBeLessThanOrEqual(2000)
    const error = vi.fn(async () => value(4, 401))
    await cache.read('error', policy, error); await cache.read('error', policy, error)
    expect(error).toHaveBeenCalledTimes(2)
    const noStore = vi.fn(async () => { const v = value(4); v.headers.set('cache-control', 'no-store'); return v })
    await cache.read('private', policy, noStore); await cache.read('private', policy, noStore)
    expect(noStore).toHaveBeenCalledTimes(2)
  })
  it('does not cache critical or cursor-dependent endpoints', () => {
    for (const path of ['/api/status', '/api/auth/me', '/api/auth/providers', '/api/config', '/api/sessions/search', '/api/session-unread', '/api/plugins/yaoyao/v1/capabilities']) {
      expect(readPolicy(path)).toBeUndefined()
    }
    expect(readPolicy('/api/plugins/yaoyao/v1/rooms/room/messages', new URLSearchParams('afterSeq=5'))).toBeUndefined()
  })
})

describe('scoped upstream read-through cache', () => {
  function fixture() {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: fetch.mock.calls.length }))
    const client = new UpstreamClient(new URL('http://localhost:9119'), fetch)
    const jar = new CookieJar('service=one')
    const read = (scope = 'alice', profile = 'a', options = {}) => client.withReadScope(scope, false,
      () => client.request('/api/sessions/same/messages', jar, { search: new URLSearchParams({ profile }), ...options }))
    return { client, jar, fetch, read }
  }
  it('isolates user/profile/cookie/headers while merging identical reads', async () => {
    const f = fixture()
    await Promise.all([f.read(), f.read(), f.read()]); expect(f.fetch).toHaveBeenCalledTimes(1)
    await f.read('bob'); await f.read('alice', 'b')
    expect(f.fetch).toHaveBeenCalledTimes(3)
    f.jar.replace(new CookieJar('service=two')); await f.read()
    expect(f.fetch).toHaveBeenCalledTimes(4)
    await f.read('alice', 'a', { headers: { 'x-custom-scope': 'other' } })
    expect(f.fetch).toHaveBeenCalledTimes(5)
  })
  it('bypasses background, explicitly fresh and range reads', async () => {
    const f = fixture()
    await f.read(); await f.read()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    await f.client.request('/api/sessions/same/messages', f.jar)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    await f.client.request('/api/sessions/same/messages', f.jar)
    expect(f.fetch).toHaveBeenCalledTimes(3)
    await f.read('alice', 'a', { cache: 'reload' })
    expect(f.fetch).toHaveBeenCalledTimes(4)
    expect(new Headers({ range: 'bytes=0-4' }).has('range')).toBe(true)
    await f.read('alice', 'a', { headers: { range: 'bytes=0-4' } })
    expect(f.fetch).toHaveBeenCalledTimes(5)
  })
  it('invalidates reads on writes and broker events without invalidating unrelated sessions', async () => {
    const f = fixture()
    await f.read()
    await f.client.withReadScope('alice', false, () => f.client.request('/api/sessions/other/messages', f.jar))
    f.client.observeRealtime({ kind: 'event', name: 'message.delta', sessionId: 'same' })
    await f.read()
    await f.client.withReadScope('alice', false, () => f.client.request('/api/sessions/other/messages', f.jar))
    expect(f.fetch).toHaveBeenCalledTimes(3)
    await f.client.request('/api/sessions/same', f.jar, { method: 'PATCH', body: { title: 'new' } })
    await f.read()
    expect(f.fetch).toHaveBeenCalledTimes(5)
  })
  it('leaves Web-owned conversation snapshots outside the upstream cache', async () => {
    expect(readPolicy('/api/app/conversations')).toBeUndefined()
    expect(readPolicy('/api/app/events', new URLSearchParams('after=5'))).toBeUndefined()
  })
})

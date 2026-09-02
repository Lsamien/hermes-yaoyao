// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { UpstreamServiceSession } from '../../src/server/localAuth.js'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'

describe('upstream service validation lease', () => {
  function fixture() {
    let now = 0, expire = false
    const paths: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname; paths.push(path)
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') return Response.json({ user_id: 'service' })
      if (path === '/api/auth/providers') return Response.json({ providers: [] })
      if (path === '/auth/password-login') return Response.json({ ok: true }, { headers: { 'set-cookie': 'session=new; Path=/' } })
      if (expire && new Headers(init?.headers).get('cookie') === 'session=old') return Response.json({ error: 'expired' }, { status: 401 })
      return Response.json({ path })
    })
    const client = new UpstreamClient(new URL('http://localhost:9119'), fetch, false, () => now)
    const session = new UpstreamServiceSession(client, () => ({ username: 'service', password: 'fixture' }), { now: () => now })
    session.jar.replace(new CookieJar('session=old'))
    return { session, client, fetch, paths, advance: (n: number) => { now += n }, expire: () => { expire = true } }
  }
  it('validates once for concurrent requests and rechecks only after thirty seconds', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.session.request(`/api/sessions/${i}`)))
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(1)
    expect(f.paths.filter(p => p === '/api/auth/me')).toHaveLength(1)
    await f.session.request('/api/sessions/a')
    expect(f.paths).toHaveLength(13)
    f.advance(30_001); await f.session.request('/api/sessions/b')
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(2)
  })
  it('reduces repeated protected reads to zero upstream calls on a warm hit', async () => {
    const f = fixture()
    const read = () => f.client.withReadScope('alice', false, () => f.session.request('/api/sessions'))
    await Promise.all([read(), read(), read()])
    expect(f.paths).toEqual(['/api/status', '/api/auth/me', '/api/sessions'])
    await read(); await read()
    expect(f.paths).toHaveLength(3)
  })
  it('repairs parallel 401s once, including raw withJar-style reads', async () => {
    const f = fixture(); await f.session.ensure(); f.expire()
    await Promise.all([f.client.request('/api/sessions/a', f.session.jar), f.client.request('/api/sessions/b', f.session.jar)])
    expect(f.paths.filter(p => p === '/auth/password-login')).toHaveLength(1)
    expect(f.paths.filter(p => p === '/api/sessions/a')).toHaveLength(2)
    expect(f.paths.filter(p => p === '/api/sessions/b')).toHaveLength(2)
    expect(f.session.jar.header).toBe('session=new')
  })
  it('never replays a write on a timeout or 500 response', async () => {
    const f = fixture(); await f.session.ensure()
    f.fetch.mockImplementation(async () => Response.json({ error: 'failed' }, { status: 500 }))
    const before = f.fetch.mock.calls.length
    expect((await f.session.request('/api/sessions/s', { method: 'POST', body: { text: 'once' } })).status).toBe(500)
    expect(f.fetch.mock.calls.length - before).toBe(1)
  })
  it('invalidates validation and cached data on configured credential changes', async () => {
    const f = fixture()
    let password = 'first'
    const session = new UpstreamServiceSession(f.client, () => ({ username: 'service', password }), { now: () => 0 })
    await session.ensure()
    await f.client.withReadScope('alice', false, () => session.request('/api/sessions'))
    expect(f.client.readCache.stats().entries).toBe(1)
    password = 'second'; await session.ensure()
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(2)
    expect(f.client.readCache.stats().entries).toBe(0)
  })
  it('does not memoize failed validation', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(Response.json({ error: 'offline' }, { status: 503 }))
    await expect(f.session.ensure()).rejects.toThrow('9119')
    await f.session.ensure()
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
  it('cannot overwrite new credentials with a late old login response', async () => {
    let username = 'old', started = false
    let release!: () => void
    const blocked = new Promise<void>(r => { release = r })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') return Response.json({}, { status: 401 })
      if (path === '/api/auth/providers') return Response.json({ providers: [] })
      const body = JSON.parse(String(init?.body))
      if (body.username === 'old') { started = true; await blocked }
      return Response.json({ ok: true }, { headers: { 'set-cookie': `session=${body.username}; Path=/` } })
    })
    const client = new UpstreamClient(new URL('http://localhost:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => ({ username, password: 'fixture' }))
    const old = session.ensure().then(() => undefined, error => error)
    await vi.waitFor(() => expect(started).toBe(true))
    username = 'new'
    await session.ensure()
    expect(session.jar.header).toBe('session=new')
    release()
    expect(await old).toMatchObject({ code: 'upstream_credentials_changed' })
    expect(session.jar.header).toBe('session=new')
  })
})

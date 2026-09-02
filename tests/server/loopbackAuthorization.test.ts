// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowsLocalAuthorization, isLocalAuthorizationTarget, localSessionToken, LoopbackTransport } from '../../src/server/loopbackAuthorization.js'
import { UpstreamServiceSession } from '../../src/server/localAuth.js'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'

const clients: UpstreamClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.unstubAllEnvs() })

function fixture(base = 'http://127.0.0.1:9119') {
  let token = 'native_loopback_fixture_token_initial', gated = false, page = true
  const paths: string[] = [], headers: Headers[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname, header = new Headers(init?.headers)
    paths.push(path); headers.push(header)
    if (path === '/api/status') return Response.json({ auth_required: gated })
    if (path === '/') return new Response(page ? `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};</script>` : '<html>login required</html>')
    if (path === '/api/auth/me') return Response.json({}, { status: 401 })
    if (header.get('x-hermes-session-token') !== token || gated) return Response.json({}, { status: 401 })
    return Response.json({ profiles: [], ok: true })
  })
  const client = new UpstreamClient(new URL(base), fetch); clients.push(client)
  const session = new UpstreamServiceSession(client, () => undefined)
  return { session, client, fetch, paths, headers, get token() { return token },
    rotate() { token = 'native_loopback_fixture_token_rotated' }, gate() { gated = true }, hideToken() { page = false } }
}

describe('native loopback authorization', () => {
  it('uses the native session token for protected REST and WebSocket, without password login', async () => {
    const f = fixture()
    expect((await f.session.request('/api/profiles')).status).toBe(200)
    expect(await f.session.webSocketCredential()).toEqual({ name: 'token', value: f.token })
    expect(f.session.authorizationMode).toBe('local')
    expect(f.paths).not.toContain('/auth/password-login')
    expect(f.paths).not.toContain('/api/auth/ws-ticket')
    expect(f.headers.every(h => !h.has('x-forwarded-for'))).toBe(true)
    expect(f.session.jar.browserCookies).toEqual([])
    expect(f.session.jar.header).toBeUndefined()
  })
  it('coalesces token acquisition and refreshes once after parallel 401s', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: 8 }, () => f.session.webSocketCredential()))
    expect(f.paths.filter(p => p === '/')).toHaveLength(1)
    f.rotate()
    const result = await Promise.all(Array.from({ length: 8 }, (_, i) => f.session.request(`/api/sessions/${i}`)))
    expect(result.every(r => r.status === 200)).toBe(true)
    expect(f.paths.filter(p => p === '/')).toHaveLength(2)
    expect(f.session.jar.sessionToken).toBe(f.token)
  })
  it('detects a rotated token before opening another socket, within the validation lease', async () => {
    const f = fixture()
    await f.session.webSocketCredential(); f.rotate()
    expect(await f.session.webSocketCredential()).toEqual({ name: 'token', value: f.token })
    expect(f.paths.filter(p => p === '/')).toHaveLength(2)
  })
  it('does not bypass account authorization on a loopback server', async () => {
    const f = fixture(); f.gate()
    await expect(f.session.request('/api/profiles')).rejects.toMatchObject({ code: 'upstream_credentials_required' })
    expect(f.paths).not.toContain('/')
    expect(f.paths).not.toContain('/auth/password-login')
  })
  it('fails closed when local Hermes begins requiring an account', async () => {
    const f = fixture(); await f.session.webSocketCredential(); f.gate()
    await expect(f.session.webSocketCredential()).rejects.toMatchObject({ code: 'upstream_credentials_required' })
    expect(f.paths.filter(p => p === '/')).toHaveLength(1)
  })
  it('rechecks auth mode on a ticket 401 after the upstream restarts into local mode', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(Response.json({ auth_required: true }))
      .mockResolvedValueOnce(Response.json({ user_id: 'service' }))
    await f.session.ensure()
    f.fetch.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    expect(await f.session.webSocketCredential()).toEqual({ name: 'token', value: f.token })
    expect(f.session.authorizationMode).toBe('local')
    expect(f.paths).not.toContain('/auth/password-login')
  })
  it('renews an expired account before retrying ticket issuance only once', async () => {
    const f = fixture()
    const session = new UpstreamServiceSession(f.client, () => ({ username: 'service', password: 'fixture' }))
    f.fetch.mockResolvedValueOnce(Response.json({ auth_required: true }))
      .mockResolvedValueOnce(Response.json({ user_id: 'service' }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ auth_required: true }))
      .mockResolvedValueOnce(Response.json({ providers: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true }, { headers: { 'Set-Cookie': 'service=renewed; Path=/' } }))
      .mockResolvedValueOnce(Response.json({ ticket: 'new-ticket' }))
    expect(await session.webSocketCredential()).toEqual({ name: 'ticket', value: 'new-ticket' })
    expect(f.fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/status', '/api/auth/me', '/api/auth/ws-ticket', '/api/status', '/api/auth/providers', '/auth/password-login', '/api/auth/ws-ticket',
    ])
    expect(session.jar.sessionToken).toBeUndefined()
  })
  it.each(['http://192.168.1.2:9119', 'http://host.docker.internal:9119', 'http://localhost:9119', 'https://remote.example'])('rejects account-free authorization outside literal loopback: %s', async base => {
    const f = fixture(base)
    await expect(f.session.ensure()).rejects.toMatchObject({ code: 'loopback_auth_required' })
    expect(f.paths).toEqual(['/api/status'])
  })
  it('never attaches a local token to a remote request', async () => {
    const f = fixture('https://remote.example'), jar = new CookieJar()
    jar.setSessionToken(f.token)
    await expect(f.client.request('/api/profiles', jar)).rejects.toMatchObject({ code: 'loopback_auth_required' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('fails closed if the native token is absent, without persisting partial authorization', async () => {
    const f = fixture(); f.hideToken()
    await expect(f.session.webSocketCredential()).rejects.toMatchObject({ code: 'local_authorization_unavailable' })
    expect(f.session.jar.sessionToken).toBeUndefined()
  })
  it('does not replay a command after transport failure or an upstream 500', async () => {
    const f = fixture(); await f.session.webSocketCredential()
    f.fetch.mockResolvedValueOnce(Response.json({}, { status: 500 }))
    const before = f.fetch.mock.calls.length
    expect((await f.session.request('/api/command', { method: 'POST', body: { text: 'once' } })).status).toBe(500)
    expect(f.fetch.mock.calls.length - before).toBe(1)
    f.fetch.mockRejectedValueOnce(new Error('connection lost'))
    await expect(f.session.request('/api/command', { method: 'POST', body: { text: 'once' } })).rejects.toMatchObject({ code: 'upstream_unavailable' })
    expect(f.fetch.mock.calls.length - before).toBe(2)
  })
  it('parses only a literal native token, never executes HTML or JavaScript', () => {
    expect(allowsLocalAuthorization({ auth_required: true, authRequired: false })).toBe(false)
    expect(allowsLocalAuthorization({})).toBe(false)
    expect(isLocalAuthorizationTarget(new URL('http://[::1]:9119'))).toBe(true)
    expect(isLocalAuthorizationTarget(new URL('http://user:pass@127.0.0.1:9119'))).toBe(false)
    expect(localSessionToken('window.__HERMES_SESSION_TOKEN__ = "abc"')).toBeUndefined()
    expect(localSessionToken('window.__HERMES_SESSION_TOKEN__ = alert(1)')).toBeUndefined()
    expect(localSessionToken('window.__HERMES_SESSION_TOKEN__ = "native_token_with_\\u0031_escape";')).toBe('native_token_with_1_escape')
  })
  it('bounds token-page reads even when the response has no Content-Length', async () => {
    const f = fixture()
    let cancelled = false
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024)) },
      cancel() { cancelled = true },
    })))
    await expect(f.client.request('/', new CookieJar(), { maxResponseBytes: 128 })).rejects.toMatchObject({ code: 'upstream_too_large' })
    expect(cancelled).toBe(true)
  })
  it('connects directly despite proxy settings, never follows redirects or leaks a token to a redirect target', async () => {
    let proxyHits = 0, redirectHits = 0, received = ''
    const proxy = createServer((_req, res) => { proxyHits++; res.end('proxy') })
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
    const origin = createServer((req, res) => {
      if (req.url === '/target') redirectHits++
      received = String(req.headers['x-hermes-session-token'] ?? '')
      res.writeHead(302, { Location: '/target' }); res.end()
    })
    origin.listen(0, '127.0.0.1'); await once(origin, 'listening')
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`)
    vi.stubEnv('NODE_USE_ENV_PROXY', '1'); vi.stubEnv('NO_PROXY', '')
    const transport = new LoopbackTransport()
    try {
      const response = await transport.fetch(new URL(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/`), { headers: { 'X-Hermes-Session-Token': 'fixture-token' } })
      expect(response.status).toBe(302); await response.arrayBuffer()
      expect(received).toBe('fixture-token'); expect(proxyHits).toBe(0); expect(redirectHits).toBe(0)
    } finally {
      transport.close()
      await Promise.all([new Promise<void>(r => origin.close(() => r())), new Promise<void>(r => proxy.close(() => r()))])
    }
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

interface RecordedRequest {
  path: string
  method: string
  search: URLSearchParams
  headers: Headers
  body?: unknown
}

const runtimes: ApplicationRuntime[] = []
const homes: string[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeConfig(upstream = 'http://127.0.0.1:9119'): ServerConfig {
  const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-server-'))
  const mediaRoot = join(home, 'media')
  mkdirSync(mediaRoot)
  homes.push(home)
  return {
    host: '127.0.0.1',
    port: 8800,
    upstream: new URL(upstream),
    allowedHosts: new Set(),
    home,
    mediaRoot,
    mediaOwner: 'samien',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function fakeGateway(records: RecordedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    const recorded: RecordedRequest = {
      path: url.pathname,
      method: init?.method ?? 'GET',
      search: url.searchParams,
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    }
    records.push(recorded)
    switch (url.pathname) {
      case '/api/status':
        return jsonResponse({ auth_required: true }, {
          headers: { 'set-cookie': 'hermes_session_at=access-cookie; Path=/; HttpOnly; SameSite=Lax' },
        })
      case '/api/auth/me':
        return jsonResponse({
          user_id: 'user-1', display_name: '测试用户', provider: 'basic',
        })
      case '/api/profiles':
        return jsonResponse({ profiles: [{ name: 'default', is_default: true }] })
      case '/api/plugins/yaoyao/profiles':
        return jsonResponse({ profiles: [{ name: 'default', agentName: '夭夭', isDefault: true }] })
      case '/api/auth/providers':
        return jsonResponse({ providers: [{ name: 'basic', supports_password: true }] })
      case '/auth/password-login':
        return jsonResponse({ ok: true })
      case '/api/profiles/sessions':
      case '/api/sessions':
        return jsonResponse({ sessions: [] })
      case '/api/sessions/session-1/messages':
        return jsonResponse({ messages: [], pagination: { returned: 0 } })
      case '/api/plugins/yaoyao/v1/rooms/11111111-1111-4111-8111-111111111111/messages':
        return jsonResponse({ accepted: true })
      default:
        return jsonResponse({ ok: true })
    }
  }) as typeof fetch
}

function cookieHeader(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[]
  return values.map((value) => value.split(';', 1)[0]).join('; ')
}

describe('8800 BFF', () => {
  it('serves authenticated historical media only from the configured root', async () => {
    const config = makeConfig()
    writeFileSync(join(config.mediaRoot, '报告.txt'), '历史文件内容')
    const runtime = createApplication({ config, fetchImpl: fakeGateway([]) })
    runtimes.push(runtime)
    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)
    const cookies = cookieHeader(bootstrap)

    const response = await request(runtime.app.callback())
      .get('/Users/samien/Agents/报告.txt').set('Host', '127.0.0.1:8800').set('Cookie', cookies).expect(200)
    expect(response.text).toBe('历史文件内容')
    expect(response.headers['content-disposition']).toContain('inline')
    await request(runtime.app.callback())
      .get('/Users/samien/Agents/../state.db').set('Host', '127.0.0.1:8800').set('Cookie', cookies).expect(404)
  })
  it('bootstraps sequentially without exposing the upstream address', async () => {
    const records: RecordedRequest[] = []
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway(records) })
    runtimes.push(runtime)
    const response = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(records.map((entry) => entry.path)).toEqual([
      '/api/status', '/api/auth/me', '/api/profiles', '/api/plugins/yaoyao/profiles',
    ])
    expect(response.body).toMatchObject({
      authRequired: true,
      authenticated: true,
      user: { user_id: 'user-1' },
      profiles: [{ name: 'default', agentName: '夭夭' }],
      groupUploadsEnabled: true,
    })
    expect(response.body.csrfToken).toEqual(expect.any(String))
    expect(response.body.status).toEqual({
      state: 'unknown',
      gatewayRunning: false,
    })
    expect(JSON.stringify(response.body)).not.toContain('9119')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
  })

  it('omits opener isolation on plaintext LAN origins but keeps it on loopback', async () => {
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway([]) })
    runtimes.push(runtime)
    const lan = await request(runtime.app.callback())
      .get('/healthz')
      .set('Host', '192.168.153.155:8800')
      .expect(200)
    expect(lan.headers['cross-origin-opener-policy']).toBeUndefined()

    const loopback = await request(runtime.app.callback())
      .get('/healthz')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(loopback.headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  it('degrades unsupported Gateway unread endpoints without browser 404 responses', async () => {
    const records: RecordedRequest[] = []
    const baseGateway = fakeGateway(records)
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.startsWith('/api/session-unread')) {
        records.push({
          path: url.pathname,
          method: init?.method ?? 'GET',
          search: url.searchParams,
          headers: new Headers(init?.headers),
        })
        const status = (init?.method ?? 'GET') === 'PATCH' ? 405 : 404
        return jsonResponse({ detail: status === 405 ? 'Method Not Allowed' : 'Not Found' }, { status })
      }
      return baseGateway(input, init)
    }) as typeof fetch
    const runtime = createApplication({ config: makeConfig(), fetchImpl })
    runtimes.push(runtime)

    const unread = await request(runtime.app.callback())
      .get('/api/app/sessions/unread?profile=yaoer')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(unread.body).toEqual({ profile: 'yaoer', total_unread: 0, sessions: [], supported: false })

    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const marked = await request(runtime.app.callback())
      .patch('/api/app/sessions/unread/session-1?profile=yaoer')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookieHeader(bootstrap))
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ readMessageCount: 12 })
      .expect(200)
    expect(marked.body).toEqual({ ok: true, supported: false })
  })

  it('requires exact Origin and CSRF on login, then sequences the Gateway login', async () => {
    const records: RecordedRequest[] = []
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway(records) })
    runtimes.push(runtime)
    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const cookies = cookieHeader(bootstrap)
    await request(runtime.app.callback())
      .post('/api/app/login')
      .set('Host', '127.0.0.1:8800')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ username: 'user', password: 'secret' })
      .expect(403)

    records.length = 0
    const response = await request(runtime.app.callback())
      .post('/api/app/login')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ username: 'user', password: 'secret' })
      .expect(200)
    expect(records.map((entry) => entry.path)).toEqual([
      '/api/auth/providers',
      '/auth/password-login',
      '/api/status',
      '/api/auth/me',
      '/api/profiles',
      '/api/plugins/yaoyao/profiles',
    ])
    expect(records[1]?.body).toEqual({ provider: 'basic', username: 'user', password: 'secret', next: '' })
    expect(response.body.authenticated).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  it('forces visibility and compressed-history query invariants', async () => {
    const records: RecordedRequest[] = []
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway(records) })
    runtimes.push(runtime)
    await request(runtime.app.callback())
      .get('/api/app/sessions?exclude_sources=evil')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(records.at(-1)?.path).toBe('/api/profiles/sessions')
    expect(records.at(-1)?.search.get('exclude_sources')).toBe('cron,ios_group')

    await request(runtime.app.callback())
      .get('/api/app/sessions/session-1/messages?offset=3&limit=50&order=oldest&include_compacted=false&profile=default')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const history = records.at(-1)!
    expect(history.search.get('offset')).toBe('3')
    expect(history.search.get('limit')).toBe('50')
    expect(history.search.get('order')).toBe('latest')
    expect(history.search.get('include_compacted')).toBe('true')
    expect(history.search.get('profile')).toBe('default')
  })

  it('keeps unknown API routes out of the SPA fallback', async () => {
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway([]) })
    runtimes.push(runtime)
    const response = await request(runtime.app.callback())
      .get('/api/anything')
      .set('Host', '127.0.0.1:8800')
      .expect(404)
    expect(response.body.code).toBe('not_found')
  })

  it('reuses a valid CSRF token across tabs instead of invalidating the first tab', async () => {
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway([]) })
    runtimes.push(runtime)
    const first = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const second = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .set('Cookie', cookieHeader(first))
      .expect(200)
    expect(second.body.csrfToken).toBe(first.body.csrfToken)
  })

  it('refuses anonymous group uploads before reading a multipart body', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/status') return jsonResponse({ auth_required: true })
      if (url.pathname === '/api/auth/me') return jsonResponse({ detail: 'Unauthorized' }, { status: 401 })
      return jsonResponse({ profiles: [] })
    }) as typeof fetch
    const runtime = createApplication({ config: makeConfig(), fetchImpl })
    runtimes.push(runtime)
    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    await request(runtime.app.callback())
      .post('/api/app/group-uploads')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookieHeader(bootstrap))
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .attach('files', Buffer.from('hello'), { filename: 'hello.txt', contentType: 'text/plain' })
      .expect(401)
  })

  it('forces active file content to download instead of executing on the 8800 origin', async () => {
    const fetchImpl = (async () => new Response('<script>window.pwned=true</script>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch
    const runtime = createApplication({ config: makeConfig(), fetchImpl })
    runtimes.push(runtime)
    const response = await request(runtime.app.callback())
      .get('/api/app/files/1/preview')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(response.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(response.headers['content-disposition']).toContain('attachment')
  })

  it('stores group files opaquely and injects the local path only upstream', async () => {
    const records: RecordedRequest[] = []
    const runtime = createApplication({ config: makeConfig(), fetchImpl: fakeGateway(records) })
    runtimes.push(runtime)
    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const cookies = cookieHeader(bootstrap)
    const upload = await request(runtime.app.callback())
      .post('/api/app/group-uploads')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .attach('files', Buffer.from('hello'), { filename: 'hello.txt', contentType: 'text/plain' })
      .expect(201)
    expect(upload.body.files[0]).toMatchObject({ name: 'hello.txt', size: 5 })
    expect(upload.body.files[0].path).toBeUndefined()

    await request(runtime.app.callback())
      .post('/api/app/groups/rooms/11111111-1111-4111-8111-111111111111/messages')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({
        requestId: '22222222-2222-4222-8222-222222222222',
        clientMessageId: '33333333-3333-4333-8333-333333333333',
        content: '请看文件',
        mentionAgentIds: [],
        uploadIds: [upload.body.files[0].id],
      })
      .expect(200)
    const sent = records.at(-1)?.body as { content: string; uploadIds?: unknown }
    expect(sent.uploadIds).toBeUndefined()
    expect(sent.content).toContain('请看文件')
    expect(sent.content).toContain(runtime.uploads.uploadRoot)
  })
})

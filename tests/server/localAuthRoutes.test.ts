import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, createNodeServer, type ApplicationRuntime, type NodeServerRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []
const nodeRuntimes: NodeServerRuntime[] = []
afterEach(async () => {
  for (const runtime of nodeRuntimes.splice(0)) await runtime.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cookies(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined
  return (values ?? []).map(value => value.split(';', 1)[0]).join('; ')
}

describe('8800 local authentication routes', () => {
  it('forces admin/admin to change, then serves shared profiles through the service account', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-routes-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      superviseDashboard: true,
    }
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      const headers = new Headers(init?.headers)
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') return headers.get('cookie')
        ? Response.json({ user_id: 'service' })
        : Response.json({ error: 'unauthorized' }, { status: 401 })
      if (path === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
      if (path === '/auth/password-login') return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json', 'set-cookie': 'hermes_service=session; Path=/; HttpOnly' },
      })
      if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/auth/ws-ticket') return Response.json({ ticket: 'upstream-ticket' })
      if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createApplication({ config, fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const initial = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)
    const login = await agent.post('/api/app/login')
      .set('Host', '127.0.0.1:8800').set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', initial.body.csrfToken).send({ username: 'admin', password: 'admin' }).expect(200)
    expect(login.body.user).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: true })
    expect(login.body.profiles).toEqual([])

    const changed = await agent.put('/api/app/account/credentials')
      .set('Host', '127.0.0.1:8800').set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', login.body.csrfToken)
      .send({ currentPassword: 'admin', newPassword: 'new-password', username: 'owner' }).expect(200)
    expect(changed.body.user).toMatchObject({ username: 'owner', mustChangePassword: false })

    const ready = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)
    expect(ready.body).toMatchObject({ upstreamReady: true, serverKind: 'yaoyao-web' })
    expect(ready.body.profiles).toHaveLength(1)

    await agent.post('/api/app/admin/users')
      .set('Host', '127.0.0.1:8800').set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', ready.body.csrfToken)
      .send({ username: 'member', password: 'temporary-password' }).expect(201)
    const users = await agent.get('/api/app/admin/users').set('Host', '127.0.0.1:8800').expect(200)
    expect(users.body.items.map((user: { username: string }) => user.username)).toEqual(['owner', 'member'])
    expect(cookies(changed)).not.toContain('admin')

    const native = request.agent(runtime.app.callback())
    await native.get('/api/status').set('Host', '127.0.0.1:8800').expect(200, /yaoyao-web/)
    await native.post('/auth/password-login').set('Host', '127.0.0.1:8800')
      .send({ provider: 'basic', username: 'owner', password: 'new-password', next: '' }).expect(200)
    const identity = await native.get('/api/auth/me').set('Host', '127.0.0.1:8800').expect(200)
    expect(identity.body).toMatchObject({ username: 'owner', role: 'admin', server_kind: 'yaoyao-web' })
    await native.get('/api/profiles').set('Host', '127.0.0.1:8800').expect(200)
    await native.post('/api/auth/ws-ticket').set('Host', '127.0.0.1:8800').send({}).expect(200, /upstream-ticket/)
  })

  it('lets one 8800 claim another 8800 as a direct child node', async () => {
    const registrations: unknown[] = []
    const make = (label: string) => {
      const home = mkdtempSync(join(tmpdir(), `yaoyao-${label}-`)); roots.push(home)
      const config: ServerConfig = {
        host: '127.0.0.1', port: 0, upstream: new URL('http://127.0.0.1:9119'),
        allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
        mediaOwner: 'tester', allowInsecureLan: true, insecureLan: true, production: false,
        superviseDashboard: true,
      }
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname
        const headers = new Headers(init?.headers)
        if (path === '/api/status') return Response.json({ auth_required: true })
        if (path === '/api/auth/me') return headers.get('cookie') ? Response.json({ user_id: 'service' }) : Response.json({}, { status: 401 })
        if (path === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
        if (path === '/auth/password-login') return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': `service_${label}=session; Path=/; HttpOnly` } })
        if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true, model: 'test' }] })
        if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
        if (path === '/api/plugins/yaoyao/v1/nodes' && init?.method === 'POST') {
          registrations.push(JSON.parse(String(init.body))); return Response.json({ nodeId: JSON.parse(String(init.body)).nodeId })
        }
        return Response.json({ ok: true })
      }) as typeof fetch
      const app = createApplication({ config, fetchImpl })
      const node = createNodeServer(app); nodeRuntimes.push(node)
      return { app, node, config }
    }
    const child = make('child')
    const parent = make('parent')
    await Promise.all([child, parent].map(({ node, config }) => new Promise<void>(resolve => {
      node.server.listen(0, '127.0.0.1', () => {
        config.port = (node.server.address() as { port: number }).port
        resolve()
      })
    })))
    const authenticate = async (runtime: ApplicationRuntime, port: number) => {
      const agent = request.agent(runtime.app.callback())
      const initial = await agent.get('/api/app/bootstrap').set('Host', `127.0.0.1:${port}`)
      const login = await agent.post('/api/app/login').set('Host', `127.0.0.1:${port}`)
        .set('Origin', `http://127.0.0.1:${port}`).set('X-CSRF-Token', initial.body.csrfToken)
        .send({ username: 'admin', password: 'admin' })
      const changed = await agent.put('/api/app/account/credentials').set('Host', `127.0.0.1:${port}`)
        .set('Origin', `http://127.0.0.1:${port}`).set('X-CSRF-Token', login.body.csrfToken)
        .send({ currentPassword: 'admin', newPassword: 'new-password', username: 'admin' })
      const ready = await agent.get('/api/app/bootstrap').set('Host', `127.0.0.1:${port}`)
      return { agent, csrf: ready.body.csrfToken, origin: `http://127.0.0.1:${port}`, changed }
    }
    const childAuth = await authenticate(child.app, child.config.port)
    const parentAuth = await authenticate(parent.app, parent.config.port)
    const pairing = await childAuth.agent.post('/api/app/pairings').set('Host', `127.0.0.1:${child.config.port}`)
      .set('Origin', childAuth.origin).set('X-CSRF-Token', childAuth.csrf)
      .send({ scopes: ['agents.read', 'history.read', 'sessions.execute', 'groups.read', 'groups.execute'] }).expect(201)
    await parentAuth.agent.post('/api/app/groups/nodes/pair').set('Host', `127.0.0.1:${parent.config.port}`)
      .set('Origin', parentAuth.origin).set('X-CSRF-Token', parentAuth.csrf)
      .send({ qrPayload: pairing.body.qrPayload, name: '子 8800' }).expect(201)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({ name: '子 8800', profiles: [{ name: 'default' }] })
  })
})

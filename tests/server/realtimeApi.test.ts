// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native Hermes sessions are read-only on 8800', () => {
  it('does not advertise realtime chat and rejects all native session writes locally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-native-history-'))
    roots.push(home)
    let upstreamCalls = 0
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home,
      imagesRoot: home, mediaOwner: 'test', allowInsecureLan: false,
      insecureLan: false, production: false,
    }
    const runtime = createApplication({
      config,
      fetchImpl: (async (input, init) => {
        upstreamCalls += 1
        const path = new URL(String(input)).pathname
        if (path === '/api/status') return Response.json({ auth_required: true })
        if (path === '/api/auth/me') return Response.json({ user_id: 'service' })
        if (path === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
        if (path === '/auth/password-login') return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json', 'set-cookie': 'hermes_service=session; Path=/; HttpOnly' },
        })
        if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default' }] })
        return Response.json({ method: init?.method ?? 'GET' })
      }) as typeof fetch,
    })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const origin = 'http://127.0.0.1:8800'
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)
    const login = await agent.post('/api/app/login').set('Host', '127.0.0.1:8800')
      .set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ username: 'admin', password: 'admin' }).expect(200)
    const credentials = await agent.put('/api/app/account/credentials')
      .set('Host', '127.0.0.1:8800').set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken)
      .send({ username: 'owner', currentPassword: 'admin', newPassword: 'fixture-password' }).expect(200)
    const csrf = credentials.body.csrfToken

    const capabilities = await agent.get('/api/realtime/capabilities').set('Host', '127.0.0.1:8800').expect(200)
    expect(capabilities.body.channels).toEqual([])
    await agent.post('/api/realtime/channels').set('Host', '127.0.0.1:8800')
      .set('Origin', origin).set('X-CSRF-Token', csrf).send({ channel: 'chat' })
      .expect(410, { error: '原生 Hermes 会话仅供历史查看；请在聊天中开始或继续对话', code: 'native_sessions_read_only' })

    const beforeWrites = upstreamCalls
    for (const path of ['/api/app/sessions/session-1', '/api/sessions/session-1']) {
      const response = await agent.patch(path).set('Host', '127.0.0.1:8800')
        .set('Origin', origin).set('X-CSRF-Token', csrf).send({ title: '不能修改' }).expect(410)
      expect(response.body.code).toBe('native_sessions_read_only')
    }
    const pairing = runtime.pairings.create('hermes_device=session')
    const paired = runtime.pairings.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: 'history-only fixture',
    })
    const pairedWrite = await request(runtime.app.callback())
      .patch(`/node/${paired.device.id}/api/sessions/session-1`)
      .set('Host', '127.0.0.1:8800')
      .set('Authorization', `Bearer ${paired.token}`)
      .send({ title: '不能修改' })
      .expect(410)
    expect(pairedWrite.body.code).toBe('native_sessions_read_only')
    expect(upstreamCalls).toBe(beforeWrites)
  })
})

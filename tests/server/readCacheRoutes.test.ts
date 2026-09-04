import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

const runtimes: ApplicationRuntime[] = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close() })

describe('authenticated read cache routes', () => {
  it('hits cached reads, honors fresh reads and never bypasses logout authentication', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-read-cache-routes-'))
    const config: ServerConfig = { host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:19119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home, mediaOwner: 'test',
      allowInsecureLan: false, insecureLan: false, production: false }
    let sessionReads = 0, statusReads = 0, currentTitle = 'original'
    const runtime = createApplication({ config, fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') { statusReads++; return Response.json({ auth_required: false }) }
      if (path === '/api/profiles' || path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/sessions' && (init?.method ?? 'GET') === 'GET') { sessionReads++; return Response.json({ sessions: [{ id: 'one', title: currentTitle }] }) }
      if (path === '/api/sessions/one' && init?.method === 'PATCH') { currentTitle = 'renamed'; return Response.json({ ok: true }) }
      return Response.json({ ok: true })
    }) as typeof fetch })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback()), origin = 'http://127.0.0.1:15300'
    const start = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    await agent.post('/api/app/setup').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', start.body.csrfToken).send({ username: 'owner', password: 'fixture-password' }).expect(200)
    const statusBefore = statusReads
    const first = await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').expect(200)
    const statusAfterColdRead = statusReads
    const second = await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').expect(200)
    expect(second.body).toEqual(first.body)
    expect(sessionReads).toBe(1)
    expect(statusAfterColdRead - statusBefore).toBeLessThanOrEqual(1)
    expect(statusReads).toBe(statusAfterColdRead)
    currentTitle = 'external-change'
    const fresh = await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').set('X-Yaoyao-Cache', 'bypass').expect(200)
    expect(fresh.body.sessions[0].title).toBe('external-change')
    const after = await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').expect(200)
    expect(after.body.sessions[0].title).toBe('external-change')
    expect(sessionReads).toBe(3)
    await agent.patch('/api/sessions/one').set('Host', '127.0.0.1:15300')
      .send({ title: 'renamed' }).expect(410, {
        error: '原生 Hermes 会话仅供历史查看；请在聊天中开始或继续对话',
        code: 'native_sessions_read_only',
      })
    const unchanged = await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').expect(200)
    expect(unchanged.body.sessions[0].title).toBe('external-change')
    expect(sessionReads).toBe(3)
    await agent.post('/auth/logout').set('Host', '127.0.0.1:15300').send({}).expect(200)
    await agent.get('/api/sessions').set('Host', '127.0.0.1:15300').expect(401)
    expect(sessionReads).toBe(3)
  })
})

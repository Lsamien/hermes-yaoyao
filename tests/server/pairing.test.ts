import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { NodePairingStore } from '../../src/server/pairing.js'

const homes: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-pairing-'))
  homes.push(home)
  return home
}

function config(home: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 8800,
    upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(),
    home,
    mediaRoot: join(home, 'media'),
    attachmentsRoot: join(home, 'attachments'),
    imagesRoot: join(home, 'images'),
    mediaOwner: 'tester',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
  }
}

function cookies(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined
  return (values ?? []).map((value) => value.split(';', 1)[0]).join('; ')
}

describe('Hermes node pairing', () => {
  it('stores only encrypted delegated cookies and rejects replayed pairing secrets', () => {
    const home = temporaryHome()
    let now = 1_000
    const store = new NodePairingStore(home, () => now)
    const pairing = store.create('hermes_session_rt=refresh-secret', ['agents.read', 'history.read'])
    const claimed = store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '测试 iPhone',
    })

    expect(store.authorize(claimed.device.id, claimed.token, 'history.read'))
      .toBe('hermes_session_rt=refresh-secret')
    expect(() => store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '重放设备',
    })).toThrowError(/already used/i)
    expect(() => store.authorize(claimed.device.id, claimed.token, 'groups.execute'))
      .toThrowError(/lacks groups.execute/i)

    const persisted = readFileSync(join(home, 'paired-devices.json'), 'utf8')
    expect(persisted).not.toContain('refresh-secret')
    expect(persisted).not.toContain(claimed.token)

    now += 1
    const restored = new NodePairingStore(home, () => now)
    expect(restored.nodeID).toBe(store.nodeID)
    expect(restored.authorize(claimed.device.id, claimed.token, 'agents.read'))
      .toBe('hermes_session_rt=refresh-secret')
  })

  it('expires unclaimed QR secrets after two minutes', () => {
    const home = temporaryHome()
    let now = 10_000
    const store = new NodePairingStore(home, () => now)
    const pairing = store.create('hermes_session_at=access')
    now = pairing.expiresAt + 1
    expect(store.status(pairing.id)).toEqual({ state: 'expired' })
    expect(() => store.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: '迟到的设备',
    })).toThrowError(/expired/i)
  })

  it('claims from the QR and exposes a revocable Hermes-compatible node proxy', async () => {
    const home = temporaryHome()
    const upstreamRequests: Array<{
      path: string
      cookie: string
      authorization: string
      contentType: string
      nodeClient: string
      body?: Buffer
    }> = []
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      const recordedBody = init?.body === undefined
        ? undefined
        : Buffer.from(await new Response(init.body).arrayBuffer())
      upstreamRequests.push({
        path: url.pathname,
        cookie: headers.get('cookie') ?? '',
        authorization: headers.get('authorization') ?? '',
        contentType: headers.get('content-type') ?? '',
        nodeClient: headers.get('x-yaoyao-node-client') ?? '',
        body: recordedBody,
      })
      const responseHeaders = new Headers({ 'content-type': 'application/json' })
      if (url.pathname === '/api/status') {
        responseHeaders.append('set-cookie', 'hermes_session_at=paired-access; Path=/; HttpOnly')
        return new Response(JSON.stringify({ auth_required: true }), { headers: responseHeaders })
      }
      if (url.pathname === '/api/auth/me') {
        return new Response(JSON.stringify({ user_id: 'owner', display_name: 'Owner' }), { headers: responseHeaders })
      }
      if (url.pathname === '/api/profiles') {
        return new Response(JSON.stringify({ profiles: [{ name: 'default', is_default: true }] }), { headers: responseHeaders })
      }
      if (url.pathname === '/api/plugins/yaoyao/profiles') {
        return new Response(JSON.stringify({ profiles: [{ name: 'default', botName: '竹儿', agentName: '旧插件名称' }] }), { headers: responseHeaders })
      }
      if (url.pathname === '/api/auth/providers') {
        return new Response(JSON.stringify({
          providers: [{ name: 'basic', supports_password: true }],
        }), { headers: responseHeaders })
      }
      if (url.pathname === '/auth/password-login') {
        responseHeaders.append('set-cookie', 'hermes_session_rt=independent-refresh; Path=/; HttpOnly')
        return new Response(JSON.stringify({ ok: true }), { headers: responseHeaders })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: responseHeaders })
    }) as typeof fetch
    const runtime = createApplication({ config: config(home), fetchImpl })
    runtimes.push(runtime)

    const bootstrap = await request(runtime.app.callback())
      .get('/api/app/bootstrap')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    const cookie = cookies(bootstrap)
    await request(runtime.app.callback())
      .post('/api/app/pairings')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ scopes: ['agents.read'] })
      .expect(400)
    const pairing = await request(runtime.app.callback())
      .post('/api/app/pairings')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({
        scopes: ['agents.read', 'history.read', 'sessions.execute', 'groups.execute'],
        username: 'paired-user',
        password: 'paired-password',
      })
      .expect(201)

    const deepLink = new URL(pairing.body.qrPayload)
    expect(deepLink.protocol).toBe('yaoyao:')
    expect(deepLink.searchParams.get('secret')).toBeTruthy()
    const claim = await request(runtime.app.callback())
      .post('/api/pair/v1/claim')
      .set('Host', '127.0.0.1:8800')
      .send({
        pairingId: pairing.body.pairingId,
        secret: deepLink.searchParams.get('secret'),
        deviceName: 'YaoYao iPhone',
      })
      .expect(201)
    expect(claim.body.serverUrl).toBe(`http://127.0.0.1:8800/node/${claim.body.deviceId}`)
    expect(readFileSync(join(home, 'paired-devices.json'), 'utf8'))
      .not.toContain('paired-password')

    const profiles = await request(runtime.app.callback())
      .get(`/node/${claim.body.deviceId}/api/profiles`)
      .set('Host', '127.0.0.1:8800')
      .set('Authorization', `Bearer ${claim.body.token}`)
      .expect(200)
    expect(profiles.body.profiles[0].name).toBe('default')
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: '/api/profiles',
      authorization: '',
    })
    expect(upstreamRequests.at(-1)?.cookie).toContain('hermes_session_at=paired-access')
    expect(upstreamRequests.at(-1)?.cookie).toContain('hermes_session_rt=independent-refresh')

    const attachment = Buffer.from('remote attachment')
    await request(runtime.app.callback())
      .post(`/node/${claim.body.deviceId}/api/plugins/yaoyao/v1/node-worker/sessions/runtime-1/attachments`)
      .set('Host', '127.0.0.1:8800')
      .set('Authorization', `Bearer ${claim.body.token}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name-B64', Buffer.from('note.txt').toString('base64url'))
      .set('X-Mime-Type', 'text/plain')
      .send(attachment)
      .expect(200)
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: '/api/plugins/yaoyao/v1/node-worker/sessions/runtime-1/attachments',
      contentType: 'application/octet-stream',
      nodeClient: claim.body.deviceId,
      body: attachment,
    })

    await request(runtime.app.callback())
      .delete(`/api/app/paired-devices/${claim.body.deviceId}`)
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .expect(200)
    await request(runtime.app.callback())
      .get(`/node/${claim.body.deviceId}/api/profiles`)
      .set('Host', '127.0.0.1:8800')
      .set('Authorization', `Bearer ${claim.body.token}`)
      .expect(401)
  })
})

import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'
import {
  APNsConfigurationManager,
  apnsConfigurationPath,
  validateAPNsConfiguration,
} from '../../src/server/apnsConfiguration.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('iOS push routes', () => {
  it('validates and enables a server-local APNs key path without blocking broad permissions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-web-config-'))
    roots.push(home)
    const keyFile = join(home, 'AuthKey_TEST.p8')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(keyFile, privateKey, { mode: 0o644 })
    chmodSync(keyFile, 0o644)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const push = new PushCoordinator({
      home,
      autoFlush: false,
      providerFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
    })
    const apnsConfiguration = new APNsConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe: async () => undefined },
    )
    const runtime = createAuthenticatedApplication({ config, push, apnsConfiguration })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)
    const mutation = () => agent.put('/api/app/system/push-config')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .send({
        keyFile,
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        topic: 'cn.samien.yaoyao.hermes',
        environments: ['development', 'production'],
      })

    await mutation().expect(403)
    const saved = await mutation().set('X-CSRF-Token', bootstrap.body.csrfToken).expect(200)
    expect(saved.body).toMatchObject({
      configured: true,
      healthy: true,
      source: 'file',
      editable: true,
      keyFile: realpathSync(keyFile),
      environments: ['development', 'production'],
      warnings: [{ code: 'apns_key_permissions', actualMode: '0644', recommendedMode: '0600' }],
    })
    expect(statSync(apnsConfigurationPath(home)).mode & 0o777).toBe(0o600)
    await agent.get('/api/app/system/push-status')
      .set('Host', '127.0.0.1:8800')
      .expect(200, /"source":"file"/)
  })

  it('keeps environment-managed APNs configuration read-only through the admin API', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-env-managed-'))
    roots.push(home)
    const keyFile = join(home, 'AuthKey_TEST.p8')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(keyFile, privateKey, { mode: 0o600 })
    const validated = validateAPNsConfiguration({
      keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'cn.samien.yaoyao.hermes',
      environments: ['development'],
    })
    const initial = { ...validated, source: 'environment' as const, editable: false }
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      apns: validated.config,
      apnsSettings: initial,
    }
    const push = new PushCoordinator({
      home, apns: validated.config,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
      autoFlush: false,
    })
    const apnsConfiguration = new APNsConfigurationManager(home, initial, { probe: async () => undefined })
    const runtime = createAuthenticatedApplication({ config, push, apnsConfiguration })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)

    const response = await agent.put('/api/app/system/push-config')
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({
        keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'cn.samien.yaoyao.hermes',
        environments: ['development'],
      })
      .expect(409)
    expect(response.body).toMatchObject({ code: 'apns_environment_managed' })
  })

  it('registers an installation, manages team subscriptions, badge, and admin status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-routes-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      apns: { keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes' },
    }
    const push = new PushCoordinator({
      home,
      apns: config.apns,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
      autoFlush: false,
    })
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      if (path.endsWith('/messages')) return Response.json({ items: [{ id: 'baseline', seq: 12 }] })
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createAuthenticatedApplication({ config, push, fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const host = (value: request.Test) => value.set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
    const installationID = '11111111-1111-4111-8111-111111111111'
    const accountID = '22222222-2222-4222-8222-222222222222'
    const roomID = '33333333-3333-4333-8333-333333333333'
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)

    const capabilities = await host(agent.get('/api/push/v1/capabilities')).expect(200)
    expect(capabilities.body).toMatchObject({
      protocolVersion: 1,
      enabled: true,
      topic: 'cn.samien.yaoyao.hermes',
      maximumSummaryCharacters: 180,
    })
    await agent.get('/api/app/push/v1/capabilities').set('Host', '127.0.0.1:8800').expect(200)

    const registered = await host(agent.put(`/api/push/v1/installations/${installationID}/accounts/${accountID}`))
      .send({ token: 'ab'.repeat(32), environment: 'development', appVersion: '1.2 (139)' })
      .expect(200)
    expect(registered.body.installation).toMatchObject({
      installationId: installationID,
      clientAccountId: accountID,
      environment: 'development',
    })

    await host(agent.put(`/api/app/push/v1/group-subscriptions/${roomID}`))
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ enabled: true })
      .expect(200, /"enabled":true/)
    const subscriptions = await host(agent.get('/api/app/push/v1/group-subscriptions')).expect(200)
    expect(subscriptions.body.roomIds).toEqual([roomID])

    await host(agent.post(`/api/push/v1/installations/${installationID}/accounts/${accountID}/badge-reset`))
      .send({})
      .expect(200, { badge: 0 })
    const status = await host(agent.get('/api/app/system/push-status')).expect(200)
    expect(status.body).toMatchObject({ configured: true, healthy: true, registrationCount: 1, topic: 'cn.samien.yaoyao.hermes' })

    await host(agent.delete(`/api/push/v1/installations/${installationID}/accounts/${accountID}`))
      .expect(200, /"removed":true/)
    expect(push.status().registrationCount).toBe(0)
  })

  it('rejects malformed registration and subscription input', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-validation-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const runtime = createAuthenticatedApplication({ config })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const headers = (value: request.Test) => value
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')

    await headers(agent.put('/api/push/v1/installations/11111111-1111-4111-8111-111111111111/accounts/22222222-2222-4222-8222-222222222222'))
      .send({ token: 'not-a-token', environment: 'unknown' })
      .expect(400, /environment must be development or production/)
    await headers(agent.put('/api/push/v1/group-subscriptions/33333333-3333-4333-8333-333333333333'))
      .send({ enabled: 'yes' })
      .expect(400, /enabled must be a boolean/)
  })

  it('automatically subscribes the current user after Web or native team participation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-auto-subscribe-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/status') return Response.json({ auth_required: false })
      if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (url.pathname === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      if (/\/api\/plugins\/yaoyao\/v1\/rooms\/[0-9a-f-]{36}\/messages$/.test(url.pathname)) {
        return Response.json({ message: { id: 'message', seq: 7, senderKind: 'human', content: 'hello' }, runs: [] })
      }
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createAuthenticatedApplication({ config, fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const firstRoom = '44444444-4444-4444-8444-444444444444'
    const secondRoom = '55555555-5555-4555-8555-555555555555'
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)

    await agent.post(`/api/app/groups/rooms/${firstRoom}/messages`)
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ requestId: 'request-web', clientMessageId: 'client-web', content: 'Web 参与', mentionAgentIds: [] })
      .expect(200)
    await agent.post(`/api/plugins/yaoyao/v1/rooms/${secondRoom}/messages`)
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .send({ requestId: 'request-ios', clientMessageId: 'client-ios', content: 'iOS 参与', mentionAgentIds: [] })
      .expect(200)

    const subscriptions = await agent.get('/api/push/v1/group-subscriptions')
      .set('Host', '127.0.0.1:8800')
      .expect(200)
    expect(subscriptions.body.roomIds).toEqual([firstRoom, secondRoom])
    expect(subscriptions.body.subscriptions.every((item: { lastMessageSeq?: number }) => item.lastMessageSeq === 7)).toBe(true)
  })

  it('never turns a successful team send into a failure when optional push state is unavailable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-state-failure-'))
    roots.push(home)
    mkdirSync(join(home, 'push'))
    writeFileSync(join(home, 'push', 'state.json'), '{broken', { mode: 0o600 })
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: true,
    }
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      if (path.endsWith('/messages')) {
        return Response.json({ message: { id: 'accepted', seq: 1, senderKind: 'human', content: '已接收' }, runs: [] })
      }
      return Response.json({ ok: true })
    }) as typeof fetch
    const push = new PushCoordinator({ home, autoFlush: false })
    const runtime = createAuthenticatedApplication({ config, fetchImpl, push })
    runtimes.push(runtime)
    // The error event is operational telemetry; suppress Koa's default stderr
    // output while asserting the primary response remains authoritative.
    runtime.app.on('error', () => undefined)
    const agent = request.agent(runtime.app.callback())
    const roomID = '66666666-6666-4666-8666-666666666666'
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:8800').expect(200)

    await agent.post(`/api/app/groups/rooms/${roomID}/messages`)
      .set('Host', '127.0.0.1:8800')
      .set('Origin', 'http://127.0.0.1:8800')
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ requestId: 'request', clientMessageId: 'client', content: '仍应成功', mentionAgentIds: [] })
      .expect(200, /accepted/)
  })
})

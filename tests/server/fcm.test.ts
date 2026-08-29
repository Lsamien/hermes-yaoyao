import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyFCMResponse,
  createFCMServiceAccountJWT,
  FCMProbeError,
  FCMProvider,
  type FCMTransport,
} from '../../src/server/fcm.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function serviceAccount(): { path: string; privateKey: string } {
  const root = mkdtempSync(join(tmpdir(), 'yaoyao-fcm-'))
  roots.push(root)
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const path = join(root, 'service-account.json')
  writeFileSync(path, JSON.stringify({
    type: 'service_account',
    project_id: 'yaoyao-test-project',
    client_email: 'push@yaoyao-test-project.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  }), { mode: 0o600 })
  return { path, privateKey }
}

describe('FCM HTTP v1 provider', () => {
  it('creates a short-lived RS256 OAuth assertion with the messaging scope', () => {
    const { privateKey } = serviceAccount()
    const jwt = createFCMServiceAccountJWT({
      clientEmail: 'push@example.test',
      privateKey,
      tokenUri: 'https://oauth2.googleapis.com/token',
    }, 1_800_000)
    const [header, claims] = jwt.split('.').slice(0, 2).map(value => (
      JSON.parse(Buffer.from(value!, 'base64url').toString('utf8')) as Record<string, unknown>
    ))
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    expect(claims).toMatchObject({
      iss: 'push@example.test',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      iat: 1_800,
      exp: 5_400,
    })
  })

  it('uses fid data-only delivery, package restriction, validate_only, and cached OAuth', async () => {
    const account = serviceAccount()
    const requests: Array<{ url: URL; init: RequestInit }> = []
    const transport: FCMTransport = {
      request: async (url, init) => {
        requests.push({ url: new URL(url), init })
        if (url.hostname === 'oauth2.googleapis.com') {
          return { status: 200, body: JSON.stringify({ access_token: 'oauth-access-token', expires_in: 3_600 }) }
        }
        return { status: 200, body: JSON.stringify({ name: 'projects/test/messages/1' }) }
      },
    }
    const provider = new FCMProvider({
      serviceAccountFile: account.path,
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    }, { transport, now: () => 1_800_000 })

    await expect(provider.send({
      fid: 'fcm-registration-id-1234567890',
      data: { eventId: 'event-1', collapseId: 'chat:1' },
      collapseId: 'must-not-be-sent-as-android-collapse-key',
      ttlSeconds: 30,
    })).resolves.toMatchObject({ disposition: 'success' })
    await expect(provider.send({ fid: 'fcm-registration-id-2', data: { eventId: 'event-2' } }))
      .resolves.toMatchObject({ disposition: 'success' })

    expect(requests.filter(item => item.url.hostname === 'oauth2.googleapis.com')).toHaveLength(1)
    const delivery = requests.find(item => item.url.hostname === 'fcm.googleapis.com')!
    const body = JSON.parse(String(delivery.init.body)) as Record<string, any>
    expect(delivery.url.pathname).toBe('/v1/projects/yaoyao-test-project/messages:send')
    expect(body.message).toMatchObject({
      fid: 'fcm-registration-id-1234567890',
      data: { eventId: 'event-1', collapseId: 'chat:1' },
      android: {
        priority: 'HIGH',
        ttl: '30s',
        restricted_package_name: 'cn.samien.yaoyao.hermes',
      },
    })
    expect(body.message).not.toHaveProperty('token')
    expect(body.message.android).not.toHaveProperty('collapse_key')
    expect(body).not.toHaveProperty('validate_only')

    requests.length = 0
    const probeTransport: FCMTransport = {
      request: async (url, init) => {
        requests.push({ url: new URL(url), init })
        if (url.hostname === 'oauth2.googleapis.com') {
          return { status: 200, body: JSON.stringify({ access_token: 'probe-token', expires_in: 3_600 }) }
        }
        return {
          status: 400,
          body: JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } }),
        }
      },
    }
    const probe = new FCMProvider(provider.config, { transport: probeTransport, now: () => 1_800_000 })
    await expect(probe.probe()).resolves.toBeUndefined()
    expect(requests.at(-1)!.url.searchParams.has('validate_only')).toBe(false)
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toMatchObject({ validate_only: true })

    const successfulProbe = new FCMProvider(provider.config, {
      transport: {
        request: async (url) => url.hostname === 'oauth2.googleapis.com'
          ? { status: 200, body: JSON.stringify({ access_token: 'probe-token', expires_in: 3_600 }) }
          : { status: 200, body: JSON.stringify({ name: 'projects/test/messages/probe' }) },
      },
      now: () => 1_800_000,
    })
    await expect(successfulProbe.probe()).resolves.toBeUndefined()

    const unavailableProbe = new FCMProvider(provider.config, {
      transport: {
        request: async (url) => url.hostname === 'oauth2.googleapis.com'
          ? { status: 200, body: JSON.stringify({ access_token: 'probe-token', expires_in: 3_600 }) }
          : { status: 503, body: '{}' },
      },
      now: () => 1_800_000,
    })
    await expect(unavailableProbe.probe()).rejects.toBeInstanceOf(FCMProbeError)
  })

  it('retries throttling, removes only explicit invalid targets, and rejects oversized data locally', async () => {
    expect(classifyFCMResponse({ status: 404, body: '{}' })).toMatchObject({ disposition: 'failed' })
    expect(classifyFCMResponse({
      status: 404,
      body: JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
    })).toMatchObject({ disposition: 'unregister', reason: 'UNREGISTERED' })
    expect(classifyFCMResponse({ status: 429, headers: { 'retry-after': '2' }, body: '{}' }))
      .toMatchObject({ disposition: 'retry', retryAfterMs: 2_000 })
    expect(classifyFCMResponse({ status: 429, body: '{}' }))
      .toMatchObject({ disposition: 'retry', retryAfterMs: 60_000 })
    expect(classifyFCMResponse({ status: 503, body: '{}' }))
      .toMatchObject({ disposition: 'retry', retryAfterMs: 10_000 })

    const account = serviceAccount()
    let contacted = false
    const provider = new FCMProvider({
      serviceAccountFile: account.path,
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    }, { transport: { request: async () => { contacted = true; return { status: 500 } } } })
    await expect(provider.send({ fid: 'fcm-registration-id-1234', data: { value: 'x'.repeat(4_097) } }))
      .resolves.toMatchObject({ disposition: 'failed', reason: 'PayloadTooLarge' })
    expect(contacted).toBe(false)

    await expect(provider.send({ fid: 'fcm-registration-id-1234', data: { 'google.internal': 'value' } }))
      .resolves.toMatchObject({ disposition: 'failed', reason: 'ReservedDataKey' })
    expect(contacted).toBe(false)
  })
})

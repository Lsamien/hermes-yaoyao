import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APNS_DEVELOPMENT_ENDPOINT,
  APNS_PRODUCTION_ENDPOINT,
  APNsProvider,
  NodeHttp2APNsTransport,
  classifyAPNsResponse,
  createAPNsProviderToken,
  type APNsTransport,
} from '../../src/server/apns.js'
import type { APNsProviderConfig } from '../../src/server/config.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function keyFixture(): { config: APNsProviderConfig; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const root = mkdtempSync(join(tmpdir(), 'yaoyao-apns-'))
  roots.push(root)
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyFile = join(root, 'AuthKey_TEST.p8')
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }))
  return {
    config: { keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'cn.samien.yaoyao.hermes' },
    publicKey,
  }
}

describe('APNs provider token', () => {
  it('creates a verifiable ES256 JWT with the Apple key and team identifiers', () => {
    const { config, publicKey } = keyFixture()
    const now = Date.UTC(2026, 7, 28, 10, 0, 0)
    const token = createAPNsProviderToken(config, now)
    const [header, claims, signature] = token.split('.') as [string, string, string]

    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({ alg: 'ES256', kid: config.keyId })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toEqual({
      iss: config.teamId,
      iat: Math.floor(now / 1_000),
    })
    expect(verify(
      'sha256',
      Buffer.from(`${header}.${claims}`, 'ascii'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )).toBe(true)
  })
})

describe('APNs response classification', () => {
  it('separates retry, registration cleanup, provider configuration, and terminal failures', () => {
    expect(classifyAPNsResponse({ status: 200 }).disposition).toBe('success')
    expect(classifyAPNsResponse({ status: 410, body: '{"reason":"Unregistered","timestamp":123}' })).toMatchObject({
      disposition: 'unregister', reason: 'Unregistered', timestamp: 123,
    })
    expect(classifyAPNsResponse({ status: 400, body: '{"reason":"BadDeviceToken"}' }).disposition).toBe('unregister')
    expect(classifyAPNsResponse({ status: 403, body: '{"reason":"InvalidProviderToken"}' }).disposition).toBe('configuration')
    expect(classifyAPNsResponse({ status: 400, body: '{"reason":"BadCollapseId"}' }).disposition).toBe('failed')
    expect(classifyAPNsResponse({ status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' }).disposition).toBe('unregister')
    expect(classifyAPNsResponse({ status: 400, body: '{"reason":"BadTopic"}' }).disposition).toBe('configuration')
    expect(classifyAPNsResponse({ status: 429, headers: { 'retry-after': '3' } })).toMatchObject({
      disposition: 'retry', retryAfterMs: 3_000,
    })
    expect(classifyAPNsResponse({ status: 503 }).disposition).toBe('retry')
  })
})

describe('APNsProvider', () => {
  it('sends alert payloads to the selected environment without assuming a fixed token length', async () => {
    const { config } = keyFixture()
    const calls: Array<{ endpoint: URL; headers: Record<string, unknown>; body: Uint8Array }> = []
    const transport: APNsTransport = {
      async send(endpoint, headers, body) {
        calls.push({ endpoint, headers: headers as Record<string, unknown>, body })
        return { status: 200, headers: { 'apns-id': 'returned-id' } }
      },
    }
    const provider = new APNsProvider(config, { transport, now: () => 1_777_777_777_000 })

    await expect(provider.send({
      deviceToken: 'ab'.repeat(16),
      environment: 'development',
      payload: { aps: { alert: '完成' } },
      collapseId: 'chat-1',
    })).resolves.toMatchObject({ disposition: 'success', apnsId: 'returned-id' })
    await provider.send({
      deviceToken: 'cd'.repeat(48),
      environment: 'production',
      payload: { aps: { alert: '完成' } },
    })

    expect(calls[0]!.endpoint.href).toBe(APNS_DEVELOPMENT_ENDPOINT.href)
    expect(calls[1]!.endpoint.href).toBe(APNS_PRODUCTION_ENDPOINT.href)
    expect(calls[0]!.headers[':path']).toBe(`/3/device/${'ab'.repeat(16)}`)
    expect(calls[0]!.headers['apns-topic']).toBe(config.topic)
    expect(calls[0]!.headers['apns-push-type']).toBe('alert')
    expect(calls[0]!.headers.authorization).toMatch(/^bearer /)
    expect(JSON.parse(Buffer.from(calls[0]!.body).toString('utf8'))).toEqual({ aps: { alert: '完成' } })
  })

  it('does not contact APNs for malformed or oversized requests and retries transport failures', async () => {
    const { config } = keyFixture()
    let calls = 0
    const provider = new APNsProvider(config, {
      transport: {
        async send() {
          calls += 1
          throw new Error('network unavailable')
        },
      },
    })

    await expect(provider.send({
      deviceToken: 'not-a-token', environment: 'production', payload: { aps: {} },
    })).resolves.toMatchObject({ disposition: 'unregister', reason: 'BadDeviceToken' })
    await expect(provider.send({
      deviceToken: 'ef'.repeat(16), environment: 'production', payload: { value: 'x'.repeat(5_000) },
    })).resolves.toMatchObject({ disposition: 'failed', reason: 'PayloadTooLarge' })
    await expect(provider.send({
      deviceToken: 'ef'.repeat(16), environment: 'production', payload: { aps: {} },
    })).resolves.toMatchObject({ disposition: 'retry', reason: 'network unavailable' })
    expect(calls).toBe(1)
  })
})

describe('Node HTTP/2 APNs transport', () => {
  it('times out a half-open stream instead of blocking the outbox forever', async () => {
    const server = createServer()
    server.on('stream', () => {
      // Intentionally leave the stream open without response headers.
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    const transport = new NodeHttp2APNsTransport(25)
    try {
      await expect(transport.send(
        new URL(`http://127.0.0.1:${port}`),
        { ':method': 'POST', ':path': '/3/device/token' },
        Buffer.from('{}'),
      )).rejects.toThrow(/timed out/)
    } finally {
      transport.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

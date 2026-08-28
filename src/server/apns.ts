import {
  connect,
  constants as http2Constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2'
import {
  createPrivateKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { APNsProviderConfig } from './config.js'

export type APNsEnvironment = 'development' | 'production'

export interface APNsRequest {
  deviceToken: string
  environment: APNsEnvironment
  payload: Record<string, unknown>
  apnsId?: string
  collapseId?: string
  expiration?: number
  priority?: 5 | 10
  pushType?: 'alert' | 'background'
}

export interface APNsTransportResponse {
  status: number
  headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined>
  body?: string
}

export interface APNsTransport {
  send(endpoint: URL, headers: OutgoingHttpHeaders, body: Uint8Array): Promise<APNsTransportResponse>
  close?(): void
}

export type APNsDisposition = 'success' | 'retry' | 'unregister' | 'configuration' | 'failed'

export interface APNsSendResult {
  disposition: APNsDisposition
  status: number
  reason?: string
  apnsId?: string
  timestamp?: number
  retryAfterMs?: number
}

export interface APNsProviderOptions {
  transport?: APNsTransport
  now?: () => number
}

export const APNS_DEVELOPMENT_ENDPOINT = new URL('https://api.sandbox.push.apple.com')
export const APNS_PRODUCTION_ENDPOINT = new URL('https://api.push.apple.com')
export const APNS_MAX_PAYLOAD_BYTES = 4_096

const TOKEN_RE = /^(?:[a-fA-F0-9]{2}){16,256}$/
const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1_000
const TOKEN_CONFIGURATION_REASONS = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'MissingProviderToken',
  'BadTopic',
  'TopicDisallowed',
])
const UNREGISTER_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
])

function encodedJSON(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function createAPNsProviderToken(
  config: Pick<APNsProviderConfig, 'keyFile' | 'keyId' | 'teamId'>,
  now = Date.now(),
  suppliedKey?: KeyObject,
): string {
  const key = suppliedKey ?? createPrivateKey(readFileSync(config.keyFile))
  const header = encodedJSON({ alg: 'ES256', kid: config.keyId })
  const claims = encodedJSON({ iss: config.teamId, iat: Math.floor(now / 1_000) })
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${signingInput}.${signature}`
}

function firstHeader(
  headers: APNsTransportResponse['headers'],
  name: string,
): string | undefined {
  const value = headers?.[name]
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

function responseReason(body: string | undefined): { reason?: string; timestamp?: number } {
  if (!body) return {}
  try {
    const value = JSON.parse(body) as { reason?: unknown; timestamp?: unknown }
    return {
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(typeof value.timestamp === 'number' ? { timestamp: value.timestamp } : {}),
    }
  } catch {
    return { reason: body.slice(0, 200) }
  }
}

function retryAfterMilliseconds(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

export function classifyAPNsResponse(
  response: APNsTransportResponse,
  now = Date.now(),
): APNsSendResult {
  const { reason, timestamp } = responseReason(response.body)
  const apnsId = firstHeader(response.headers, 'apns-id')
  const common = {
    status: response.status,
    ...(reason ? { reason } : {}),
    ...(apnsId ? { apnsId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  }
  if (response.status === 0) return { disposition: 'retry', ...common }
  if (response.status === 200) return { disposition: 'success', ...common }
  if (response.status === 410 || (reason && UNREGISTER_REASONS.has(reason))) {
    return { disposition: 'unregister', ...common }
  }
  if (response.status === 429 || response.status >= 500) {
    const retryAfterMs = retryAfterMilliseconds(firstHeader(response.headers, 'retry-after'), now)
    return { disposition: 'retry', ...common, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }
  if (response.status === 403 || (reason && TOKEN_CONFIGURATION_REASONS.has(reason))) {
    return { disposition: 'configuration', ...common }
  }
  if (response.status === 400) return { disposition: 'failed', ...common }
  return { disposition: 'failed', ...common }
}

export class NodeHttp2APNsTransport implements APNsTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>()

  constructor(readonly timeoutMilliseconds = 15_000) {}

  private session(endpoint: URL): ClientHttp2Session {
    const origin = endpoint.origin
    const existing = this.sessions.get(origin)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(origin)
    this.sessions.set(origin, session)
    const discard = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin)
    }
    session.once('close', discard)
    session.once('goaway', discard)
    session.on('error', discard)
    return session
  }

  send(endpoint: URL, headers: OutgoingHttpHeaders, body: Uint8Array): Promise<APNsTransportResponse> {
    return new Promise((resolve, reject) => {
      const stream = this.session(endpoint).request(headers)
      let settled = false
      const settle = <T>(finish: (value: T) => void, value: T) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        finish(value)
      }
      const timeout = setTimeout(() => {
        stream.close(http2Constants.NGHTTP2_CANCEL)
        settle(reject, new Error('APNs request timed out'))
      }, this.timeoutMilliseconds)
      timeout.unref()
      let responseHeaders: IncomingHttpHeaders | undefined
      const chunks: Buffer[] = []
      let size = 0
      stream.once('response', headersValue => { responseHeaders = headersValue })
      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size <= 64 * 1_024) chunks.push(buffer)
      })
      stream.once('end', () => {
        const status = Number(responseHeaders?.[http2Constants.HTTP2_HEADER_STATUS] ?? 0)
        settle(resolve, { status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') })
      })
      stream.once('error', error => settle(reject, error))
      stream.end(body)
    })
  }

  close(): void {
    for (const session of this.sessions.values()) session.destroy()
    this.sessions.clear()
  }
}

export class APNsProvider {
  private readonly transport: APNsTransport
  private readonly now: () => number
  private key?: KeyObject
  private token?: { value: string; createdAt: number }

  constructor(
    readonly config: APNsProviderConfig,
    options: APNsProviderOptions = {},
  ) {
    this.transport = options.transport ?? new NodeHttp2APNsTransport()
    this.now = options.now ?? Date.now
  }

  private authorizationToken(): string {
    const now = this.now()
    if (this.token && now - this.token.createdAt < PROVIDER_TOKEN_LIFETIME_MS) return this.token.value
    this.key ??= createPrivateKey(readFileSync(this.config.keyFile))
    const value = createAPNsProviderToken(this.config, now, this.key)
    this.token = { value, createdAt: now }
    return value
  }

  async send(request: APNsRequest): Promise<APNsSendResult> {
    const environments = this.config.environments ?? ['development', 'production']
    if (!environments.includes(request.environment)) {
      return { disposition: 'configuration', status: 0, reason: 'EnvironmentNotConfigured' }
    }
    if (!TOKEN_RE.test(request.deviceToken)) {
      return { disposition: 'unregister', status: 0, reason: 'BadDeviceToken' }
    }
    const body = Buffer.from(JSON.stringify(request.payload), 'utf8')
    if (body.length > APNS_MAX_PAYLOAD_BYTES) {
      return { disposition: 'failed', status: 0, reason: 'PayloadTooLarge' }
    }
    if (request.collapseId && Buffer.byteLength(request.collapseId, 'utf8') > 64) {
      return { disposition: 'failed', status: 0, reason: 'BadCollapseId' }
    }
    let authorization: string
    try {
      authorization = this.authorizationToken()
    } catch (cause) {
      return {
        disposition: 'configuration',
        status: 0,
        reason: cause instanceof Error ? cause.message : 'Unable to load APNs provider key',
      }
    }
    const endpoint = request.environment === 'development'
      ? APNS_DEVELOPMENT_ENDPOINT
      : APNS_PRODUCTION_ENDPOINT
    const apnsId = request.apnsId ?? randomUUID()
    const headers: OutgoingHttpHeaders = {
      [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${request.deviceToken.toLowerCase()}`,
      authorization: `bearer ${authorization}`,
      'content-type': 'application/json',
      'apns-topic': this.config.topic,
      'apns-push-type': request.pushType ?? 'alert',
      'apns-priority': String(request.priority ?? 10),
      'apns-expiration': String(request.expiration ?? 0),
      'apns-id': apnsId,
      ...(request.collapseId ? { 'apns-collapse-id': request.collapseId } : {}),
    }
    try {
      const result = classifyAPNsResponse(await this.transport.send(endpoint, headers, body), this.now())
      if (result.disposition === 'configuration') this.token = undefined
      return result
    } catch (cause) {
      return {
        disposition: 'retry',
        status: 0,
        reason: cause instanceof Error ? cause.message : 'APNs connection failed',
      }
    }
  }

  close(): void {
    this.transport.close?.()
  }
}

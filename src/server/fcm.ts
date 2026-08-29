import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FCMProviderConfig } from './config.js'
import type { APNsSendResult } from './apns.js'

export const FCM_ENDPOINT_ORIGIN = 'https://fcm.googleapis.com'
export const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
export const FCM_MAX_DATA_BYTES = 4_096

export interface FCMRequest {
  fid: string
  data: Record<string, string>
  collapseId?: string
  ttlSeconds?: number
  priority?: 'high' | 'normal'
  validateOnly?: boolean
}

export interface FCMTransportResponse {
  status: number
  headers?: Headers | Record<string, string | string[] | undefined>
  body?: string
}

export interface FCMTransport {
  request(url: URL, init: RequestInit): Promise<FCMTransportResponse>
}

export type FCMSendResult = APNsSendResult

export class FCMProbeError extends Error {
  constructor(readonly result: FCMSendResult) {
    super(result.reason || `FCM_PROBE_HTTP_${result.status}`)
    this.name = 'FCMProbeError'
  }
}

interface ServiceAccountCredentials {
  clientEmail: string
  privateKey: string
  tokenUri: string
}

export interface FCMProviderOptions {
  transport?: FCMTransport
  now?: () => number
}

const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000
const FCM_QUOTA_RETRY_MILLISECONDS = 60_000
const FCM_TRANSIENT_RETRY_MILLISECONDS = 10_000

function encodedJSON(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function serviceAccount(path: string): ServiceAccountCredentials {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('FCM service account file must contain a JSON object')
  }
  const record = value as Record<string, unknown>
  const clientEmail = clean(record.client_email)
  const privateKey = clean(record.private_key)
  const tokenUri = clean(record.token_uri) || 'https://oauth2.googleapis.com/token'
  if (!clientEmail || !privateKey || !tokenUri) throw new Error('FCM service account credentials are incomplete')
  if (tokenUri !== 'https://oauth2.googleapis.com/token') throw new Error('FCM OAuth token URI is invalid')
  return { clientEmail, privateKey, tokenUri }
}

export function createFCMServiceAccountJWT(
  credentials: ServiceAccountCredentials,
  now = Date.now(),
  suppliedKey?: KeyObject,
): string {
  const issuedAt = Math.floor(now / 1_000)
  const header = encodedJSON({ alg: 'RS256', typ: 'JWT' })
  const claims = encodedJSON({
    iss: credentials.clientEmail,
    scope: FCM_OAUTH_SCOPE,
    aud: credentials.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3_600,
  })
  const signingInput = `${header}.${claims}`
  const key = suppliedKey ?? createPrivateKey(credentials.privateKey)
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), key).toString('base64url')
  return `${signingInput}.${signature}`
}

function firstHeader(headers: FCMTransportResponse['headers'], name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function retryAfterMilliseconds(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

function errorDetails(body: string | undefined): { reason?: string; status?: string } {
  if (!body) return {}
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown; status?: unknown; details?: unknown[] } }
    const error = value.error
    const status = clean(error?.status)
    let reason = ''
    for (const detail of error?.details ?? []) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue
      const code = clean((detail as Record<string, unknown>).errorCode)
      if (code) {
        reason = code
        break
      }
    }
    return {
      ...(reason ? { reason: reason.slice(0, 128) } : {}),
      ...(status ? { status } : {}),
    }
  } catch {
    return { reason: 'FCM_ERROR_RESPONSE_INVALID' }
  }
}

export function classifyFCMResponse(
  response: FCMTransportResponse,
  now = Date.now(),
): FCMSendResult {
  const details = errorDetails(response.body)
  const common = {
    status: response.status,
    ...(details.reason ? { reason: details.reason } : {}),
  }
  if (response.status >= 200 && response.status < 300) return { disposition: 'success', ...common }
  if (details.reason === 'UNREGISTERED' || details.reason === 'INVALID_ARGUMENT') {
    return { disposition: 'unregister', ...common }
  }
  if (response.status === 429 || response.status >= 500
    || details.status === 'RESOURCE_EXHAUSTED' || details.status === 'UNAVAILABLE' || details.status === 'INTERNAL') {
    const quotaLimited = response.status === 429 || details.status === 'RESOURCE_EXHAUSTED'
    const retryAfterMs = retryAfterMilliseconds(firstHeader(response.headers, 'retry-after'), now)
      ?? (quotaLimited ? FCM_QUOTA_RETRY_MILLISECONDS : FCM_TRANSIENT_RETRY_MILLISECONDS)
    return { disposition: 'retry', ...common, retryAfterMs }
  }
  if (response.status === 401 || response.status === 403
    || details.reason === 'SENDER_ID_MISMATCH' || details.reason === 'THIRD_PARTY_AUTH_ERROR') {
    return { disposition: 'configuration', ...common }
  }
  return { disposition: 'failed', ...common }
}

export class FetchFCMTransport implements FCMTransport {
  constructor(
    readonly fetchImpl: typeof fetch = fetch,
    readonly timeoutMilliseconds = 15_000,
  ) {}

  async request(url: URL, init: RequestInit): Promise<FCMTransportResponse> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMilliseconds),
    })
    const body = (await response.text()).slice(0, 64 * 1_024)
    return { status: response.status, headers: response.headers, body }
  }
}

export class FCMProvider {
  private readonly transport: FCMTransport
  private readonly now: () => number
  private readonly credentials: ServiceAccountCredentials
  private readonly privateKey: KeyObject
  private token?: { value: string; expiresAt: number }

  constructor(
    readonly config: FCMProviderConfig,
    options: FCMProviderOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFCMTransport()
    this.now = options.now ?? Date.now
    this.credentials = serviceAccount(config.serviceAccountFile)
    this.privateKey = createPrivateKey(this.credentials.privateKey)
  }

  async probe(): Promise<void> {
    const result = await this.send({
      fid: 'probe-target-is-intentionally-invalid',
      data: { probe: '1' },
      priority: 'normal',
      validateOnly: true,
    })
    // validate_only may either accept a syntactically valid probe target or
    // reject the intentionally nonexistent FID after credentials are checked.
    if (result.disposition === 'success' || result.disposition === 'unregister') return
    throw new FCMProbeError(result)
  }

  async send(request: FCMRequest): Promise<FCMSendResult> {
    for (const [key, value] of Object.entries(request.data)) {
      const normalizedKey = key.toLowerCase()
      if (typeof value !== 'string') {
        return { disposition: 'failed', status: 400, reason: 'DataValueMustBeString' }
      }
      if (normalizedKey === 'from' || normalizedKey === 'message_type'
        || normalizedKey.startsWith('google.') || normalizedKey.startsWith('gcm.')) {
        return { disposition: 'failed', status: 400, reason: 'ReservedDataKey' }
      }
    }
    if (Buffer.byteLength(JSON.stringify(request.data), 'utf8') > FCM_MAX_DATA_BYTES) {
      return { disposition: 'failed', status: 400, reason: 'PayloadTooLarge' }
    }
    const authorization = await this.authorizationToken()
    if ('result' in authorization) return authorization.result
    const ttlSeconds = Math.max(0, Math.min(2_419_200, Math.trunc(request.ttlSeconds ?? 86_400)))
    const endpoint = new URL(
      `/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,
      FCM_ENDPOINT_ORIGIN,
    )
    const payload = {
      ...(request.validateOnly ? { validate_only: true } : {}),
      message: {
        fid: request.fid,
        data: request.data,
        android: {
          priority: request.priority === 'normal' ? 'NORMAL' : 'HIGH',
          ttl: `${ttlSeconds}s`,
          restricted_package_name: this.config.packageName,
        },
      },
    }
    try {
      const response = await this.transport.request(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authorization.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      })
      const result = classifyFCMResponse(response, this.now())
      if (response.status === 401) this.token = undefined
      return result
    } catch {
      return { disposition: 'retry', status: 0, reason: 'FCM transport unavailable' }
    }
  }

  close(): void {
    this.token = undefined
  }

  private async authorizationToken(): Promise<
    { token: string } | { result: FCMSendResult }
  > {
    const now = this.now()
    if (this.token && now + ACCESS_TOKEN_REFRESH_SKEW_MS < this.token.expiresAt) {
      return { token: this.token.value }
    }
    const assertion = createFCMServiceAccountJWT(this.credentials, now, this.privateKey)
    try {
      const response = await this.transport.request(new URL(this.credentials.tokenUri), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      })
      if (response.status < 200 || response.status >= 300) {
        const result = classifyFCMResponse(response, now)
        return { result: result.disposition === 'failed' ? { ...result, disposition: 'configuration' } : result }
      }
      const value = JSON.parse(response.body || '{}') as Record<string, unknown>
      const token = clean(value.access_token)
      const expiresIn = Number(value.expires_in)
      if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        return { result: { disposition: 'configuration', status: response.status, reason: 'FCM OAuth response is invalid' } }
      }
      this.token = { value: token, expiresAt: now + expiresIn * 1_000 }
      return { token }
    } catch {
      return { result: { disposition: 'retry', status: 0, reason: 'FCM OAuth transport unavailable' } }
    }
  }
}

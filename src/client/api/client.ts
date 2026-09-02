import type { JsonValue } from '@shared/types'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: JsonValue

  constructor(message: string, status = 0, code?: string, details?: JsonValue) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

let csrfToken = ''
const unauthorizedListeners = new Set<() => void>()
const securityChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel !== 'undefined'
  ? new window.BroadcastChannel('hermes-yaoyao-security')
  : undefined
securityChannel?.addEventListener('message', event => {
  if (typeof event.data === 'string') csrfToken = event.data
})

export function setApiCsrfToken(token?: string | null): void {
  csrfToken = token?.trim() ?? ''
  securityChannel?.postMessage(csrfToken)
}

export function clearApiSecurityContext(): void {
  csrfToken = ''
}

export function onApiUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: JsonValue | FormData | Blob
  csrf?: boolean
  timeoutMs?: number
  notifyUnauthorized?: boolean
}

function isBodyInit(value: ApiRequestOptions['body']): value is FormData | Blob {
  return (typeof FormData !== 'undefined' && value instanceof FormData)
    || (typeof Blob !== 'undefined' && value instanceof Blob)
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const nested = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : undefined
    for (const candidate of [record.message, record.error, nested?.message, record.detail]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
    if (Array.isArray(record.detail)) {
      const validation = record.detail.find(item => item && typeof item === 'object') as Record<string, unknown> | undefined
      if (validation && typeof validation.msg === 'string' && validation.msg.trim()) {
        const location = Array.isArray(validation.loc)
          ? validation.loc.filter(item => typeof item === 'string' || typeof item === 'number').join('.')
          : ''
        return location ? `${location}：${validation.msg.trim()}` : validation.msg.trim()
      }
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim()
  return fallback
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/app/') && !path.startsWith('/api/realtime/')) throw new ApiError('客户端仅允许访问应用接口', 0, 'INVALID_PATH')

  const method = (options.method ?? 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrfToken) throw new ApiError('安全令牌尚未就绪，请刷新后重试', 0, 'CSRF_MISSING')
    headers.set('X-CSRF-Token', csrfToken)
  }

  let body: BodyInit | undefined
  if (options.body !== undefined) {
    if (isBodyInit(options.body)) {
      body = options.body
    } else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(options.body)
    }
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const payload = response.status === 204
      ? undefined
      : contentType.includes('application/json')
        ? await response.json().catch(() => undefined)
        : await response.text().catch(() => undefined)
    if (!response.ok) {
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
      const code = typeof record?.code === 'string' ? record.code : undefined
      if (response.status === 401
        && options.notifyUnauthorized !== false) {
        for (const listener of unauthorizedListeners) listener()
      }
      throw new ApiError(
        errorMessage(payload, `请求失败（${response.status}）`),
        response.status,
        code,
        payload as JsonValue,
      )
    }
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) throw new ApiError('请求已取消或超时', 0, 'REQUEST_ABORTED')
    throw new ApiError(error instanceof Error ? error.message : '网络请求失败', 0, 'NETWORK_ERROR')
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function apiUrl(path: string, query: Record<string, string | number | boolean | null | undefined> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}

export function unwrapData<T>(payload: T | { data: T }): T {
  return payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data: T }).data
    : payload as T
}

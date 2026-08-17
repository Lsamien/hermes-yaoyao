import type Koa from 'koa'
import { parse } from 'cookie'
import { HttpError } from './errors.js'
import { appendSetCookies, CSRF_COOKIE } from './security.js'

const RESPONSE_HEADER_ALLOWLIST = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const

function headerSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = headers.get('set-cookie')
  if (!combined) return []
  // This fallback is only for fetch shims without getSetCookie. It avoids
  // splitting the comma in an Expires attribute.
  return combined.split(/,(?=\s*[^;,\s]+=)/g).map((value) => value.trim())
}

function cookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0]?.trim()
  const separator = pair?.indexOf('=') ?? -1
  if (!pair || separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1).trim()
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null
  return [name, cookieValue]
}

function browserCookie(value: string, publicSecure: boolean): string | null {
  const pair = cookiePair(value)
  if (!pair || pair[0] === CSRF_COOKIE) return null
  const attributes = value.split(';').slice(1).map((part) => part.trim())
  const kept = attributes.filter((attribute) => {
    const name = attribute.split('=', 1)[0]?.toLowerCase()
    return name !== 'domain' && name !== 'path' && name !== 'secure'
  })
  return [`${pair[0]}=${pair[1]}`, 'Path=/', ...kept, ...(publicSecure ? ['Secure'] : [])].join('; ')
}

export class CookieJar {
  readonly #values = new Map<string, string>()
  readonly #browserCookies = new Map<string, string>()

  constructor(cookieHeader?: string) {
    for (const [name, value] of Object.entries(parse(cookieHeader ?? ''))) {
      if (name !== CSRF_COOKIE && value !== undefined) this.#values.set(name, value)
    }
  }

  absorb(headers: Headers, publicSecure = false): void {
    for (const raw of headerSetCookies(headers)) {
      const pair = cookiePair(raw)
      const sanitized = browserCookie(raw, publicSecure)
      if (!pair || !sanitized) continue
      const [name, value] = pair
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(raw)) this.#values.delete(name)
      else this.#values.set(name, value)
      this.#browserCookies.set(name, sanitized)
    }
  }

  get header(): string | undefined {
    if (this.#values.size === 0) return undefined
    return [...this.#values.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get browserCookies(): string[] {
    return [...this.#browserCookies.values()]
  }
}

export interface UpstreamResponse {
  status: number
  headers: Headers
  body: Buffer
}

export class UpstreamHttpError extends HttpError {
  constructor(readonly response: UpstreamResponse) {
    super(response.status, `Hermes returned HTTP ${response.status}`, 'upstream_http_error')
  }
}

export interface UpstreamRequestOptions {
  method?: string
  search?: URLSearchParams
  body?: unknown
  rawBody?: BodyInit
  headers?: Record<string, string>
  maxResponseBytes?: number
  clientAddress?: string
}

export class UpstreamClient {
  constructor(
    readonly baseURL: URL,
    readonly fetchImpl: typeof fetch = fetch,
    readonly publicSecure = false,
  ) {}

  async request(
    path: string,
    jar: CookieJar,
    options: UpstreamRequestOptions = {},
  ): Promise<UpstreamResponse> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new HttpError(500, 'Invalid internal upstream path')
    }
    const url = new URL(this.baseURL)
    const prefix = this.baseURL.pathname === '/' ? '' : this.baseURL.pathname.replace(/\/$/, '')
    const expectedPath = `${prefix}${path}`
    url.pathname = expectedPath
    if (url.pathname !== expectedPath) {
      throw new HttpError(500, 'Upstream path normalization escaped its allowlisted route')
    }
    url.search = options.search?.toString() ?? ''
    url.hash = ''

    const headers = new Headers({
      accept: 'application/json',
      origin: this.baseURL.origin,
      'x-forwarded-host': this.baseURL.host,
      'x-forwarded-proto': this.publicSecure ? 'https' : 'http',
      ...options.headers,
    })
    if (options.clientAddress) {
      const clientAddress = options.clientAddress.replace(/^::ffff:/, '')
      if (/^[0-9a-f:.]+$/i.test(clientAddress)) headers.set('x-forwarded-for', clientAddress)
    }
    if (jar.header) headers.set('cookie', jar.header)
    let body: BodyInit | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.body)
    }

    let response: Response
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      response = await Promise.race([
        this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers,
          body,
          redirect: 'manual',
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('request timed out')), 30_000)
          timeout.unref()
        }),
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'connection failed'
      throw new HttpError(502, `Unable to reach Hermes: ${message}`, 'upstream_unavailable')
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    jar.absorb(response.headers, this.publicSecure)
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    const limit = options.maxResponseBytes ?? 64 * 1_024 * 1_024
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel()
      throw new HttpError(502, 'Hermes response exceeded the configured limit', 'upstream_too_large')
    }
    const bodyBuffer = Buffer.from(await response.arrayBuffer())
    if (bodyBuffer.byteLength > limit) {
      throw new HttpError(502, 'Hermes response exceeded the configured limit', 'upstream_too_large')
    }
    return { status: response.status, headers: response.headers, body: bodyBuffer }
  }

  async json<T>(
    path: string,
    jar: CookieJar,
    options: UpstreamRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, jar, options)
    if (response.status < 200 || response.status >= 300) throw new UpstreamHttpError(response)
    try {
      return JSON.parse(response.body.toString('utf8')) as T
    } catch {
      throw new HttpError(502, 'Hermes returned invalid JSON', 'invalid_upstream_json')
    }
  }
}

export function applyUpstreamCookies(ctx: Koa.Context, jar: CookieJar): void {
  appendSetCookies(ctx, jar.browserCookies)
}

export function sendUpstreamResponse(
  ctx: Koa.Context,
  response: UpstreamResponse,
  _jar: CookieJar,
): void {
  ctx.status = response.status
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name)
    if (value) ctx.set(name, value)
  }
  ctx.body = response.status === 204 || ctx.method === 'HEAD' ? null : response.body
}

export function decodeUpstreamError(response: UpstreamResponse): { error: string; code: string } {
  try {
    const value = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>
    const message = typeof value.error === 'string'
      ? value.error
      : typeof value.message === 'string' ? value.message : `Hermes returned HTTP ${response.status}`
    return { error: message, code: 'upstream_rejected' }
  } catch {
    return { error: `Hermes returned HTTP ${response.status}`, code: 'upstream_rejected' }
  }
}

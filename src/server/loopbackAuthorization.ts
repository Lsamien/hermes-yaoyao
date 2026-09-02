import { Agent as HTTPAgent, request as httpRequest } from 'node:http'
import { Agent as HTTPSAgent, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

/** Literal loopback only: never treat forwarded headers, LAN addresses, Docker
 * hostnames or a hostname resolving to localhost as permission to acquire a token. */
export function isLocalAuthorizationTarget(url: URL): boolean {
  return ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    && !url.username && !url.password
}

export function localSessionToken(html: string): string | undefined {
  const value = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html)?.[1]
  if (!value) return undefined
  try {
    const token: unknown = JSON.parse(value)
    return typeof token === 'string' && /^[A-Za-z0-9_-]{20,4096}$/.test(token) ? token : undefined
  } catch { return undefined }
}

export function allowsLocalAuthorization(status: Record<string, unknown>): boolean {
  return (status.auth_required === false || status.authRequired === false)
    && status.auth_required !== true && status.authRequired !== true
}

/** Explicit agents do not inherit proxy environment settings. Loopback tokens
 * must not travel through an HTTP_PROXY configured for unrelated remote traffic. */
export class LoopbackTransport {
  readonly httpAgent = new HTTPAgent({ keepAlive: true, proxyEnv: {} })
  readonly httpsAgent = new HTTPSAgent({ keepAlive: true, proxyEnv: {} })
  agent(url: URL): HTTPAgent | HTTPSAgent { return url.protocol === 'https:' || url.protocol === 'wss:' ? this.httpsAgent : this.httpAgent }

  async fetch(url: URL, init: RequestInit): Promise<Response> {
    if (!isLocalAuthorizationTarget(url)) throw new Error('Loopback transport requires a literal loopback URL')
    const source = new Request(url, init)
    const body = source.body ? Buffer.from(await source.arrayBuffer()) : undefined
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: source.method, headers: Object.fromEntries(source.headers.entries()),
        agent: this.agent(url), signal: source.signal,
      }, response => {
        const headers = new Headers()
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!)
        const empty = source.method === 'HEAD' || [204, 205, 304].includes(response.statusCode ?? 200)
        if (empty) response.resume()
        resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
          status: response.statusCode ?? 502, headers,
        }))
      })
      request.once('error', reject)
      request.end(body)
    })
  }
  close(): void { this.httpAgent.destroy(); this.httpsAgent.destroy() }
}

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import { bodyParser } from '@koa/bodyparser'
import Koa from 'koa'
import type { ServerConfig } from './config.js'
import { loadServerConfig } from './config.js'
import { errorMessage, HttpError } from './errors.js'
import { RealtimeLeaseStore } from './leases.js'
import { createApiRouter } from './routes.js'
import {
  applySecurityHeaders,
  CsrfProtection,
  isAllowedHostHeader,
  isExactOrigin,
} from './security.js'
import { UpstreamHttpError, UpstreamClient } from './upstream.js'
import { UploadStore } from './uploads.js'
import { installWebSocketRelay } from './websocket.js'

export interface ApplicationOptions {
  config?: ServerConfig
  fetchImpl?: typeof fetch
  csrfSecret?: Buffer
  leases?: RealtimeLeaseStore
  uploads?: UploadStore
}

export interface ApplicationRuntime {
  app: Koa
  config: ServerConfig
  csrf: CsrfProtection
  leases: RealtimeLeaseStore
  upstream: UpstreamClient
  uploads: UploadStore
  close(): void
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

function persistentCsrfSecret(home: string, override?: Buffer): Buffer {
  if (override) return override
  const path = join(home, 'csrf-secret.bin')
  try {
    const secret = readFileSync(path)
    if (secret.byteLength === 32) return secret
    throw new Error('CSRF secret has an invalid length')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const generated = randomBytes(32)
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    // Another 8800 process can finish first during launchd hand-off. Never
    // rotate its secret; use the one it safely wrote instead.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path)
    throw error
  }
}

export function createApplication(options: ApplicationOptions = {}): ApplicationRuntime {
  const config = options.config ?? loadServerConfig()
  const app = new Koa()
  app.proxy = false
  const csrf = new CsrfProtection(persistentCsrfSecret(config.home, options.csrfSecret), Boolean(config.tlsCert))
  const leases = options.leases ?? new RealtimeLeaseStore()
  const upstream = new UpstreamClient(config.upstream, options.fetchImpl, Boolean(config.tlsCert))
  const uploads = options.uploads ?? new UploadStore(config.home)
  try {
    uploads.cleanupUncommitted()
  } catch {
    // A locked cleanup should not prevent startup; upload operations will
    // still surface the underlying storage error when used.
  }

  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      if (error instanceof UpstreamHttpError) {
        ctx.status = error.response.status
        ctx.type = 'application/json; charset=utf-8'
        ctx.body = { error: `Hermes returned HTTP ${error.response.status}`, code: error.code }
        return
      }
      const status = error instanceof HttpError
        ? error.status
        : typeof (error as { status?: unknown })?.status === 'number'
          ? Number((error as { status: number }).status)
          : 500
      const expose = status < 500 || error instanceof HttpError
      ctx.status = status
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = {
        error: expose ? errorMessage(error) : 'Internal server error',
        code: error instanceof HttpError ? error.code : 'internal_error',
      }
      if (status >= 500 && !config.production) ctx.app.emit('error', error, ctx)
    }
  })
  app.use(async (ctx, next) => {
    applySecurityHeaders(ctx, Boolean(config.tlsCert), config.allowedHosts)
    if (!isAllowedHostHeader(ctx.get('host'), config)) {
      throw new HttpError(421, 'Request Host is not allowed', 'invalid_host')
    }
    await next()
  })
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/app/') && isMutation(ctx.method)) {
      const secure = ctx.secure || Boolean(config.tlsCert)
      if (!isExactOrigin(ctx.get('origin'), ctx.get('host'), secure, config.allowedHosts)) {
        throw new HttpError(403, 'Request Origin is not allowed', 'invalid_origin')
      }
      if (!csrf.verify(ctx.get('cookie'), ctx.get('x-csrf-token'))) {
        throw new HttpError(403, 'CSRF token is invalid or missing', 'invalid_csrf')
      }
    }
    await next()
  })
  app.use(bodyParser({
    encoding: 'utf-8',
    enableTypes: ['json'],
    jsonLimit: '2mb',
    onError: (_error, ctx) => {
      throw new HttpError(ctx.status === 413 ? 413 : 400, 'Invalid JSON request body', 'invalid_json_body')
    },
  }))

  const router = createApiRouter({ config, csrf, upstream, leases, uploads })
  app.use(router.routes())
  app.use(router.allowedMethods({ throw: false }))
  app.use(async (ctx, next) => {
    if (ctx.path === '/api' || ctx.path.startsWith('/api/') || ctx.path.startsWith('/ws/')) {
      ctx.status = 404
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = { error: 'Route not found', code: 'not_found' }
      return
    }
    await next()
  })

  return {
    app,
    config,
    csrf,
    leases,
    upstream,
    uploads,
    close: () => uploads.close(),
  }
}

export interface NodeServerRuntime {
  server: HttpServer
  close(): Promise<void>
}

export function createNodeServer(runtime: ApplicationRuntime): NodeServerRuntime {
  const { config } = runtime
  const server: HttpServer = config.tlsCert && config.tlsKey
    ? createHttpsServer({
        cert: readFileSync(config.tlsCert),
        key: readFileSync(config.tlsKey),
      }, runtime.app.callback())
    : createHttpServer(runtime.app.callback())
  const removeWebSockets = installWebSocketRelay(server, config, runtime.leases)
  return {
    server,
    close: async () => {
      removeWebSockets()
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => error ? reject(error) : resolve())
      })
      runtime.close()
    },
  }
}

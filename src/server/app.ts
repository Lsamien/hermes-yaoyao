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
import { NodePairingStore } from './pairing.js'
import { LocalAuthStore, UpstreamServiceSession } from './localAuth.js'
import { AccountLoginPairingStore } from './accountPairing.js'
import { UpstreamProfileIdentityService } from './profileIdentities.js'
import { createApiRouter } from './routes.js'
import {
  applySecurityHeaders,
  CsrfProtection,
  isAllowedHostHeader,
  isExactOrigin,
} from './security.js'
import { UpstreamHttpError, UpstreamClient } from './upstream.js'
import { UploadStore } from './uploads.js'
import { SystemUpdateManager } from './updateManager.js'
import { installWebSocketRelay } from './websocket.js'

export interface ApplicationOptions {
  config?: ServerConfig
  fetchImpl?: typeof fetch
  csrfSecret?: Buffer
  leases?: RealtimeLeaseStore
  pairings?: NodePairingStore
  uploads?: UploadStore
  updates?: SystemUpdateManager
  auth?: LocalAuthStore
  upstreamSession?: UpstreamServiceSession
  accountPairings?: AccountLoginPairingStore
  profileIdentities?: UpstreamProfileIdentityService
}

export interface ApplicationRuntime {
  app: Koa
  config: ServerConfig
  csrf: CsrfProtection
  leases: RealtimeLeaseStore
  pairings: NodePairingStore
  upstream: UpstreamClient
  uploads: UploadStore
  updates: SystemUpdateManager
  auth: LocalAuthStore
  upstreamSession: UpstreamServiceSession
  accountPairings: AccountLoginPairingStore
  profileIdentities: UpstreamProfileIdentityService
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
  const pairings = options.pairings ?? new NodePairingStore(config.home)
  const upstream = new UpstreamClient(config.upstream, options.fetchImpl, Boolean(config.tlsCert))
  const uploads = options.uploads ?? new UploadStore(config.home)
  const updates = options.updates ?? new SystemUpdateManager(config)
  const auth = options.auth ?? new LocalAuthStore(config.home, Boolean(config.tlsCert))
  if (config.superviseDashboard && !config.upstreamUsername && !config.upstreamPassword) {
    auth.ensureUpstreamCredentials()
  }
  const configuredUpstreamCredentials = config.upstreamUsername && config.upstreamPassword
    ? { username: config.upstreamUsername, password: config.upstreamPassword }
    : undefined
  const upstreamSession = options.upstreamSession ?? new UpstreamServiceSession(
    upstream,
    () => auth.upstreamCredentials(configuredUpstreamCredentials),
  )
  const accountPairings = options.accountPairings ?? new AccountLoginPairingStore()
  const profileIdentities = options.profileIdentities
    ?? new UpstreamProfileIdentityService(config, upstreamSession)
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
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    jsonLimit: '2mb',
    onError: (_error, ctx) => {
      throw new HttpError(ctx.status === 413 ? 413 : 400, 'Invalid JSON request body', 'invalid_json_body')
    },
  }))
  app.use(async (ctx, next) => {
    ctx.state.localAuth = auth
    ctx.state.upstreamSession = upstreamSession
    const anonymous = ctx.path === '/api/app/bootstrap'
      || ctx.path === '/api/app/login'
      || ctx.path === '/api/status'
      || ctx.path === '/api/auth/providers'
      || ctx.path === '/auth/password-login'
      || ctx.path.startsWith('/api/pair/v1/')
      || ctx.path.startsWith('/api/account-pair/v1/')
      || ctx.path === '/healthz'
      || ctx.path === '/readyz'
    if (ctx.path.startsWith('/api/app/') && !anonymous) {
      const allowPasswordChange = ctx.path === '/api/app/account/credentials'
        || ctx.path === '/api/app/logout'
      ctx.state.localUser = auth.require(ctx, allowPasswordChange)
      const adminOnly = ctx.path.startsWith('/api/app/admin/')
        || ctx.path.startsWith('/api/app/system/')
        || ctx.path.startsWith('/api/app/plugins/')
        || ctx.path.startsWith('/api/app/pairings')
        || ctx.path.startsWith('/api/app/paired-devices')
        || ctx.path.startsWith('/api/app/groups/nodes')
      if (adminOnly) ctx.state.localUser = auth.requireAdmin(ctx)
    }
    const gatewayCompatibility = (ctx.path.startsWith('/api/') && !ctx.path.startsWith('/api/app/')
      && !ctx.path.startsWith('/api/pair/'))
      || ctx.path === '/auth/logout'
    if (gatewayCompatibility && !anonymous) {
      const allowPasswordChange = ctx.path === '/api/auth/me' || ctx.path === '/api/profiles'
        || ctx.path === '/api/account/credentials'
      ctx.state.localUser = auth.require(ctx, allowPasswordChange)
      if (isMutation(ctx.method)) {
        const origin = ctx.get('origin')
        if (origin && !isExactOrigin(origin, ctx.get('host'), ctx.secure || Boolean(config.tlsCert), config.allowedHosts)) {
          throw new HttpError(403, 'Request Origin is not allowed', 'invalid_origin')
        }
      }
    }
    await next()
  })

  const router = createApiRouter({
    config,
    csrf,
    upstream,
    leases,
    pairings,
    uploads,
    updates,
    auth,
    upstreamSession,
    accountPairings,
    profileIdentities,
  })
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
    pairings,
    upstream,
    uploads,
    updates,
    auth,
    upstreamSession,
    accountPairings,
    profileIdentities,
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
  const removeWebSockets = installWebSocketRelay(
    server,
    config,
    runtime.leases,
    runtime.pairings,
  )
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

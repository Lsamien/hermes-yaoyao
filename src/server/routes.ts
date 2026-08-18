import type Koa from 'koa'
import Router from '@koa/router'
import { parse } from 'cookie'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { lookup as mimeLookup } from 'mime-types'
import type { ServerConfig } from './config.js'
import { isLoopbackUpstream } from './config.js'
import { HttpError } from './errors.js'
import { canonicalEpoch, groupCursor, type RealtimeChannel, RealtimeLeaseStore } from './leases.js'
import { acceptedRequestOrigin, accountKeyFromCookieHeader, CsrfProtection, requestAccountKey } from './security.js'
import {
  applyUpstreamCookies,
  CookieJar,
  decodeUpstreamError,
  sendUpstreamResponse,
  type UpstreamResponse,
  UpstreamClient,
} from './upstream.js'
import { receiveGroupUploads, uploadMarkdown, UploadStore } from './uploads.js'

type JsonObject = Record<string, unknown>

export interface RouteDependencies {
  config: ServerConfig
  csrf: CsrfProtection
  upstream: UpstreamClient
  leases: RealtimeLeaseStore
  uploads: UploadStore
}

function body(ctx: Koa.Context): JsonObject {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'A JSON object body is required', 'invalid_json_body')
  }
  return value as JsonObject
}

function parseJson(response: UpstreamResponse): JsonObject {
  try {
    const value = JSON.parse(response.body.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as JsonObject
  } catch {
    throw new HttpError(502, 'Hermes returned invalid JSON', 'invalid_upstream_json')
  }
}

function requireSuccess(response: UpstreamResponse): JsonObject {
  if (response.status < 200 || response.status >= 300) {
    const decoded = decodeUpstreamError(response)
    throw new HttpError(response.status, decoded.error, decoded.code)
  }
  return parseJson(response)
}

function searchFrom(ctx: Koa.Context, allowed: readonly string[]): URLSearchParams {
  const incoming = new URLSearchParams(ctx.querystring)
  const outgoing = new URLSearchParams()
  for (const name of allowed) {
    for (const value of incoming.getAll(name)) outgoing.append(name, value)
  }
  return outgoing
}

function safeIdentifier(value: string, label = 'identifier'): string {
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..'
    || normalized.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(normalized)) {
    throw new HttpError(400, `Invalid ${label}`, 'invalid_identifier')
  }
  return normalized
}

function canonicalUUID(value: string, label: string): string {
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new HttpError(400, `${label} must be a UUID`, 'invalid_identifier')
  }
  return normalized
}

function normalizedProfiles(value: JsonObject): unknown[] {
  const profiles = Array.isArray(value.profiles) ? value.profiles : []
  return profiles.map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const object = entry as JsonObject
      return object.profile && typeof object.profile === 'object' ? object.profile : object
    }
    return entry
  })
}

function profilesWithAgentNames(profiles: unknown[], pluginProfiles: JsonObject | undefined): unknown[] {
  const items = Array.isArray(pluginProfiles?.profiles) ? pluginProfiles.profiles : []
  const names = new Map<string, string>()
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const profile = entry as JsonObject
    const name = typeof profile.name === 'string' ? profile.name : ''
    const agentName = typeof profile.agentName === 'string' ? profile.agentName.trim() : ''
    if (name && agentName) names.set(name, agentName)
  }
  return profiles.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const profile = entry as JsonObject
    const name = typeof profile.name === 'string' ? profile.name : typeof profile.profile === 'string' ? profile.profile : ''
    const agentName = names.get(name)
    return agentName ? { ...profile, agentName } : profile
  })
}

function authRequired(status: JsonObject): boolean {
  return status.auth_required === true || status.authRequired === true
}

function publicStatus(status: JsonObject): JsonObject {
  return {
    state: typeof status.overall === 'string' ? status.overall : 'unknown',
    version: typeof status.version === 'string' ? status.version : undefined,
    gatewayRunning: status.gateway_running === true || status.gatewayRunning === true,
    gatewayState: typeof status.gateway_state === 'string'
      ? status.gateway_state
      : typeof status.gatewayState === 'string' ? status.gatewayState : undefined,
  }
}

async function withJar<T>(ctx: Koa.Context, run: (jar: CookieJar) => Promise<T>): Promise<T> {
  const jar = new CookieJar(ctx.get('cookie'))
  try {
    return await run(jar)
  } finally {
    applyUpstreamCookies(ctx, jar)
  }
}

function json(ctx: Koa.Context, status: number, value: unknown): void {
  ctx.status = status
  ctx.type = 'application/json; charset=utf-8'
  ctx.body = value
}

async function proxy(
  ctx: Koa.Context,
  upstream: UpstreamClient,
  path: string,
  options: {
    search?: URLSearchParams
    method?: string
    requestBody?: unknown
    requestHeaders?: Record<string, string>
    maxResponseBytes?: number
  } = {},
): Promise<void> {
  await withJar(ctx, async (jar) => {
    const response = await upstream.request(path, jar, {
      method: options.method,
      search: options.search,
      body: options.requestBody,
      headers: options.requestHeaders,
      maxResponseBytes: options.maxResponseBytes,
    })
    sendUpstreamResponse(ctx, response, jar)
  })
}

async function proxyOptionalUnread(
  ctx: Koa.Context,
  upstream: UpstreamClient,
  path: string,
  options: {
    search?: URLSearchParams
    method?: string
    requestBody?: unknown
  },
  fallback: unknown,
): Promise<void> {
  await withJar(ctx, async (jar) => {
    const response = await upstream.request(path, jar, {
      method: options.method,
      search: options.search,
      body: options.requestBody,
    })
    if (response.status === 404 || response.status === 405) {
      json(ctx, 200, fallback)
      return
    }
    sendUpstreamResponse(ctx, response, jar)
  })
}

async function bootstrap(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  jar: CookieJar,
  rotateCsrf = false,
): Promise<void> {
  const statusResponse = await dependencies.upstream.request('/api/status', jar)
  if (statusResponse.status < 200 || statusResponse.status >= 300) {
    sendUpstreamResponse(ctx, statusResponse, jar)
    return
  }
  const status = parseJson(statusResponse)
  const required = authRequired(status)
  const identityResponse = await dependencies.upstream.request('/api/auth/me', jar)
  if (required && [401, 403].includes(identityResponse.status)) {
    json(ctx, 200, {
      status: publicStatus(status),
      authRequired: required,
      authenticated: false,
      profiles: [],
      csrfToken: dependencies.csrf.issue(ctx, rotateCsrf),
      insecureLan: dependencies.config.insecureLan,
      groupUploadsEnabled: isLoopbackUpstream(dependencies.config.upstream),
    })
    return
  }
  if (identityResponse.status < 200 || identityResponse.status >= 300) {
    // An auth-disabled local Gateway may not expose an identity route.
    if (required) {
      sendUpstreamResponse(ctx, identityResponse, jar)
      return
    }
  }
  const profilesResponse = await dependencies.upstream.request('/api/profiles', jar)
  if (profilesResponse.status < 200 || profilesResponse.status >= 300) {
    sendUpstreamResponse(ctx, profilesResponse, jar)
    return
  }
  const identity = identityResponse.status >= 200 && identityResponse.status < 300
    ? parseJson(identityResponse)
    : { user_id: 'local', display_name: '本机 Hermes', provider: 'local' }
  const pluginProfilesResponse = await dependencies.upstream.request('/api/plugins/yaoyao/profiles', jar)
  const profiles = profilesWithAgentNames(
    normalizedProfiles(parseJson(profilesResponse)),
    pluginProfilesResponse.status >= 200 && pluginProfilesResponse.status < 300 ? parseJson(pluginProfilesResponse) : undefined,
  )
  json(ctx, 200, {
    status: publicStatus(status),
    authRequired: required,
    authenticated: true,
    user: identity.user && typeof identity.user === 'object' ? identity.user : identity,
    profiles,
    csrfToken: dependencies.csrf.issue(ctx, rotateCsrf),
    insecureLan: dependencies.config.insecureLan,
    groupUploadsEnabled: isLoopbackUpstream(dependencies.config.upstream),
  })
}

async function login(ctx: Koa.Context, dependencies: RouteDependencies, jar: CookieJar): Promise<void> {
  const request = body(ctx)
  const username = typeof request.username === 'string' ? request.username.trim() : ''
  const password = typeof request.password === 'string' ? request.password : ''
  if (!username || !password || username.length > 320 || password.length > 4_096) {
    throw new HttpError(400, 'Username and password are required', 'invalid_credentials')
  }

  const providersResponse = await dependencies.upstream.request('/api/auth/providers', jar)
  const providersBody = requireSuccess(providersResponse)
  const providers = Array.isArray(providersBody.providers) ? providersBody.providers : []
  const passwordProviders = providers.filter((entry): entry is JsonObject =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as JsonObject).supports_password === true),
  )
  const requestedProvider = typeof request.provider === 'string' ? request.provider.trim() : ''
  const provider = requestedProvider
    ? passwordProviders.find((entry) => entry.name === requestedProvider)
    : passwordProviders.find((entry) => String(entry.name).toLowerCase() === 'basic')
      ?? (passwordProviders.length === 1 ? passwordProviders[0] : undefined)
  if (!provider || typeof provider.name !== 'string') {
    throw new HttpError(403, 'Hermes does not offer the requested password provider', 'password_login_unavailable')
  }

  const response = await dependencies.upstream.request('/auth/password-login', jar, {
    method: 'POST',
    body: { provider: provider.name, username, password, next: '' },
    clientAddress: ctx.req.socket.remoteAddress,
  })
  const result = requireSuccess(response)
  if (result.ok !== true) throw new HttpError(401, 'Hermes rejected the login', 'login_failed')
  await bootstrap(ctx, dependencies, jar, true)
}

async function requireGatewayAuthentication(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  jar: CookieJar,
): Promise<void> {
  const status = requireSuccess(await dependencies.upstream.request('/api/status', jar))
  if (!authRequired(status)) return
  const identity = await dependencies.upstream.request('/api/auth/me', jar, {
    clientAddress: ctx.req.socket.remoteAddress,
  })
  if (identity.status === 401 || identity.status === 403) {
    throw new HttpError(401, 'Hermes authentication is required', 'authentication_required')
  }
  requireSuccess(identity)
}

async function issueLease(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  jar: CookieJar,
): Promise<void> {
  const request = body(ctx)
  const channel = request.channel
  if (channel !== 'chat' && channel !== 'groups') {
    throw new HttpError(400, 'channel must be chat or groups', 'invalid_channel')
  }
  const status = requireSuccess(await dependencies.upstream.request('/api/status', jar))
  if (channel === 'groups') {
    const capabilities = requireSuccess(await dependencies.upstream.request(
      '/api/plugins/yaoyao/v1/capabilities',
      jar,
    ))
    const protocolVersion = Number(capabilities.protocolVersion ?? capabilities.protocol_version)
    if (protocolVersion !== 2) {
      throw new HttpError(409, 'Hermes group chat protocol v2 is required', 'unsupported_group_protocol')
    }
  }
  let credential: { name: 'ticket' | 'token'; value: string }
  if (authRequired(status)) {
    const ticketResponse = requireSuccess(await dependencies.upstream.request('/api/auth/ws-ticket', jar, {
      method: 'POST',
    }))
    if (typeof ticketResponse.ticket !== 'string' || !ticketResponse.ticket.trim()) {
      throw new HttpError(502, 'Hermes returned an empty WebSocket ticket', 'invalid_ticket')
    }
    credential = { name: 'ticket', value: ticketResponse.ticket.trim() }
  } else {
    const root = await dependencies.upstream.request('/', jar, { maxResponseBytes: 2 * 1_024 * 1_024 })
    const match = root.body.toString('utf8').match(/window\.__HERMES_SESSION_TOKEN__="([^"]+)"/)
    if (!match?.[1]) throw new HttpError(401, 'Hermes did not provide a local session token', 'missing_session_token')
    credential = { name: 'token', value: match[1] }
  }

  const origin = acceptedRequestOrigin(
    ctx.get('origin'),
    ctx.get('host'),
    ctx.secure || Boolean(dependencies.config.tlsCert),
    dependencies.config.allowedHosts,
  )
  if (!origin) throw new HttpError(400, 'Invalid request host', 'invalid_host')
  const accountKeys = new Set([
    requestAccountKey(ctx.req),
    accountKeyFromCookieHeader(jar.header, ctx.req.socket.remoteAddress),
  ])
  const lease = dependencies.leases.issue({
    channel: channel as RealtimeChannel,
    credential,
    origin,
    accountKeys,
    epoch: channel === 'groups' ? canonicalEpoch(request.epoch) : undefined,
    cursor: channel === 'groups' ? groupCursor(request.cursor) : undefined,
  })
  json(ctx, 201, { lease: lease.id, channel: lease.channel, expiresAt: lease.expiresAt })
}

async function searchSessions(ctx: Koa.Context, dependencies: RouteDependencies): Promise<void> {
  await withJar(ctx, async (jar) => {
    const query = searchFrom(ctx, ['q', 'limit', 'source', 'profile'])
    const text = query.get('q')?.trim()
    if (!text) throw new HttpError(400, 'q is required', 'missing_query')
    const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? '50') || 50))
    query.set('limit', String(limit))
    if (!query.get('source')) query.set('exclude_sources', 'cron,ios_group')
    if (query.get('profile')) {
      const response = await dependencies.upstream.request('/api/sessions/search', jar, { search: query })
      sendUpstreamResponse(ctx, response, jar)
      return
    }

    const profilesResponse = await dependencies.upstream.request('/api/profiles', jar)
    const profileObjects = normalizedProfiles(requireSuccess(profilesResponse))
    const profiles = profileObjects.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const name = (entry as JsonObject).name
      return typeof name === 'string' && name.trim() ? [name.trim()] : []
    })
    const results: JsonObject[] = []
    for (const profile of profiles) {
      const scoped = new URLSearchParams(query)
      scoped.set('profile', profile)
      const response = await dependencies.upstream.request('/api/sessions/search', jar, { search: scoped })
      const value = requireSuccess(response)
      for (const raw of Array.isArray(value.results) ? value.results : []) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          results.push({ profile, ...(raw as JsonObject) })
        }
      }
    }
    results.sort((left, right) => {
      const leftRank = Number(left.rank ?? left.last_active ?? left.started_at ?? 0)
      const rightRank = Number(right.rank ?? right.last_active ?? right.started_at ?? 0)
      return rightRank - leftRank
    })
    json(ctx, 200, { results: results.slice(0, limit) })
  })
}

function groupPath(ctx: Koa.Context, suffix = ''): string {
  const roomID = canonicalUUID(ctx.params.roomID, 'room ID')
  return `/api/plugins/yaoyao/v1/rooms/${roomID}${suffix}`
}

function localMediaPath(root: string, relativePath: string): string {
  let resolvedRoot: string
  let resolvedFile: string
  try {
    resolvedRoot = realpathSync(root)
    resolvedFile = realpathSync(resolve(resolvedRoot, relativePath))
  } catch {
    throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
  }
  if (!resolvedFile.startsWith(`${resolvedRoot}${sep}`) || !statSync(resolvedFile).isFile()) {
    throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
  }
  return resolvedFile
}

function sendLocalMedia(ctx: Koa.Context, path: string): void {
  const size = statSync(path).size
  const type = mimeLookup(path) || 'application/octet-stream'
  const fileName = basename(path)
  const range = ctx.get('range').match(/^bytes=(\d*)-(\d*)$/)
  ctx.set('Accept-Ranges', 'bytes')
  ctx.set('Cache-Control', 'private, no-store')
  ctx.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  ctx.type = type
  if (!range) {
    ctx.length = size
    ctx.body = createReadStream(path)
    return
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
  const end = range[2] ? Number(range[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    ctx.status = 416
    ctx.set('Content-Range', `bytes */${size}`)
    return
  }
  const boundedEnd = Math.min(end, size - 1)
  ctx.status = 206
  ctx.set('Content-Range', `bytes ${start}-${boundedEnd}/${size}`)
  ctx.length = boundedEnd - start + 1
  ctx.body = createReadStream(path, { start, end: boundedEnd })
}

export function createApiRouter(dependencies: RouteDependencies): Router {
  const router = new Router()

  router.get('/healthz', (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    json(ctx, 200, { ok: true })
  })

  // Historical messages can contain Markdown links such as
  // /Users/<owner>/Agents/<path>. Map only the configured media root, never
  // an arbitrary local filesystem path.
  router.get('/Users/:owner/Agents/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地媒体只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地文件不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      sendLocalMedia(ctx, localMediaPath(dependencies.config.mediaRoot, filePath))
    })
  })
  router.get('/readyz', async (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    try {
      const response = await dependencies.upstream.request(
        '/api/status',
        new CookieJar(''),
        { maxResponseBytes: 2 * 1_024 * 1_024 },
      )
      const reachable = response.status >= 200 && response.status < 500
      json(ctx, reachable ? 200 : 503, {
        ok: reachable,
        upstream: reachable ? 'reachable' : 'unavailable',
      })
    } catch {
      json(ctx, 503, { ok: false, upstream: 'unavailable' })
    }
  })

  router.get('/api/app/bootstrap', async (ctx) => {
    await withJar(ctx, (jar) => bootstrap(ctx, dependencies, jar))
  })
  router.post('/api/app/login', async (ctx) => {
    await withJar(ctx, (jar) => login(ctx, dependencies, jar))
  })
  router.post('/api/app/logout', async (ctx) => {
    await withJar(ctx, async (jar) => {
      const response = await dependencies.upstream.request('/auth/logout', jar, { method: 'POST' })
      const nextCsrf = dependencies.csrf.issue(ctx, true)
      if (response.status >= 400 && ![401, 403].includes(response.status)) {
        sendUpstreamResponse(ctx, response, jar)
      } else {
        json(ctx, 200, { ok: true, csrfToken: nextCsrf })
      }
    })
  })
  router.post('/api/app/realtime-leases', async (ctx) => {
    await withJar(ctx, (jar) => issueLease(ctx, dependencies, jar))
  })

  router.get('/api/app/profiles', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/profiles')
  })
  router.get('/api/app/models', async (ctx) => {
    const search = searchFrom(ctx, ['profile'])
    search.set('explicit_only', 'true')
    await proxy(ctx, dependencies.upstream, '/api/model/options', { search })
  })
  router.get('/api/app/sessions/search', async (ctx) => {
    await searchSessions(ctx, dependencies)
  })
  router.get('/api/app/sessions/unread', async (ctx) => {
    const search = searchFrom(ctx, ['profile'])
    await proxyOptionalUnread(
      ctx,
      dependencies.upstream,
      '/api/session-unread',
      { search },
      { profile: search.get('profile') || '', total_unread: 0, sessions: [], supported: false },
    )
  })
  router.patch('/api/app/sessions/unread/:sessionID', async (ctx) => {
    const id = safeIdentifier(ctx.params.sessionID, 'session ID')
    await proxyOptionalUnread(
      ctx,
      dependencies.upstream,
      `/api/session-unread/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        search: searchFrom(ctx, ['profile']),
        requestBody: body(ctx),
      },
      { ok: true, supported: false },
    )
  })
  router.get('/api/app/sessions', async (ctx) => {
    const search = searchFrom(ctx, ['limit', 'offset', 'order', 'archived', 'profile', 'source'])
    search.set('exclude_sources', 'cron,ios_group')
    const path = search.get('profile') ? '/api/sessions' : '/api/profiles/sessions'
    await proxy(ctx, dependencies.upstream, path, { search })
  })
  router.get('/api/app/sessions/:sessionID/messages', async (ctx) => {
    const id = safeIdentifier(ctx.params.sessionID, 'session ID')
    const incoming = searchFrom(ctx, ['offset', 'limit', 'profile'])
    const offset = Math.max(0, Number(incoming.get('offset') ?? '0') || 0)
    const limit = Math.max(1, Math.min(500, Number(incoming.get('limit') ?? '100') || 100))
    incoming.set('offset', String(offset))
    incoming.set('limit', String(limit))
    incoming.set('order', 'latest')
    incoming.set('include_compacted', 'true')
    await proxy(ctx, dependencies.upstream, `/api/sessions/${encodeURIComponent(id)}/messages`, {
      search: incoming,
    })
  })
  router.get('/api/app/sessions/:sessionID', async (ctx) => {
    const id = safeIdentifier(ctx.params.sessionID, 'session ID')
    await proxy(ctx, dependencies.upstream, `/api/sessions/${encodeURIComponent(id)}`, {
      search: searchFrom(ctx, ['profile']),
    })
  })
  router.patch('/api/app/sessions/:sessionID', async (ctx) => {
    const id = safeIdentifier(ctx.params.sessionID, 'session ID')
    const search = searchFrom(ctx, ['profile'])
    const request = body(ctx)
    const profile = search.get('profile')
    if (profile) request.profile = profile
    await proxy(ctx, dependencies.upstream, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      search,
      requestBody: request,
    })
  })
  router.delete('/api/app/sessions/:sessionID', async (ctx) => {
    const id = safeIdentifier(ctx.params.sessionID, 'session ID')
    await proxy(ctx, dependencies.upstream, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      search: searchFrom(ctx, ['profile']),
    })
  })

  router.get('/api/app/groups/capabilities', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/capabilities')
  })
  router.get('/api/app/groups/rooms', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/rooms', {
      search: searchFrom(ctx, ['limit', 'cursor']),
    })
  })
  router.post('/api/app/groups/rooms', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/rooms', {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.get('/api/app/groups/rooms/:roomID', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx))
  })
  for (const method of ['patch', 'delete'] as const) {
    router[method]('/api/app/groups/rooms/:roomID', async (ctx) => {
      await proxy(ctx, dependencies.upstream, groupPath(ctx), {
        method: method.toUpperCase(), requestBody: body(ctx),
      })
    })
  }
  router.post('/api/app/groups/rooms/:roomID/agents', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/agents'), {
      method: 'POST', requestBody: body(ctx),
    })
  })
  for (const method of ['patch', 'delete'] as const) {
    router[method]('/api/app/groups/rooms/:roomID/agents/:agentID', async (ctx) => {
      const agentID = canonicalUUID(ctx.params.agentID, 'agent ID')
      await proxy(ctx, dependencies.upstream, groupPath(ctx, `/agents/${agentID}`), {
        method: method.toUpperCase(), requestBody: body(ctx),
      })
    })
  }
  router.post('/api/app/groups/rooms/:roomID/agents/:agentID/interrupt', async (ctx) => {
    const agentID = canonicalUUID(ctx.params.agentID, 'agent ID')
    await proxy(ctx, dependencies.upstream, groupPath(ctx, `/agents/${agentID}/interrupt`), {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.get('/api/app/groups/rooms/:roomID/messages', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/messages'), {
      search: searchFrom(ctx, ['beforeSeq', 'afterSeq', 'limit']),
    })
  })
  router.post('/api/app/groups/rooms/:roomID/messages', async (ctx) => {
    const request = body(ctx)
    const uploadIds = Array.isArray(request.uploadIds)
      ? request.uploadIds.map((value) => String(value))
      : []
    const upstreamBody = { ...request }
    delete upstreamBody.uploadIds
    if (uploadIds.length) {
      if (!isLoopbackUpstream(dependencies.config.upstream)) {
        throw new HttpError(409, 'Group attachments require a loopback Hermes upstream', 'remote_upload_disabled')
      }
      const accountKey = requestAccountKey(ctx.req)
      const records = dependencies.uploads.records(uploadIds, accountKey)
      const content = typeof upstreamBody.content === 'string' ? upstreamBody.content.trim() : ''
      upstreamBody.content = [content, uploadMarkdown(records)].filter(Boolean).join('\n\n')
      await withJar(ctx, async (jar) => {
        const response = await dependencies.upstream.request(groupPath(ctx, '/messages'), jar, {
          method: 'POST', body: upstreamBody,
        })
        sendUpstreamResponse(ctx, response, jar)
        if (response.status >= 200 && response.status < 300) {
          dependencies.uploads.markReferenced(uploadIds, accountKey)
        }
      })
      return
    }
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/messages'), {
      method: 'POST', requestBody: upstreamBody,
    })
  })
  for (const action of ['approval', 'clarification'] as const) {
    router.post(`/api/app/groups/rooms/:roomID/interactions/:interactionID/${action}`, async (ctx) => {
      const interactionID = safeIdentifier(ctx.params.interactionID, 'interaction ID')
      await proxy(
        ctx,
        dependencies.upstream,
        groupPath(ctx, `/interactions/${encodeURIComponent(interactionID)}/${action}`),
        { method: 'POST', requestBody: body(ctx) },
      )
    })
  }

  router.post('/api/app/group-uploads', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, 'Group attachments require a loopback Hermes upstream', 'remote_upload_disabled')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const accountKey = accountKeyFromCookieHeader(jar.header, ctx.req.socket.remoteAddress)
      const files = await receiveGroupUploads(ctx.req, dependencies.uploads, accountKey)
      json(ctx, 201, { files })
    })
  })

  router.get('/api/app/files', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/files', {
      search: searchFrom(ctx, ['limit', 'cursor', 'search', 'profile', 'kind', 'sender', 'session_id']),
    })
  })
  for (const action of ['download', 'preview'] as const) {
    router.get(`/api/app/files/:fileID/${action}`, async (ctx) => {
      const id = safeIdentifier(ctx.params.fileID, 'file ID')
      await proxy(ctx, dependencies.upstream, `/api/plugins/yaoyao/${encodeURIComponent(id)}/download`, {
        search: searchFrom(ctx, ['profile']),
        requestHeaders: ctx.get('range') ? { range: ctx.get('range') } : undefined,
        maxResponseBytes: 256 * 1_024 * 1_024,
      })
      if (action === 'preview') {
        const type = ctx.response.get('content-type').split(';', 1)[0]?.trim().toLowerCase()
        const activeContent = type === 'text/html'
          || type === 'application/xhtml+xml'
          || type === 'image/svg+xml'
          || Boolean(type?.endsWith('/xml') || type?.endsWith('+xml'))
        if (activeContent) {
          ctx.type = 'application/octet-stream'
          ctx.set('Content-Disposition', `attachment; filename="file-${id}"`)
        } else {
          ctx.remove('Content-Disposition')
        }
      }
    })
  }

  return router
}

export function incomingCookieNames(ctx: Koa.Context): string[] {
  return Object.keys(parse(ctx.get('cookie')))
}

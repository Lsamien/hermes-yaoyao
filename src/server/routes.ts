import type Koa from 'koa'
import Router from '@koa/router'
import { parse } from 'cookie'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { lookup as mimeLookup } from 'mime-types'
import { isSupportedGroupProtocolVersion, SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '../shared/types.js'
import type { ServerConfig } from './config.js'
import { DEFAULT_YAOYAO_PLUGIN_SOURCE, isLoopbackHost, isLoopbackUpstream, isPrivateHost } from './config.js'
import { HttpError } from './errors.js'
import { compareReleaseVersions } from './releases.js'
import {
  bearerToken,
  DEFAULT_NODE_SCOPES,
  NODE_PAIRING_PROTOCOL_VERSION,
  type NodeScope,
  NodePairingStore,
} from './pairing.js'
import { CsrfProtection, requestAccountKey } from './security.js'
import {
  applyUpstreamCookies,
  CookieJar,
  decodeUpstreamError,
  sendUpstreamResponse,
  type UpstreamResponse,
  UpstreamClient,
} from './upstream.js'
import { receiveGroupUploads, uploadMarkdown, UploadStore } from './uploads.js'
import { SystemUpdateManager, type SystemUpdateStatus } from './updateManager.js'
import { LocalAuthStore, type LocalUser, UpstreamServiceSession } from './localAuth.js'
import { AccountLoginPairingStore } from './accountPairing.js'
import { UpstreamProfileIdentityService } from './profileIdentities.js'
import { PushCoordinator } from './pushCoordinator.js'
import {
  APNsConfigurationManager,
  type APNsConfigurationInput,
} from './apnsConfiguration.js'
import {
  FCMConfigurationManager,
  type FCMConfigurationInput,
} from './fcmConfiguration.js'
import {
  AllowedHostsConfigurationManager,
  canonicalAllowedHosts,
  normalizeAllowedHost,
} from './allowedHostsConfiguration.js'

type JsonObject = Record<string, unknown>

export interface RouteDependencies {
  config: ServerConfig
  csrf: CsrfProtection
  upstream: UpstreamClient
  pairings: NodePairingStore
  uploads: UploadStore
  updates: SystemUpdateManager
  auth: LocalAuthStore
  upstreamSession: UpstreamServiceSession
  accountPairings: AccountLoginPairingStore
  profileIdentities: UpstreamProfileIdentityService
  push: PushCoordinator
  apnsConfiguration: APNsConfigurationManager
  fcmConfiguration: FCMConfigurationManager
  allowedHostsConfiguration: AllowedHostsConfigurationManager
}

function body(ctx: Koa.Context): JsonObject {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'A JSON object body is required', 'invalid_json_body')
  }
  return value as JsonObject
}

function optionalBody(ctx: Koa.Context): JsonObject | undefined {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

async function boundedRawBody(ctx: Koa.Context, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of ctx.req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    size += chunk.byteLength
    if (size > maximum) {
      throw new HttpError(413, 'Paired node attachment is too large', 'node_attachment_too_large')
    }
    chunks.push(chunk)
  }
  if (size === 0) throw new HttpError(400, 'Paired node attachment is empty', 'invalid_node_attachment')
  return Buffer.concat(chunks, size)
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

function parseJsonValue(response: UpstreamResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown
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

function profilesWithHermesBotNames(profiles: unknown[], pluginProfiles: JsonObject | undefined): unknown[] {
  const items = Array.isArray(pluginProfiles?.profiles) ? pluginProfiles.profiles : []
  const identities = new Map<string, string>()
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const profile = entry as JsonObject
    const name = typeof profile.name === 'string' ? profile.name : ''
    const botName = typeof profile.botName === 'string' ? profile.botName.trim() : ''
    if (name && botName) identities.set(name, botName)
  }
  return profiles.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const profile = entry as JsonObject
    const name = typeof profile.name === 'string' ? profile.name : typeof profile.profile === 'string' ? profile.profile : ''
    const agentName = identities.get(name)
    return agentName ? {
      ...profile,
      agentName,
      description: agentName,
      display_name: agentName,
    } : profile
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

async function yaoyaoPluginVersion(
  dependencies: RouteDependencies,
  jar: CookieJar,
): Promise<string | undefined> {
  const response = await dependencies.upstream.request('/api/dashboard/plugins', jar)
  if (response.status < 200 || response.status >= 300) return undefined
  const manifests = parseJsonValue(response)
  if (!Array.isArray(manifests)) return undefined
  const manifest = manifests.find(entry => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as JsonObject).name === 'yaoyao'
  )) as JsonObject | undefined
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

async function requireYaoyaoStorageReady(
  dependencies: RouteDependencies,
  jar: CookieJar,
  installedVersion?: string,
): Promise<void> {
  if (!installedVersion) return
  const response = await dependencies.upstream.request(
    '/api/plugins/yaoyao/maintenance/storage',
    jar,
  )
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(
      409,
      '当前夭夭插件尚未具备安全升级能力，请先按文档完成一次兼容版本安装',
      'yaoyao_storage_migration_required',
    )
  }
  const storage = parseJson(response)
  if (storage.ready !== true) {
    throw new HttpError(
      409,
      '检测到旧数据目录冲突，已停止升级以避免覆盖夭夭数据',
      'yaoyao_storage_conflict',
    )
  }
}

let yaoyaoReconcileInFlight: Promise<JsonObject> | undefined

function pluginVersionAtLeast(installed: string | undefined, expected: string): boolean {
  if (!installed) return false
  try {
    return compareReleaseVersions(installed, expected) >= 0
  } catch {
    return installed === expected
  }
}

async function reconcileYaoyaoPlugin(
  dependencies: RouteDependencies,
  jar: CookieJar,
  clientAddress: string | undefined,
  expectedVersion: string,
): Promise<JsonObject> {
  if (yaoyaoReconcileInFlight) return yaoyaoReconcileInFlight
  const task = (async () => {
    const installedVersion = await yaoyaoPluginVersion(dependencies, jar)
    if (pluginVersionAtLeast(installedVersion, expectedVersion)) {
      return {
        ok: true,
        updated: false,
        installedPluginVersion: installedVersion,
        expectedPluginVersion: expectedVersion,
      }
    }

    await requireYaoyaoStorageReady(dependencies, jar, installedVersion)
    const pluginSource = dependencies.config.yaoyaoPluginSource
      ?? DEFAULT_YAOYAO_PLUGIN_SOURCE
    const installedResult = requireSuccess(await dependencies.upstream.request(
      '/api/dashboard/agent-plugins/install',
      jar,
      {
        method: 'POST',
        body: {
          identifier: pluginSource,
          force: Boolean(installedVersion),
          enable: true,
        },
        clientAddress,
      },
    ))

    let actualVersion: string | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      actualVersion = await yaoyaoPluginVersion(dependencies, jar)
      if (pluginVersionAtLeast(actualVersion, expectedVersion)) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    if (!pluginVersionAtLeast(actualVersion, expectedVersion)) {
      throw new HttpError(
        502,
        `9119 插件更新后版本仍不匹配：期望 ${expectedVersion}，实际 ${actualVersion || '未安装'}`,
        'yaoyao_plugin_version_mismatch',
      )
    }
    return {
      ...installedResult,
      source: pluginSource,
      updated: true,
      installedPluginVersion: actualVersion,
      expectedPluginVersion: expectedVersion,
      restarted: false,
      restartRequired: false,
    }
  })()
  yaoyaoReconcileInFlight = task
  try {
    return await task
  } finally {
    if (yaoyaoReconcileInFlight === task) yaoyaoReconcileInFlight = undefined
  }
}

export function systemUpdateRequestAllowed(address: string, allowRemoteUpdate = false): boolean {
  if (allowRemoteUpdate) return true
  return isLoopbackHost(address.replace(/^::ffff:/, ''))
}

function localSystemUpdateAllowed(ctx: Koa.Context, dependencies: RouteDependencies): boolean {
  const address = (ctx.req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  return systemUpdateRequestAllowed(address, dependencies.config.allowRemoteUpdate)
}

function systemUpdateStatusForRequest(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  status: SystemUpdateStatus,
): SystemUpdateStatus {
  if (!status.supported || localSystemUpdateAllowed(ctx, dependencies)) return status
  return {
    ...status,
    supported: false,
    unsupportedReason: '系统升级默认只允许在本机执行；可通过服务配置显式允许远程升级',
  }
}

function requireLocalSystemUpdate(ctx: Koa.Context, dependencies: RouteDependencies): void {
  if (!localSystemUpdateAllowed(ctx, dependencies)) {
    throw new HttpError(
      403,
      '系统升级默认只允许在本机执行',
      'remote_system_update_disabled',
    )
  }
}

function updateFailure(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error)
  if (/最新版本|目标版本|正在执行|可回滚|不支持/.test(message)) {
    return new HttpError(409, message, 'system_update_conflict')
  }
  return new HttpError(502, `无法访问系统发布源：${message}`, 'system_update_source_failed')
}

async function withJar<T>(ctx: Koa.Context, run: (jar: CookieJar) => Promise<T>): Promise<T> {
  const service = ctx.state.upstreamSession as UpstreamServiceSession | undefined
  if (service) {
    await service.ensure()
    return run(service.jar)
  }
  const jar = new CookieJar(ctx.get('cookie'))
  try { return await run(jar) } finally { applyUpstreamCookies(ctx, jar) }
}

function json(ctx: Koa.Context, status: number, value: unknown): void {
  ctx.status = status
  ctx.type = 'application/json; charset=utf-8'
  ctx.body = value
}

function pushSystemStatus(dependencies: RouteDependencies): Record<string, unknown> {
  const runtime = dependencies.push.status()
  const settings = dependencies.apnsConfiguration.snapshot()
  const input = settings.input
  const apns = {
    ...runtime,
    source: settings.source,
    editable: settings.editable,
    keyFile: input?.keyFile,
    keyId: input?.keyId,
    teamId: input?.teamId,
    topic: input?.topic ?? runtime.topic,
    environments: input?.environments ?? runtime.environments,
    warnings: settings.warnings,
    ...(settings.configurationError ? { configurationError: settings.configurationError } : {}),
  }
  const fcmRuntime = dependencies.push.fcmStatus()
  const fcmSettings = dependencies.fcmConfiguration.snapshot()
  const fcmInput = fcmSettings.input
  const fcm = {
    ...fcmRuntime,
    source: fcmSettings.source,
    editable: fcmSettings.editable,
    serviceAccountFile: fcmInput?.serviceAccountFile,
    projectId: fcmInput?.projectId ?? fcmRuntime.projectId,
    packageName: fcmInput?.packageName ?? fcmRuntime.packageName,
    warnings: fcmSettings.warnings,
    ...(fcmSettings.configurationError ? { configurationError: fcmSettings.configurationError } : {}),
  }
  return { ...apns, providers: { apns, fcm } }
}

function pushRequest<T>(operation: () => T): T {
  try {
    return operation()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '推送请求无效'
    throw new HttpError(400, message, 'invalid_push_request')
  }
}

function bestEffortAutoSubscribe(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  userID: string,
  roomID: string,
  baselineMessageSeq?: number,
): void {
  try {
    dependencies.push.setGroupSubscription(userID, roomID, true, baselineMessageSeq)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    ctx.app.emit('error', new Error(`团队消息已发送，但自动订阅推送失败：${detail}`), ctx)
  }
}

function bestEffortRemoveUserPush(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  userID: string,
): void {
  try {
    dependencies.push.removeUser(userID)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    ctx.app.emit('error', new Error(`用户权限已更新，但推送状态清理失败：${detail}`), ctx)
  }
}

function groupMessageSequence(response: UpstreamResponse): number | undefined {
  try {
    const payload = parseJson(response)
    const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data as JsonObject : {}
    const message = payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
      ? payload.message as JsonObject
      : data.message && typeof data.message === 'object' && !Array.isArray(data.message)
        ? data.message as JsonObject : {}
    const value = Number(message.seq ?? message.sequence)
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

async function latestGroupMessageSequence(
  dependencies: RouteDependencies,
  roomID: string,
): Promise<number> {
  const response = await dependencies.upstreamSession.request(
    `/api/plugins/yaoyao/v1/rooms/${encodeURIComponent(roomID)}/messages`,
    { search: new URLSearchParams({ limit: '1' }) },
  )
  if (response.status === 404) throw new HttpError(404, '团队不存在', 'group_not_found')
  const payload = requireSuccess(response)
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as JsonObject : {}
  const rows = Array.isArray(payload.items) ? payload.items
    : Array.isArray(payload.messages) ? payload.messages
      : Array.isArray(data.items) ? data.items
        : Array.isArray(data.messages) ? data.messages : []
  const latest = rows.reduce((maximum, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return maximum
    const value = Number((raw as JsonObject).seq ?? (raw as JsonObject).sequence)
    return Number.isSafeInteger(value) && value >= 0 ? Math.max(maximum, value) : maximum
  }, 0)
  return latest
}

function requestOrigin(ctx: Koa.Context, config: ServerConfig): string {
  const secure = ctx.secure || Boolean(config.tlsCert)
  return `${secure ? 'https' : 'http'}://${ctx.host}`
}

function pairingScopes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === 'string')) {
    throw new HttpError(400, 'scopes must be a string array', 'invalid_scope')
  }
  return value
}

async function addPairedChildNode(
  qrPayload: string,
  nameValue: string | undefined,
  dependencies: RouteDependencies,
): Promise<JsonObject> {
  let deepLink: URL
  try { deepLink = new URL(qrPayload.trim()) } catch {
    throw new HttpError(400, '配对码格式无效', 'invalid_pairing_code')
  }
  if (deepLink.protocol !== 'yaoyao:' || deepLink.hostname !== 'pair' || deepLink.searchParams.get('v') !== '1') {
    throw new HttpError(400, '这不是 8800 节点配对码', 'invalid_pairing_code')
  }
  const serviceValue = deepLink.searchParams.get('url') ?? ''
  let serviceURL: URL
  try { serviceURL = new URL(serviceValue) } catch {
    throw new HttpError(400, '配对码缺少有效的 8800 地址', 'invalid_pairing_code')
  }
  if (!['http:', 'https:'].includes(serviceURL.protocol)
    || serviceURL.username || serviceURL.password || serviceURL.search || serviceURL.hash
    || (serviceURL.protocol === 'http:' && !isPrivateHost(serviceURL.hostname))) {
    throw new HttpError(400, '子节点必须使用可信局域网 HTTP 或 HTTPS', 'invalid_node_url')
  }
  const requestJSON = async (url: URL, init?: RequestInit): Promise<JsonObject> => {
    let response: Response
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      response = await Promise.race([
        fetch(url, { ...init, redirect: 'error' }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('request timed out')), 20_000)
          timeout.unref()
        }),
      ])
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'connection failed'
      throw new HttpError(502, `无法连接子 8800 节点：${reason}`, 'child_node_unavailable')
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    let value: unknown
    try { value = await response.json() } catch { value = undefined }
    if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(response.status || 502, '子节点拒绝了配对请求', 'child_node_rejected')
    }
    return value as JsonObject
  }
  const capabilities = await requestJSON(new URL('/api/pair/v1/capabilities', serviceURL))
  if (capabilities.serviceType !== 'yaoyao-web') {
    throw new HttpError(409, '子节点必须是 8800 夭夭 Web 服务', 'child_node_must_be_8800')
  }
  const pairingId = deepLink.searchParams.get('id') ?? ''
  const secret = deepLink.searchParams.get('secret') ?? ''
  const expectedNode = deepLink.searchParams.get('node') ?? ''
  const expectedFingerprint = deepLink.searchParams.get('fingerprint') ?? ''
  const claimed = await requestJSON(new URL('/api/pair/v1/claim', serviceURL), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ pairingId, secret, deviceName: '夭夭 8800 父节点' }),
  })
  if (claimed.serviceType !== 'yaoyao-web'
    || claimed.nodeId !== expectedNode
    || claimed.fingerprint !== expectedFingerprint
    || typeof claimed.serverUrl !== 'string'
    || typeof claimed.token !== 'string') {
    throw new HttpError(502, '子节点身份与二维码不一致', 'child_node_identity_mismatch')
  }
  const nodeURL = new URL(claimed.serverUrl)
  const profiles = await requestJSON(new URL(`${nodeURL.pathname.replace(/\/$/, '')}/api/profiles`, nodeURL), {
    headers: { accept: 'application/json', authorization: `Bearer ${claimed.token}` },
  })
  let profileIdentities = new Map<string, JsonObject>()
  try {
    const identityPayload = await requestJSON(
      new URL(`${nodeURL.pathname.replace(/\/$/, '')}/api/profile-identities`, nodeURL),
      { headers: { accept: 'application/json', authorization: `Bearer ${claimed.token}` } },
    )
    profileIdentities = new Map(
      (Array.isArray(identityPayload.profiles) ? identityPayload.profiles : [])
        .flatMap(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const identity = value as JsonObject
          return typeof identity.name === 'string' ? [[identity.name, identity] as const] : []
        }),
    )
  } catch {
    // Older 8800 nodes remain pairable; they simply use their REST names.
  }
  const profileItems = normalizedProfiles(profiles).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const value = entry as JsonObject
    const name = typeof value.name === 'string' ? value.name : ''
    if (!name) return []
    const identity = profileIdentities.get(name)
    return [{
      name,
      displayName: typeof identity?.displayName === 'string' ? identity.displayName
        : typeof value.agentName === 'string' ? value.agentName
        : typeof value.display_name === 'string' ? value.display_name : name,
      model: typeof value.model === 'string' ? value.model : '',
      ...(typeof identity?.avatar === 'string' ? { avatar: identity.avatar } : {}),
      ...(typeof identity?.color === 'string' ? { color: identity.color } : {}),
    }]
  })
  const registration = {
    nodeId: claimed.nodeId,
    name: nameValue?.trim() || nodeURL.host,
    serverUrl: claimed.serverUrl,
    fingerprint: claimed.fingerprint,
    accessToken: claimed.token,
    profiles: profileItems,
  }
  const response = await dependencies.upstreamSession.request('/api/plugins/yaoyao/v1/nodes', {
    method: 'POST', body: registration,
  })
  return requireSuccess(response)
}

function pairedProxyScope(path: string, method: string): NodeScope {
  if (path === '/profiles' || path.startsWith('/profiles/')) {
    return path.includes('/sessions') ? 'history.read' : 'agents.read'
  }
  if (path === '/sessions' || path.startsWith('/sessions/')) {
    return ['GET', 'HEAD'].includes(method) ? 'history.read' : 'sessions.execute'
  }
  if (path.startsWith('/plugins/yaoyao/v1/')) {
    return ['GET', 'HEAD'].includes(method) ? 'groups.read' : 'groups.execute'
  }
  return 'sessions.execute'
}

function pairedProxyPath(rawPath: string): string {
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (path.includes('\\') || path.includes('\u0000') || path.length > 2_048) {
    throw new HttpError(400, 'Paired node path is invalid', 'invalid_node_path')
  }
  const allowed = path === '/status'
    || path === '/auth/me'
    || path === '/profiles'
    || path.startsWith('/profiles/')
    || path === '/sessions'
    || path.startsWith('/sessions/')
    || path.startsWith('/model/')
    || path.startsWith('/models/')
    || path.startsWith('/files/')
    || path.startsWith('/attachments/')
    || path.startsWith('/plugins/yaoyao/')
  if (!allowed) throw new HttpError(404, 'Paired node route is not available', 'node_route_not_found')
  return `/api${path}`
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

async function proxyAdminFeature(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  path: string,
  options: {
    search?: URLSearchParams
    method?: string
    requestBody?: unknown
  } = {},
): Promise<void> {
  dependencies.auth.requireAdmin(ctx)
  await withJar(ctx, async (jar) => {
    const response = await dependencies.upstream.request(path, jar, {
      method: options.method,
      search: options.search,
      body: options.requestBody,
    })
    if (response.status === 404 || response.status === 405) {
      throw new HttpError(501, '当前上游版本不支持此管理功能', 'upstream_feature_unsupported')
    }
    sendUpstreamResponse(ctx, response, jar)
  })
}

const KANBAN_UPSTREAM_PREFIX = '/api/plugins/kanban'

function sendKanbanUpstreamResponse(
  ctx: Koa.Context,
  response: UpstreamResponse,
  jar: CookieJar,
): void {
  if (response.status === 401) {
    throw new HttpError(502, '9119 Kanban 认证会话不可用', 'upstream_auth_unavailable')
  }
  sendUpstreamResponse(ctx, response, jar)
}

async function kanbanAvailability(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
): Promise<void> {
  dependencies.auth.require(ctx)
  const probe = await dependencies.upstreamSession.request(`${KANBAN_UPSTREAM_PREFIX}/boards`)
  if (probe.status === 404 || probe.status === 405) {
    json(ctx, 200, {
      available: false,
      reason: '9119 未安装、未启用或未挂载 Kanban API',
    })
    return
  }
  if (probe.status < 200 || probe.status >= 300) {
    sendKanbanUpstreamResponse(ctx, probe, dependencies.upstreamSession.jar)
    return
  }
  let version: string | undefined
  try {
    const metadata = await dependencies.upstreamSession.request('/api/dashboard/plugins')
    if (metadata.status >= 200 && metadata.status < 300) {
      const manifests = parseJsonValue(metadata)
      if (Array.isArray(manifests)) {
        const manifest = manifests.find(entry => (
          entry && typeof entry === 'object' && !Array.isArray(entry)
          && (entry as JsonObject).name === 'kanban'
        )) as JsonObject | undefined
        if (typeof manifest?.version === 'string') version = manifest.version
      }
    }
  } catch { /* The mounted API is authoritative; metadata is optional. */ }
  json(ctx, 200, {
    available: true,
    version,
  })
}

async function proxyKanban(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  path: string | (() => string),
  options: {
    allowedQuery?: readonly string[]
    body?: 'required' | 'optional'
    boardRequired?: boolean
    requestBody?: () => JsonObject
    sanitizeTaskDetail?: boolean
  } = {},
): Promise<void> {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') dependencies.auth.require(ctx)
  else dependencies.auth.requireAdmin(ctx)
  const resolvedPath = typeof path === 'function' ? path() : path
  const requestBody = options.requestBody?.() ?? (options.body === 'required' ? body(ctx)
    : options.body === 'optional' ? optionalBody(ctx) : undefined)
  const search = searchFrom(ctx, options.allowedQuery ?? [])
  if (options.boardRequired) {
    const boardValues = search.getAll('board')
    const board = boardValues[0]?.trim() ?? ''
    if (boardValues.length === 0 || !board) {
      throw new HttpError(400, 'Kanban board is required', 'kanban_board_required')
    }
    if (boardValues.length !== 1) {
      throw new HttpError(400, 'Kanban board must be provided exactly once', 'invalid_kanban_board')
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(board)) {
      throw new HttpError(400, 'Kanban board is invalid', 'invalid_kanban_board')
    }
    search.set('board', board)
  }
  const upstreamPath = `${KANBAN_UPSTREAM_PREFIX}${resolvedPath}`
  if (options.sanitizeTaskDetail) {
    await withJar(ctx, async (jar) => {
      const response = await dependencies.upstream.request(upstreamPath, jar, {
        method: ctx.method,
        search,
        body: requestBody,
      })
      if (response.status < 200 || response.status >= 300) {
        sendKanbanUpstreamResponse(ctx, response, jar)
        return
      }
      const payload = parseJson(response)
      if (Object.prototype.hasOwnProperty.call(payload, 'attachments')) payload.attachments = []
      json(ctx, response.status, payload)
    })
    return
  }
  await withJar(ctx, async (jar) => {
    const response = await dependencies.upstream.request(upstreamPath, jar, {
      method: ctx.method,
      search,
      body: requestBody,
    })
    sendKanbanUpstreamResponse(ctx, response, jar)
  })
}

function kanbanBoardCreateBody(ctx: Koa.Context): JsonObject {
  const input = body(ctx)
  const output: JsonObject = {}
  for (const key of ['slug', 'name', 'description']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key]
  }
  output.switch = false
  return output
}

function kanbanCommentBody(ctx: Koa.Context, dependencies: RouteDependencies): JsonObject {
  const input = body(ctx)
  const admin = dependencies.auth.requireAdmin(ctx)
  return {
    body: input.body,
    author: admin.username,
  }
}

function registerKanbanRoutes(router: Router, dependencies: RouteDependencies, prefix: string): void {
  router.get(`${prefix}/status`, async (ctx) => {
    await kanbanAvailability(ctx, dependencies)
  })
  router.get(`${prefix}/boards`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/boards', {
      allowedQuery: ['include_archived'],
    })
  })
  router.post(`${prefix}/boards`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/boards', {
      requestBody: () => kanbanBoardCreateBody(ctx),
    })
  })
  router.get(`${prefix}/board`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/board', {
      allowedQuery: ['board', 'include_archived'],
      boardRequired: true,
    })
  })
  router.get(`${prefix}/profiles`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/profiles')
  })
  router.get(`${prefix}/tasks/:taskID`, async (ctx) => {
    await proxyKanban(ctx, dependencies, () => {
      const id = safeIdentifier(ctx.params.taskID, 'Kanban task ID')
      return `/tasks/${encodeURIComponent(id)}`
    }, {
      allowedQuery: ['board', 'run_state_name', 'run_state_type'],
      boardRequired: true,
      sanitizeTaskDetail: true,
    })
  })
  router.post(`${prefix}/tasks`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/tasks', {
      allowedQuery: ['board'],
      boardRequired: true,
      body: 'required',
    })
  })
  router.patch(`${prefix}/tasks/:taskID`, async (ctx) => {
    await proxyKanban(ctx, dependencies, () => {
      const id = safeIdentifier(ctx.params.taskID, 'Kanban task ID')
      return `/tasks/${encodeURIComponent(id)}`
    }, {
      allowedQuery: ['board'],
      boardRequired: true,
      body: 'required',
    })
  })
  router.delete(`${prefix}/tasks/:taskID`, async (ctx) => {
    await proxyKanban(ctx, dependencies, () => {
      const id = safeIdentifier(ctx.params.taskID, 'Kanban task ID')
      return `/tasks/${encodeURIComponent(id)}`
    }, {
      allowedQuery: ['board'],
      boardRequired: true,
      body: 'optional',
    })
  })
  router.post(`${prefix}/tasks/:taskID/comments`, async (ctx) => {
    await proxyKanban(ctx, dependencies, () => {
      const id = safeIdentifier(ctx.params.taskID, 'Kanban task ID')
      return `/tasks/${encodeURIComponent(id)}/comments`
    }, {
      allowedQuery: ['board'],
      boardRequired: true,
      requestBody: () => kanbanCommentBody(ctx, dependencies),
    })
  })
  router.post(`${prefix}/dispatch`, async (ctx) => {
    await proxyKanban(ctx, dependencies, '/dispatch', {
      allowedQuery: ['board', 'dry_run', 'max'],
      boardRequired: true,
      body: 'optional',
    })
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
  rotateCsrf = false,
): Promise<void> {
  const user = dependencies.auth.current(ctx)
  const csrfToken = dependencies.csrf.issue(ctx, rotateCsrf)
  if (!user) {
    json(ctx, 200, {
      status: { state: 'ready' },
      authRequired: true,
      authenticated: false,
      profiles: [],
      csrfToken,
      insecureLan: dependencies.config.insecureLan,
      groupUploadsEnabled: isLoopbackUpstream(dependencies.config.upstream),
      upstreamReady: false,
      serverKind: 'yaoyao-web',
    })
    return
  }
  let status: JsonObject = { state: user.mustChangePassword ? 'password_change_required' : 'degraded' }
  let profiles: unknown[] = []
  let upstreamReady = false
  let upstreamError: string | undefined
  if (!user.mustChangePassword) {
    try {
      const statusResponse = await dependencies.upstreamSession.request('/api/status')
      const rawStatus = requireSuccess(statusResponse)
      status = publicStatus(rawStatus)
      const profilesResponse = await dependencies.upstreamSession.request('/api/profiles')
      const pluginProfilesResponse = await dependencies.upstreamSession.request('/api/plugins/yaoyao/profiles')
      profiles = profilesWithHermesBotNames(
        normalizedProfiles(requireSuccess(profilesResponse)),
        pluginProfilesResponse.status >= 200 && pluginProfilesResponse.status < 300
          ? parseJson(pluginProfilesResponse) : undefined,
      )
      upstreamReady = true
    } catch (error) {
      upstreamError = error instanceof Error ? error.message : '9119 不可用'
    }
  }
  json(ctx, 200, {
    status,
    authRequired: true,
    authenticated: true,
    user,
    profiles,
    csrfToken,
    insecureLan: dependencies.config.insecureLan,
    groupUploadsEnabled: isLoopbackUpstream(dependencies.config.upstream),
    upstreamReady,
    upstreamError,
    serverKind: 'yaoyao-web',
  })
}

async function login(ctx: Koa.Context, dependencies: RouteDependencies): Promise<void> {
  const request = body(ctx)
  const username = typeof request.username === 'string' ? request.username.trim() : ''
  const password = typeof request.password === 'string' ? request.password : ''
  if (!username || !password || username.length > 320 || password.length > 4_096) {
    throw new HttpError(400, 'Username and password are required', 'invalid_credentials')
  }

  dependencies.auth.login(ctx, username, password)
  await bootstrap(ctx, dependencies, true)
}

async function independentPairingCookies(
  ctx: Koa.Context,
  dependencies: RouteDependencies,
  authenticatedJar: CookieJar,
  request: JsonObject | undefined,
): Promise<string> {
  const status = requireSuccess(
    await dependencies.upstream.request('/api/status', authenticatedJar),
  )
  if (!authRequired(status)) {
    const cookies = authenticatedJar.header
    if (!cookies) throw new HttpError(401, 'Hermes session is unavailable', 'authentication_required')
    return cookies
  }
  const username = typeof request?.username === 'string' ? request.username.trim() : ''
  const password = typeof request?.password === 'string' ? request.password : ''
  if (!username || !password || username.length > 320 || password.length > 4_096) {
    throw new HttpError(
      400,
      'Hermes username and password are required to create an independent paired-device session',
      'pairing_credentials_required',
    )
  }
  const jar = new CookieJar('')
  const providersBody = requireSuccess(
    await dependencies.upstream.request('/api/auth/providers', jar),
  )
  const providers = Array.isArray(providersBody.providers) ? providersBody.providers : []
  const provider = providers.find((entry) => Boolean(
    entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as JsonObject).supports_password === true
      && String((entry as JsonObject).name).toLowerCase() === 'basic',
  )) as JsonObject | undefined
  if (!provider || typeof provider.name !== 'string') {
    throw new HttpError(
      403,
      'Hermes does not offer independent password sessions for QR pairing',
      'pairing_login_unavailable',
    )
  }
  const response = await dependencies.upstream.request('/auth/password-login', jar, {
    method: 'POST',
    body: { provider: provider.name, username, password, next: '' },
    clientAddress: ctx.req.socket.remoteAddress,
  })
  const result = requireSuccess(response)
  if (result.ok !== true) throw new HttpError(401, 'Hermes rejected the pairing login', 'pairing_login_failed')
  await requireGatewayAuthentication(ctx, dependencies, jar)
  if (!jar.header) throw new HttpError(502, 'Hermes did not issue paired-device cookies', 'pairing_session_missing')
  return jar.header
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

function pairedLocalMediaPath(config: ServerConfig, rawPath: string): string {
  if (!rawPath || rawPath.length > 8_192 || rawPath.includes('\u0000')) {
    throw new HttpError(400, '远程文件路径无效', 'invalid_node_file_path')
  }
  let file: string
  try { file = realpathSync(rawPath) } catch {
    throw new HttpError(404, '远程文件不存在', 'node_file_not_found')
  }
  const roots = [config.mediaRoot, config.attachmentsRoot, config.imagesRoot].flatMap(root => {
    try { return [realpathSync(root)] } catch { return [] }
  })
  if (!roots.some(root => file.startsWith(`${root}${sep}`)) || !statSync(file).isFile()) {
    throw new HttpError(403, '远程文件不在允许的目录中', 'node_file_forbidden')
  }
  return file
}

export function createApiRouter(dependencies: RouteDependencies): Router {
  const router = new Router()

  registerKanbanRoutes(router, dependencies, '/api/app/kanban')
  registerKanbanRoutes(router, dependencies, '/api/kanban/v1')

  router.get('/healthz', (ctx) => {
    ctx.set('Cache-Control', 'no-store')
    json(ctx, 200, { ok: true })
  })

  // Hermes Gateway-compatible authentication surface for native clients.
  // Content requests are still executed through the server-owned 9119 session.
  router.get('/api/status', (ctx) => {
    json(ctx, 200, {
      overall: 'ready',
      auth_required: true,
      gateway_running: true,
      server_kind: 'yaoyao-web',
      node_transport: '8800',
    })
  })
  router.get('/api/auth/providers', (ctx) => {
    json(ctx, 200, { providers: [{ name: 'basic', supports_password: true }] })
  })
  router.post('/auth/password-login', async (ctx) => {
    const request = body(ctx)
    const username = typeof request.username === 'string' ? request.username : ''
    const password = typeof request.password === 'string' ? request.password : ''
    const user = dependencies.auth.login(ctx, username, password)
    json(ctx, 200, { ok: true, must_change_password: user.mustChangePassword, server_kind: 'yaoyao-web' })
  })
  router.post('/auth/logout', (ctx) => {
    dependencies.auth.logout(ctx)
    json(ctx, 200, { ok: true })
  })
  router.get('/api/auth/me', (ctx) => {
    const user = dependencies.auth.require(ctx, true)
    json(ctx, 200, {
      user_id: user.id,
      display_name: user.username,
      username: user.username,
      provider: 'yaoyao-local',
      role: user.role,
      must_change_password: user.mustChangePassword,
      server_kind: 'yaoyao-web',
    })
  })
  router.get('/api/profile-identities', async (ctx) => {
    dependencies.auth.require(ctx, true)
    json(ctx, 200, { profiles: await dependencies.profileIdentities.load() })
  })
  router.get('/api/profiles', async (ctx) => {
    dependencies.auth.require(ctx, true)
    const profilesResponse = await dependencies.upstreamSession.request('/api/profiles')
    const pluginProfilesResponse = await dependencies.upstreamSession.request('/api/plugins/yaoyao/profiles')
    json(ctx, profilesResponse.status, {
      profiles: profilesWithHermesBotNames(
        normalizedProfiles(requireSuccess(profilesResponse)),
        pluginProfilesResponse.status >= 200 && pluginProfilesResponse.status < 300
          ? parseJson(pluginProfilesResponse) : undefined,
      ),
    })
  })
  router.get('/api/push/v1/capabilities', (ctx) => {
    dependencies.auth.require(ctx)
    const capabilities = dependencies.push.capabilities()
    json(ctx, 200, {
      ...capabilities,
      maximumSummaryCharacters: capabilities.maxSummaryCharacters,
    })
  })
  router.put('/api/push/v1/installations/:installationID/accounts/:clientAccountID', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    const platform = request.platform === undefined || request.platform === 'ios' ? 'ios'
      : request.platform === 'android' ? 'android' : undefined
    if (!platform) {
      throw new HttpError(400, 'platform must be ios or android', 'invalid_push_request')
    }
    if (platform === 'ios' && request.environment !== 'development' && request.environment !== 'production') {
      throw new HttpError(400, 'environment must be development or production', 'invalid_push_request')
    }
    const common = {
      userId: user.id,
      installationId: canonicalUUID(ctx.params.installationID, 'installation ID'),
      clientAccountId: canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
      appVersion: typeof request.appVersion === 'string' ? request.appVersion : undefined,
      authorizationVersion: dependencies.auth.pushAuthorizationVersion(user.id),
    }
    const installation = platform === 'android'
      ? pushRequest(() => dependencies.push.registerInstallation({
          ...common,
          platform: 'android',
          fid: typeof request.fid === 'string' ? request.fid : '',
        }))
      : pushRequest(() => dependencies.push.registerInstallation({
          ...common,
          platform: 'ios',
          deviceToken: typeof request.token === 'string'
            ? request.token
            : typeof request.deviceToken === 'string' ? request.deviceToken : '',
          environment: request.environment as 'development' | 'production',
        }))
    json(ctx, 200, { installation })
  })
  router.delete('/api/push/v1/installations/:installationID/accounts/:clientAccountID', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const removed = pushRequest(() => dependencies.push.unregisterInstallation(
      user.id,
      canonicalUUID(ctx.params.installationID, 'installation ID'),
      canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
    ))
    json(ctx, 200, { ok: true, removed })
  })
  router.post('/api/push/v1/installations/:installationID/accounts/:clientAccountID/badge-reset', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const badge = pushRequest(() => dependencies.push.resetBadge(
      user.id,
      canonicalUUID(ctx.params.installationID, 'installation ID'),
      canonicalUUID(ctx.params.clientAccountID, 'client account ID'),
    ))
    json(ctx, 200, { badge })
  })
  router.get('/api/push/v1/group-subscriptions', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const subscriptions = dependencies.push.listGroupSubscriptions(user.id)
    json(ctx, 200, {
      subscriptions,
      roomIds: subscriptions.filter(item => item.enabled).map(item => item.roomId),
    })
  })
  router.put('/api/push/v1/group-subscriptions/:roomID', async (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    if (typeof request.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean', 'invalid_push_request')
    }
    const enabled = request.enabled
    const roomID = canonicalUUID(ctx.params.roomID, 'room ID')
    const baseline = enabled ? await latestGroupMessageSequence(dependencies, roomID) : undefined
    const subscription = pushRequest(() => dependencies.push.setGroupSubscription(
      user.id,
      roomID,
      enabled,
      baseline,
    ))
    json(ctx, 200, { subscription, enabled: subscription.enabled })
  })
  // Browser aliases stay inside the /api/app CSRF boundary. Native iOS uses
  // the Gateway-compatible /api/push/v1 surface with the same account state.
  router.get('/api/app/push/v1/capabilities', (ctx) => {
    dependencies.auth.require(ctx)
    const capabilities = dependencies.push.capabilities()
    json(ctx, 200, {
      ...capabilities,
      maximumSummaryCharacters: capabilities.maxSummaryCharacters,
    })
  })
  router.get('/api/app/push/v1/group-subscriptions', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const subscriptions = dependencies.push.listGroupSubscriptions(user.id)
    json(ctx, 200, {
      subscriptions,
      roomIds: subscriptions.filter(item => item.enabled).map(item => item.roomId),
    })
  })
  router.put('/api/app/push/v1/group-subscriptions/:roomID', async (ctx) => {
    const user = dependencies.auth.require(ctx)
    const request = body(ctx)
    if (typeof request.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean', 'invalid_push_request')
    }
    const enabled = request.enabled
    const roomID = canonicalUUID(ctx.params.roomID, 'room ID')
    const baseline = enabled ? await latestGroupMessageSequence(dependencies, roomID) : undefined
    const subscription = pushRequest(() => dependencies.push.setGroupSubscription(
      user.id,
      roomID,
      enabled,
      baseline,
    ))
    json(ctx, 200, { subscription, enabled: subscription.enabled })
  })
  router.put('/api/account/credentials', (ctx) => {
    const request = body(ctx)
    const currentPassword = typeof request.currentPassword === 'string' ? request.currentPassword : ''
    const newPassword = typeof request.newPassword === 'string' ? request.newPassword : ''
    const username = typeof request.username === 'string' ? request.username : undefined
    const user = dependencies.auth.changeCredentials(ctx, currentPassword, newPassword, username)
    json(ctx, 200, { user, must_change_password: false, server_kind: 'yaoyao-web' })
  })
  router.post('/api/app/account-pairings', (ctx) => {
    const user = dependencies.auth.require(ctx)
    const pairing = dependencies.accountPairings.create(user.id)
    const origin = requestOrigin(ctx, dependencies.config)
    const deepLink = new URL('yaoyao://login')
    deepLink.searchParams.set('v', '1')
    deepLink.searchParams.set('url', origin)
    deepLink.searchParams.set('id', pairing.id)
    deepLink.searchParams.set('secret', pairing.secret)
    json(ctx, 201, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      pairingId: pairing.id,
      expiresAt: pairing.expiresAt,
      qrPayload: deepLink.toString(),
    })
  })
  router.get('/api/app/account-pairings/:pairingID', (ctx) => {
    dependencies.auth.require(ctx)
    json(ctx, 200, dependencies.accountPairings.status(ctx.params.pairingID))
  })
  router.get('/api/account-pair/v1/capabilities', (ctx) => {
    json(ctx, 200, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      feature: 'server-login',
    })
  })
  router.post('/api/account-pair/v1/claim', (ctx) => {
    const request = body(ctx)
    const pairingID = typeof request.pairingId === 'string' ? request.pairingId : ''
    const secret = typeof request.secret === 'string' ? request.secret : ''
    const userID = dependencies.accountPairings.claim(pairingID, secret)
    const user = dependencies.auth.issueSession(ctx, userID)
    json(ctx, 201, {
      protocolVersion: 1,
      serviceType: 'yaoyao-web',
      serverUrl: requestOrigin(ctx, dependencies.config),
      user,
    })
  })

  router.post('/api/app/pairings', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const request = optionalBody(ctx)
      const cookieHeader = jar.header
      if (!cookieHeader) throw new HttpError(503, '9119 服务会话尚未就绪', 'upstream_session_missing')
      const pairing = dependencies.pairings.create(
        cookieHeader,
        pairingScopes(request?.scopes),
      )
      const origin = requestOrigin(ctx, dependencies.config)
      const deepLink = new URL('yaoyao://pair')
      deepLink.searchParams.set('v', String(NODE_PAIRING_PROTOCOL_VERSION))
      deepLink.searchParams.set('url', origin)
      deepLink.searchParams.set('node', pairing.nodeID)
      deepLink.searchParams.set('id', pairing.id)
      deepLink.searchParams.set('secret', pairing.secret)
      deepLink.searchParams.set('fingerprint', pairing.fingerprint)
      json(ctx, 201, {
        protocolVersion: NODE_PAIRING_PROTOCOL_VERSION,
        serviceType: 'yaoyao-web',
        pairingId: pairing.id,
        nodeId: pairing.nodeID,
        fingerprint: pairing.fingerprint,
        scopes: pairing.scopes,
        expiresAt: pairing.expiresAt,
        qrPayload: deepLink.toString(),
      })
    })
  })

  router.get('/api/app/pairings/:pairingID', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      json(ctx, 200, dependencies.pairings.status(ctx.params.pairingID))
    })
  })

  router.get('/api/app/paired-devices', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      json(ctx, 200, {
        nodeId: dependencies.pairings.nodeID,
        fingerprint: dependencies.pairings.fingerprint,
        devices: dependencies.pairings.list(),
      })
    })
  })

  router.delete('/api/app/paired-devices/:deviceID', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      try {
        const delegated = new CookieJar(
          dependencies.pairings.delegatedCookies(ctx.params.deviceID),
        )
        await dependencies.upstream.request('/auth/logout', delegated, {
          method: 'POST', clientAddress: ctx.req.socket.remoteAddress,
        })
      } catch {
        // Revocation of the local delegation remains authoritative even when
        // Hermes is temporarily unreachable; its cookie is never returned.
      }
      if (!dependencies.pairings.revoke(ctx.params.deviceID)) {
        throw new HttpError(404, 'Paired device was not found', 'paired_device_not_found')
      }
      json(ctx, 200, { ok: true })
    })
  })

  router.post('/api/pair/v1/claim', (ctx) => {
    const request = body(ctx)
    const pairingID = typeof request.pairingId === 'string' ? request.pairingId : ''
    const secret = typeof request.secret === 'string' ? request.secret : ''
    const deviceName = typeof request.deviceName === 'string' ? request.deviceName : ''
    const claimed = dependencies.pairings.claim({ pairingID, secret, deviceName })
    const origin = requestOrigin(ctx, dependencies.config)
    json(ctx, 201, {
      protocolVersion: NODE_PAIRING_PROTOCOL_VERSION,
      serviceType: 'yaoyao-web',
      nodeId: claimed.nodeID,
      fingerprint: claimed.fingerprint,
      deviceId: claimed.device.id,
      deviceName: claimed.device.name,
      token: claimed.token,
      scopes: claimed.scopes,
      serverUrl: `${origin}/node/${claimed.device.id}`,
    })
  })

  router.get('/api/pair/v1/capabilities', (ctx) => {
    json(ctx, 200, {
      protocolVersion: NODE_PAIRING_PROTOCOL_VERSION,
      serviceType: 'yaoyao-web',
      nodeId: dependencies.pairings.nodeID,
      fingerprint: dependencies.pairings.fingerprint,
      scopes: [...DEFAULT_NODE_SCOPES],
      features: ['bots', 'bot-group', 'native-group-worker', 'history'],
    })
  })

  router.delete('/api/pair/v1/devices/:deviceID', async (ctx) => {
    const token = bearerToken(ctx.get('authorization'))
    const cookies = dependencies.pairings.authorize(ctx.params.deviceID, token)
    try {
      await dependencies.upstream.request('/auth/logout', new CookieJar(cookies), {
        method: 'POST', clientAddress: ctx.req.socket.remoteAddress,
      })
    } catch {
      // The paired bearer is revoked locally even if upstream logout fails.
    }
    if (!dependencies.pairings.revoke(ctx.params.deviceID)) {
      throw new HttpError(404, 'Paired device was not found', 'paired_device_not_found')
    }
    json(ctx, 200, { ok: true })
  })

  router.get('/node/:deviceID/api/node-files', (ctx) => {
    const token = bearerToken(ctx.get('authorization'))
    dependencies.pairings.authorize(
      ctx.params.deviceID,
      token,
      'history.read',
    )
    const value = typeof ctx.query.path === 'string' ? ctx.query.path : ''
    sendLocalMedia(
      ctx,
      pairedLocalMediaPath(dependencies.config, value),
    )
  })
  router.get('/node/:deviceID/api/profile-identities', async (ctx) => {
    const token = bearerToken(ctx.get('authorization'))
    dependencies.pairings.authorize(
      ctx.params.deviceID,
      token,
      'agents.read',
    )
    json(ctx, 200, { profiles: await dependencies.profileIdentities.load() })
  })

  router.all('/node/:deviceID/api/*nodePath', async (ctx) => {
    const rawPath = Array.isArray(ctx.params.nodePath)
      ? ctx.params.nodePath.join('/')
      : ctx.params.nodePath
    const path = pairedProxyPath(rawPath)
    const scope = pairedProxyScope(path.slice('/api'.length), ctx.method)
    const token = bearerToken(ctx.get('authorization'))
    const cookieHeader = dependencies.pairings.authorize(
      ctx.params.deviceID,
      token,
      scope,
    )
    if (ctx.querystring.length > 8_192) {
      throw new HttpError(414, 'Paired node query is too long', 'node_query_too_long')
    }
    const jar = new CookieJar(cookieHeader)
    const isWorkerAttachment = ctx.method === 'POST'
      && /\/plugins\/yaoyao\/v1\/node-worker\/sessions\/[^/]+\/attachments$/.test(path)
      && ctx.get('content-type').split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream'
    let rawBody: BodyInit | undefined
    let requestHeaders: Record<string, string> = {
      'x-yaoyao-node-client': ctx.params.deviceID,
    }
    if (isWorkerAttachment) {
      const encodedName = ctx.get('x-file-name-b64')
      const mimeType = ctx.get('x-mime-type') || 'application/octet-stream'
      if (!/^[A-Za-z0-9_-]{2,512}$/.test(encodedName)
        || !/^[\x20-\x7e]{1,200}$/.test(mimeType)) {
        throw new HttpError(400, 'Paired node attachment headers are invalid', 'invalid_node_attachment')
      }
      const buffer = await boundedRawBody(ctx, 25 * 1_024 * 1_024)
      rawBody = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer
      requestHeaders = {
        ...requestHeaders,
        'content-type': 'application/octet-stream',
        'x-file-name-b64': encodedName,
        'x-mime-type': mimeType,
      }
    }
    const response = await dependencies.upstream.request(path, jar, {
      method: ctx.method,
      search: new URLSearchParams(ctx.querystring),
      body: ['GET', 'HEAD'].includes(ctx.method) || isWorkerAttachment
        ? undefined : optionalBody(ctx),
      rawBody,
      headers: requestHeaders,
      clientAddress: path === '/api/auth/ws-ticket'
        ? undefined : ctx.req.socket.remoteAddress,
    })
    dependencies.pairings.updateCookies(ctx.params.deviceID, jar.header)
    sendUpstreamResponse(ctx, response, jar)
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
  router.get('/Users/:owner/.hermes/attachments/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地附件只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地附件不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      sendLocalMedia(ctx, localMediaPath(dependencies.config.attachmentsRoot, filePath))
    })
  })
  router.get('/Users/:owner/.hermes/images/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地图片只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    if (ctx.params.owner !== dependencies.config.mediaOwner) {
      throw new HttpError(404, '本地图片不存在', 'local_media_not_found')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      sendLocalMedia(ctx, localMediaPath(dependencies.config.imagesRoot, filePath))
    })
  })
  router.get('/attachments/*filePath', async (ctx) => {
    if (!isLoopbackUpstream(dependencies.config.upstream)) {
      throw new HttpError(409, '本地附件只支持回环 Hermes 上游', 'remote_local_media_disabled')
    }
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const filePath = Array.isArray(ctx.params.filePath) ? ctx.params.filePath.join('/') : ctx.params.filePath
      sendLocalMedia(ctx, localMediaPath(dependencies.config.attachmentsRoot, filePath))
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
    await bootstrap(ctx, dependencies)
  })
  router.post('/api/app/login', async (ctx) => {
    await login(ctx, dependencies)
  })
  router.post('/api/app/logout', async (ctx) => {
    dependencies.auth.logout(ctx)
    json(ctx, 200, { ok: true, csrfToken: dependencies.csrf.issue(ctx, true) })
  })
  router.put('/api/app/account/credentials', async (ctx) => {
    const request = body(ctx)
    const currentPassword = typeof request.currentPassword === 'string' ? request.currentPassword : ''
    const newPassword = typeof request.newPassword === 'string' ? request.newPassword : ''
    const username = typeof request.username === 'string' ? request.username : undefined
    const user = dependencies.auth.changeCredentials(ctx, currentPassword, newPassword, username)
    json(ctx, 200, { user, mustChangePassword: false, csrfToken: dependencies.csrf.issue(ctx, true) })
  })
  router.get('/api/app/admin/users', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, { items: dependencies.auth.list(admin) })
  })
  router.post('/api/app/admin/users', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const username = typeof request.username === 'string' ? request.username : ''
    const password = typeof request.password === 'string' ? request.password : ''
    json(ctx, 201, dependencies.auth.create(admin, username, password))
  })
  router.patch('/api/app/admin/users/:userID', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const userID = canonicalUUID(ctx.params.userID, 'user ID')
    const updated = dependencies.auth.updateUser(admin, userID, {
      enabled: typeof request.enabled === 'boolean' ? request.enabled : undefined,
      password: typeof request.password === 'string' ? request.password : undefined,
    })
    if (request.enabled === false || typeof request.password === 'string') {
      bestEffortRemoveUserPush(ctx, dependencies, userID)
    }
    json(ctx, 200, updated)
  })
  router.delete('/api/app/admin/users/:userID', (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const userID = canonicalUUID(ctx.params.userID, 'user ID')
    dependencies.auth.deleteUser(admin, userID)
    bestEffortRemoveUserPush(ctx, dependencies, userID)
    json(ctx, 200, { ok: true })
  })
  router.put('/api/app/admin/upstream-credentials', async (ctx) => {
    const admin = dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const username = typeof request.username === 'string' ? request.username : ''
    const password = typeof request.password === 'string' ? request.password : ''
    await dependencies.upstreamSession.verify({ username, password })
    dependencies.auth.setUpstreamCredentials(admin, { username, password })
    json(ctx, 200, { ok: true })
  })
  router.get('/api/app/admin/model-services', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints', {
      search: searchFrom(ctx, ['profile']),
    })
  })
  router.put('/api/app/admin/profiles/:profileName/model', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const profileName = safeIdentifier(ctx.params.profileName, 'profile name')
    const request = body(ctx)
    const provider = typeof request.provider === 'string' ? request.provider.trim() : ''
    const model = typeof request.model === 'string' ? request.model.trim() : ''
    if (!provider || !model) {
      throw new HttpError(400, 'Provider 和模型不能为空', 'invalid_profile_model')
    }
    await proxyAdminFeature(
      ctx,
      dependencies,
      `/api/profiles/${encodeURIComponent(profileName)}/model`,
      { method: 'PUT', requestBody: { provider, model } },
    )
  })
  router.post('/api/app/admin/model-services', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints', {
      method: 'POST', search: searchFrom(ctx, ['profile']), requestBody: body(ctx),
    })
  })
  router.post('/api/app/admin/model-services/validate', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/providers/custom-endpoints/validate', {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.post('/api/app/admin/model-services/:serviceID/activate', async (ctx) => {
    const id = safeIdentifier(ctx.params.serviceID, 'model service ID')
    await proxyAdminFeature(ctx, dependencies, `/api/providers/custom-endpoints/${encodeURIComponent(id)}/activate`, {
      method: 'POST', search: searchFrom(ctx, ['profile']), requestBody: optionalBody(ctx) ?? {},
    })
  })
  router.delete('/api/app/admin/model-services/:serviceID', async (ctx) => {
    const id = safeIdentifier(ctx.params.serviceID, 'model service ID')
    await proxyAdminFeature(ctx, dependencies, `/api/providers/custom-endpoints/${encodeURIComponent(id)}`, {
      method: 'DELETE', search: searchFrom(ctx, ['profile']),
    })
  })
  router.get('/api/app/admin/legacy-model-services', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    await withJar(ctx, async (jar) => {
      const search = searchFrom(ctx, ['profile'])
      const [configResponse, optionsResponse] = await Promise.all([
        dependencies.upstream.request('/api/config', jar, { search }),
        dependencies.upstream.request('/api/model/options', jar, {
          search: new URLSearchParams([...search, ['explicit_only', 'true']]),
        }),
      ])
      if ([configResponse.status, optionsResponse.status].some(status => status === 404 || status === 405)) {
        throw new HttpError(501, '当前上游版本不支持旧版模型服务管理', 'upstream_feature_unsupported')
      }
      const config = requireSuccess(configResponse)
      const options = requireSuccess(optionsResponse)
      const currentProvider = typeof options.provider === 'string' ? options.provider.toLocaleLowerCase() : ''
      const entries = Array.isArray(config.custom_providers) ? config.custom_providers : []
      const items = entries.flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const entry = raw as JsonObject
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        const baseURL = typeof entry.base_url === 'string' ? entry.base_url.trim() : ''
        const model = typeof entry.model === 'string' ? entry.model.trim() : ''
        if (!name || !baseURL || !model) return []
        const rawModels = entry.models
        const models = Array.isArray(rawModels)
          ? rawModels.map(String).map(value => value.trim()).filter(Boolean)
          : rawModels && typeof rawModels === 'object'
            ? Object.keys(rawModels).filter(value => !value.startsWith('__'))
            : [model]
        const modelConfig = rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)
          ? (rawModels as JsonObject)[model]
          : undefined
        const contextLength = typeof entry.context_length === 'number' ? entry.context_length
          : modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)
            && typeof (modelConfig as JsonObject).context_length === 'number'
            ? (modelConfig as JsonObject).context_length as number
            : undefined
        const id = `custom:${name}`
        return [{
          id, name, base_url: baseURL, model, models: [...new Set([...models, model])],
          ...(contextLength ? { context_length: contextLength } : {}),
          discover_models: entry.models_discovered === true,
          has_api_key: Boolean(entry.key_env || entry.api_key),
          can_edit_api_key: typeof entry.key_env === 'string' && Boolean(entry.key_env.trim()),
          is_current: currentProvider === id.toLocaleLowerCase(),
          source: 'legacy',
        }]
      })
      json(ctx, 200, { items })
    })
  })
  router.put('/api/app/admin/legacy-model-services/:serviceID', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const serviceID = safeIdentifier(ctx.params.serviceID, 'legacy model service ID')
    const request = body(ctx)
    const baseURL = typeof request.base_url === 'string' ? request.base_url.trim().replace(/\/$/, '') : ''
    const model = typeof request.model === 'string' ? request.model.trim() : ''
    const models = Array.isArray(request.models)
      ? [...new Set(request.models.map(String).map(value => value.trim()).filter(Boolean))]
      : []
    if (!/^https?:\/\//i.test(baseURL)) throw new HttpError(400, 'Base URL 必须使用 http 或 https', 'invalid_model_service')
    if (!model) throw new HttpError(400, '默认模型不能为空', 'invalid_model_service')
    if (!models.includes(model)) models.push(model)
    const contextLength = typeof request.context_length === 'number' && Number.isInteger(request.context_length) && request.context_length > 0
      ? request.context_length : undefined
    await withJar(ctx, async (jar) => {
      const search = searchFrom(ctx, ['profile'])
      const [configResponse, optionsResponse] = await Promise.all([
        dependencies.upstream.request('/api/config', jar, { search }),
        dependencies.upstream.request('/api/model/options', jar, {
          search: new URLSearchParams([...search, ['explicit_only', 'true']]),
        }),
      ])
      const config = requireSuccess(configResponse)
      const options = requireSuccess(optionsResponse)
      const providers = Array.isArray(config.custom_providers) ? [...config.custom_providers] : []
      const index = providers.findIndex(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
        const name = typeof (raw as JsonObject).name === 'string' ? String((raw as JsonObject).name) : ''
        return `custom:${name}`.toLocaleLowerCase() === serviceID.toLocaleLowerCase()
      })
      if (index < 0) throw new HttpError(404, '旧版模型服务不存在', 'model_service_not_found')
      const current = providers[index] as JsonObject
      const existingModels = current.models && typeof current.models === 'object' && !Array.isArray(current.models)
        ? current.models as JsonObject : {}
      const nextModels = Object.fromEntries(models.map(id => {
        const previous = existingModels[id]
        const metadata: JsonObject = previous && typeof previous === 'object' && !Array.isArray(previous)
          ? { ...previous as JsonObject } : {}
        if (id === model && contextLength) metadata.context_length = contextLength
        return [id, metadata]
      }))
      providers[index] = {
        ...current,
        base_url: baseURL,
        model,
        models: nextModels,
        models_discovered: request.discover_models === true,
        ...(contextLength ? { context_length: contextLength } : {}),
      }
      requireSuccess(await dependencies.upstream.request('/api/config', jar, {
        method: 'PUT', search, body: { config: { custom_providers: providers }, profile: search.get('profile') || undefined },
      }))
      if (Object.prototype.hasOwnProperty.call(request, 'api_key')) {
        const keyEnvironment = typeof current.key_env === 'string' ? current.key_env.trim() : ''
        if (!keyEnvironment) throw new HttpError(409, '该旧版服务没有可管理的密钥变量', 'model_service_key_unmanaged')
        const apiKey = typeof request.api_key === 'string' ? request.api_key.trim() : ''
        requireSuccess(await dependencies.upstream.request('/api/env', jar, {
          method: apiKey ? 'PUT' : 'DELETE', search,
          body: apiKey ? { key: keyEnvironment, value: apiKey, profile: search.get('profile') || undefined }
            : { key: keyEnvironment, profile: search.get('profile') || undefined },
        }))
      }
      const currentProvider = typeof options.provider === 'string' ? options.provider.toLocaleLowerCase() : ''
      if (currentProvider === serviceID.toLocaleLowerCase()) {
        requireSuccess(await dependencies.upstream.request('/api/model/set', jar, {
          method: 'POST', search,
          body: { scope: 'main', provider: serviceID, model, base_url: baseURL, confirm_expensive_model: true, profile: search.get('profile') || undefined },
        }))
      }
      json(ctx, 200, { ok: true })
    })
  })
  router.get('/api/app/admin/duplex-voice', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/plugins/yaoyao/voice/settings')
  })
  router.put('/api/app/admin/duplex-voice', async (ctx) => {
    await proxyAdminFeature(ctx, dependencies, '/api/plugins/yaoyao/voice/settings', {
      method: 'PUT', requestBody: body(ctx),
    })
  })
  router.get('/api/app/system/update/status', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const installedPluginVersion = await yaoyaoPluginVersion(dependencies, jar)
      json(ctx, 200, systemUpdateStatusForRequest(
        ctx,
        dependencies,
        dependencies.updates.status(installedPluginVersion),
      ))
    })
  })
  router.get('/api/app/system/push-status', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.get('/api/app/system/allowed-hosts', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    json(ctx, 200, dependencies.allowedHostsConfiguration.snapshot())
  })
  router.put('/api/app/system/allowed-hosts', (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    if (!Array.isArray(request.hosts) || request.hosts.some(host => typeof host !== 'string')) {
      throw new HttpError(400, 'hosts 必须是域名或 IP 数组', 'invalid_allowed_hosts')
    }
    const requestedHosts = canonicalAllowedHosts(request.hosts as string[])
    const currentHost = normalizeAllowedHost(ctx.hostname)
    const environmentHosts = dependencies.allowedHostsConfiguration.snapshot().environmentHosts
    if (!isPrivateHost(currentHost) && !new Set([...environmentHosts, ...requestedHosts]).has(currentHost)) {
      throw new HttpError(409, `不能移除当前正在使用的访问地址 ${currentHost}`, 'current_host_required')
    }
    json(ctx, 200, dependencies.allowedHostsConfiguration.update(requestedHosts))
  })
  router.put('/api/app/system/push-config', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const input: Partial<APNsConfigurationInput> = {
      keyFile: typeof request.keyFile === 'string' ? request.keyFile : '',
      keyId: typeof request.keyId === 'string' ? request.keyId : '',
      teamId: typeof request.teamId === 'string' ? request.teamId : '',
      topic: typeof request.topic === 'string' ? request.topic : '',
      environments: Array.isArray(request.environments) ? request.environments as APNsConfigurationInput['environments'] : [],
    }
    await dependencies.apnsConfiguration.update(input, async config => {
      await dependencies.push.configureAPNs(config)
    })
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.put('/api/app/system/push-config/fcm', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const input: Partial<FCMConfigurationInput> = {
      serviceAccountFile: typeof request.serviceAccountFile === 'string' ? request.serviceAccountFile : '',
      projectId: typeof request.projectId === 'string' ? request.projectId : '',
      packageName: typeof request.packageName === 'string' ? request.packageName : '',
    }
    await dependencies.fcmConfiguration.update(input, async config => {
      await dependencies.push.configureFCM(config)
    })
    json(ctx, 200, pushSystemStatus(dependencies))
  })
  router.post('/api/app/system/update/check', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const installedPluginVersion = await yaoyaoPluginVersion(dependencies, jar)
      try {
        json(ctx, 200, systemUpdateStatusForRequest(
          ctx,
          dependencies,
          await dependencies.updates.check(installedPluginVersion),
        ))
      } catch (error) {
        throw updateFailure(error)
      }
    })
  })
  router.post('/api/app/system/update/apply', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      requireLocalSystemUpdate(ctx, dependencies)
      const request = body(ctx)
      const targetVersion = typeof request.targetVersion === 'string' ? request.targetVersion.trim() : ''
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
        throw new HttpError(400, 'targetVersion 必须是有效的发布版本', 'invalid_request')
      }
      const installedPluginVersion = await yaoyaoPluginVersion(dependencies, jar)
      await requireYaoyaoStorageReady(dependencies, jar, installedPluginVersion)
      try {
        const release = await dependencies.updates.check(installedPluginVersion)
        if (!release.latest || release.latest.releaseVersion !== targetVersion) {
          throw new Error('目标版本不是当前发布源的最新版本')
        }
        await reconcileYaoyaoPlugin(
          dependencies,
          jar,
          ctx.req.socket.remoteAddress,
          release.latest.pluginVersion,
        )
        json(ctx, 202, await dependencies.updates.startUpdate(targetVersion, installedPluginVersion))
      } catch (error) {
        throw updateFailure(error)
      }
    })
  })
  router.get('/api/app/system/update/jobs/:jobID', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const job = dependencies.updates.job(ctx.params.jobID)
      if (!job) throw new HttpError(404, '升级任务不存在', 'system_update_job_not_found')
      json(ctx, 200, job)
    })
  })
  router.post('/api/app/system/update/rollback', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      requireLocalSystemUpdate(ctx, dependencies)
      try {
        json(ctx, 202, dependencies.updates.startRollback())
      } catch (error) {
        throw updateFailure(error)
      }
    })
  })
  router.post('/api/app/plugins/yaoyao/reconcile', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      json(ctx, 200, await reconcileYaoyaoPlugin(
        dependencies,
        jar,
        ctx.req.socket.remoteAddress,
        dependencies.updates.currentManifest().pluginVersion,
      ))
    })
  })
  router.post('/api/app/plugins/yaoyao/install', async (ctx) => {
    await withJar(ctx, async (jar) => {
      await requireGatewayAuthentication(ctx, dependencies, jar)
      const pluginSource = dependencies.config.yaoyaoPluginSource
        ?? DEFAULT_YAOYAO_PLUGIN_SOURCE
      const request = body(ctx)
      if (request.force !== undefined && typeof request.force !== 'boolean') {
        throw new HttpError(400, 'force must be a boolean', 'invalid_request')
      }

      const manifestsResponse = await dependencies.upstream.request(
        '/api/dashboard/plugins',
        jar,
      )
      if (manifestsResponse.status < 200 || manifestsResponse.status >= 300) {
        sendUpstreamResponse(ctx, manifestsResponse, jar)
        return
      }
      const manifests = parseJsonValue(manifestsResponse)
      if (!Array.isArray(manifests)) {
        throw new HttpError(502, 'Hermes returned an invalid plugin list', 'invalid_upstream_json')
      }
      const installed = manifests.some((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as JsonObject).name === 'yaoyao'
      ))

      await requireYaoyaoStorageReady(
        dependencies,
        jar,
        installed ? 'installed' : undefined,
      )

      const force = request.force === true
      if (installed && !force) {
        throw new HttpError(
          409,
          '夭夭已经安装；升级时必须明确传入 force=true',
          'yaoyao_force_required',
        )
      }
      const installResponse = await dependencies.upstream.request(
        '/api/dashboard/agent-plugins/install',
        jar,
        {
          method: 'POST',
          body: {
            identifier: pluginSource,
            force,
            enable: true,
          },
          clientAddress: ctx.req.socket.remoteAddress,
        },
      )
      if (installResponse.status < 200 || installResponse.status >= 300) {
        sendUpstreamResponse(ctx, installResponse, jar)
        return
      }
      const installedResult = parseJson(installResponse)
      json(ctx, 200, {
        ...installedResult,
        source: pluginSource,
        restarted: false,
        restartRequired: false,
      })
    })
  })

  router.get('/api/app/profiles', async (ctx) => {
    await withJar(ctx, async (jar) => {
      const profilesResponse = await dependencies.upstream.request('/api/profiles', jar)
      if (profilesResponse.status < 200 || profilesResponse.status >= 300) {
        sendUpstreamResponse(ctx, profilesResponse, jar)
        return
      }
      const pluginProfilesResponse = await dependencies.upstream.request('/api/plugins/yaoyao/profiles', jar)
      const profiles = profilesWithHermesBotNames(
        normalizedProfiles(parseJson(profilesResponse)),
        pluginProfilesResponse.status >= 200 && pluginProfilesResponse.status < 300
          ? parseJson(pluginProfilesResponse)
          : undefined,
      )
      json(ctx, 200, { profiles })
    })
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
  router.get('/api/app/groups/nodes', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/nodes')
  })
  router.post('/api/app/groups/nodes', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/nodes', {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.post('/api/app/groups/nodes/pair', async (ctx) => {
    dependencies.auth.requireAdmin(ctx)
    const request = body(ctx)
    const qrPayload = typeof request.qrPayload === 'string' ? request.qrPayload : ''
    if (!qrPayload || qrPayload.length > 4_096) {
      throw new HttpError(400, '请粘贴有效的 8800 配对码', 'invalid_pairing_code')
    }
    json(ctx, 201, await addPairedChildNode(
      qrPayload,
      typeof request.name === 'string' ? request.name : undefined,
      dependencies,
    ))
  })
  router.post('/api/app/groups/nodes/refresh-identities', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/nodes/refresh-identities', {
      method: 'POST', requestBody: {},
    })
  })
  router.delete('/api/app/groups/nodes/:nodeID', async (ctx) => {
    const nodeID = canonicalUUID(ctx.params.nodeID, 'node ID')
    await proxy(
      ctx,
      dependencies.upstream,
      `/api/plugins/yaoyao/v1/nodes/${nodeID}`,
      { method: 'DELETE', requestBody: body(ctx) },
    )
  })
  router.get('/api/app/groups/rooms', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/rooms', {
      search: searchFrom(ctx, ['limit', 'cursor', 'archived']),
    })
  })
  router.get('/api/app/groups/topics/pinned', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/topics/pinned', {
      search: searchFrom(ctx, ['limit']),
    })
  })
  router.get('/api/app/groups/topics', async (ctx) => {
    await proxy(ctx, dependencies.upstream, '/api/plugins/yaoyao/v1/topics', {
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
  router.post('/api/app/groups/rooms/:roomID/restore', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/restore'), {
      method: 'POST', requestBody: body(ctx),
    })
  })
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
  router.get('/api/app/groups/rooms/:roomID/topics', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/topics'), {
      search: searchFrom(ctx, ['limit', 'cursor', 'archived']),
    })
  })
  router.patch('/api/app/groups/rooms/:roomID/topics/:topicID', async (ctx) => {
    const topicID = canonicalUUID(ctx.params.topicID, 'topic ID')
    await proxy(ctx, dependencies.upstream, groupPath(ctx, `/topics/${topicID}`), {
      method: 'PATCH', requestBody: body(ctx),
    })
  })
  router.delete('/api/app/groups/rooms/:roomID/topics/:topicID', async (ctx) => {
    const topicID = canonicalUUID(ctx.params.topicID, 'topic ID')
    await proxy(ctx, dependencies.upstream, groupPath(ctx, `/topics/${topicID}`), {
      method: 'DELETE', requestBody: body(ctx),
    })
  })
  router.post('/api/app/groups/rooms/:roomID/topics/:topicID/restore', async (ctx) => {
    const topicID = canonicalUUID(ctx.params.topicID, 'topic ID')
    await proxy(ctx, dependencies.upstream, groupPath(ctx, `/topics/${topicID}/restore`), {
      method: 'POST', requestBody: body(ctx),
    })
  })
  router.patch('/api/app/groups/rooms/:roomID/topics/:topicID/read', async (ctx) => {
    const topicID = canonicalUUID(ctx.params.topicID, 'topic ID')
    await proxy(ctx, dependencies.upstream, groupPath(ctx, `/topics/${topicID}/read`), {
      method: 'PATCH', requestBody: body(ctx),
    })
  })
  router.get('/api/app/groups/rooms/:roomID/messages', async (ctx) => {
    await proxy(ctx, dependencies.upstream, groupPath(ctx, '/messages'), {
      search: searchFrom(ctx, ['topicId', 'beforeSeq', 'afterSeq', 'limit']),
    })
  })
  router.post('/api/app/groups/rooms/:roomID/messages', async (ctx) => {
    const localUser = dependencies.auth.require(ctx)
    const subscribedRoomID = canonicalUUID(ctx.params.roomID, 'room ID')
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
          bestEffortAutoSubscribe(
            ctx,
            dependencies,
            localUser.id,
            subscribedRoomID,
            groupMessageSequence(response),
          )
        }
      })
      return
    }
    await withJar(ctx, async (jar) => {
      const response = await dependencies.upstream.request(groupPath(ctx, '/messages'), jar, {
        method: 'POST', body: upstreamBody,
      })
      sendUpstreamResponse(ctx, response, jar)
      if (response.status >= 200 && response.status < 300) {
        bestEffortAutoSubscribe(
          ctx,
          dependencies,
          localUser.id,
          subscribedRoomID,
          groupMessageSequence(response),
        )
      }
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
      const accountKey = requestAccountKey(ctx.req)
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

  router.all('/api/*gatewayPath', async (ctx) => {
    if (ctx.path.startsWith('/api/app/') || ctx.path.startsWith('/api/pair/')) {
      throw new HttpError(404, 'Route not found', 'not_found')
    }
    dependencies.auth.require(ctx, ctx.path === '/api/profiles')
    const raw = Array.isArray(ctx.params.gatewayPath)
      ? ctx.params.gatewayPath.join('/')
      : ctx.params.gatewayPath
    const upstreamPath = pairedProxyPath(raw)
    const response = await dependencies.upstreamSession.request(upstreamPath, {
      method: ctx.method,
      search: new URLSearchParams(ctx.querystring),
      body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : optionalBody(ctx),
      // Hermes binds WebSocket tickets to the request address. The relay's
      // upstream connection originates from 8800 itself, so forwarding the
      // phone's address here would make 9119 reject the ticket during Upgrade.
      clientAddress: upstreamPath === '/api/auth/ws-ticket'
        ? undefined : ctx.req.socket.remoteAddress,
      maxResponseBytes: /\/plugins\/yaoyao\/v1\/nodes\/[0-9a-f-]{36}\/files$/.test(upstreamPath)
        ? 256 * 1_024 * 1_024 : undefined,
    })
    const nativeGroupMessage = ctx.method === 'POST'
      ? /^\/api\/plugins\/yaoyao\/v1\/rooms\/([0-9a-f-]{36})\/messages$/.exec(upstreamPath)
      : null
    if (nativeGroupMessage && response.status >= 200 && response.status < 300) {
      const localUser = dependencies.auth.require(ctx)
      bestEffortAutoSubscribe(
        ctx,
        dependencies,
        localUser.id,
        canonicalUUID(nativeGroupMessage[1]!, 'room ID'),
        groupMessageSequence(response),
      )
    }
    sendUpstreamResponse(ctx, response, dependencies.upstreamSession.jar)
  })

  return router
}

export function incomingCookieNames(ctx: Koa.Context): string[] {
  return Object.keys(parse(ctx.get('cookie')))
}

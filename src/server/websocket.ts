import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { ServerConfig } from './config.js'
import { HttpError } from './errors.js'
import type { RealtimeChannel, RealtimeLeaseStore } from './leases.js'
import type { NodePairingStore } from './pairing.js'
import {
  ChatPushRelayObserver,
  type ChatNotificationResolver,
  type PushEventCoordinator,
} from './pushEvents.js'
import { isAllowedHostHeader, isExactOrigin, requestAccountKey } from './security.js'

type UpgradeRequest = Parameters<NonNullable<HttpServer['on']>>[1] extends never ? never : any

export interface WebSocketPushDependencies {
  coordinator: PushEventCoordinator
  resolveGatewayUser?(request: UpgradeRequest): string | undefined
  notificationResolver?: ChatNotificationResolver
}

const CHAT_MAX_PAYLOAD = 36 * 1_024 * 1_024
const GROUP_MAX_PAYLOAD = 2 * 1_024 * 1_024
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024
const CHAT_METHODS = new Set([
  'approval.respond',
  'clarify.respond',
  'config.set',
  'file.attach',
  'image.attach_bytes',
  'pdf.attach',
  'profiles.configure',
  'profiles.get_asset',
  'profiles.list',
  'profiles.set_asset',
  'prompt.submit',
  'session.branch',
  'session.close',
  'session.context_breakdown',
  'session.create',
  'session.interrupt',
  'session.resume',
  'session.steer',
  'session.usage',
])
const SESSION_ID_REQUIRED_METHODS = new Set([
  'config.set',
  'file.attach',
  'image.attach_bytes',
  'pdf.attach',
  'prompt.submit',
  'session.branch',
  'session.close',
  'session.context_breakdown',
  'session.interrupt',
  'session.resume',
  'session.steer',
  'session.usage',
])

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return
  const safe = message.replace(/[\r\n]/g, ' ').slice(0, 120)
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(safe)}\r\n\r\n${safe}`,
  )
}

function safeCloseCode(code: number): number {
  if ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999)) return code
  return 1011
}

function safeCloseReason(value: string): string {
  let reason = value
  while (Buffer.byteLength(reason, 'utf8') > 123) reason = reason.slice(0, -1)
  return reason
}

function safeString(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`)
  const normalized = value.trim()
  if ((!normalized && required) || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, `${label} is invalid`)
  }
  return normalized
}

function normalizedConfigParams(params: Record<string, unknown>): Record<string, unknown> {
  const sessionID = safeString(params.session_id, 'session_id', true)!
  const key = safeString(params.key, 'config key', true)
  if (key === 'model') {
    const value = typeof params.value === 'string' ? params.value.trim() : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511} --provider [A-Za-z0-9][A-Za-z0-9._:-]{0,127}( --session)?$/.test(value)) {
      throw new HttpError(400, 'Model selection is invalid')
    }
    return {
      session_id: sessionID,
      key,
      value,
      ...(params.confirm_expensive_model === true ? { confirm_expensive_model: true } : {}),
    }
  }
  if (key === 'reasoning') {
    const value = safeString(params.value, 'reasoning value', true)!
    if (!new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).has(value)) {
      throw new HttpError(400, 'Reasoning value is invalid')
    }
    return { session_id: sessionID, key, value, scope: 'session' }
  }
  if (key === 'fast') {
    const value = safeString(params.value, 'fast value', true)!
    if (value !== 'fast' && value !== 'normal') throw new HttpError(400, 'Fast value is invalid')
    return { session_id: sessionID, key, value, scope: 'session' }
  }
  throw new HttpError(403, 'Config key is not allowed')
}

function normalizedSessionOpenParams(
  method: 'session.create' | 'session.resume',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const profile = safeString(params.profile, 'profile', true)!
  const columns = typeof params.cols === 'number' && Number.isInteger(params.cols)
    ? Math.min(500, Math.max(20, params.cols))
    : 80
  if (method === 'session.resume') {
    return {
      session_id: safeString(params.session_id, 'session_id', true)!,
      profile,
      source: 'web',
      close_on_disconnect: false,
      omit_messages: params.omit_messages === true,
      cols: columns,
    }
  }
  const title = safeString(params.title, 'title')
  const reasoning = safeString(params.reasoning_effort, 'reasoning effort')
  const allowedReasoning = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  if (reasoning && !allowedReasoning.has(reasoning)) throw new HttpError(400, 'Reasoning effort is invalid')
  return {
    profile,
    source: 'web',
    close_on_disconnect: false,
    cols: columns,
    ...(title ? { title } : {}),
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(typeof params.fast === 'boolean' ? { fast: params.fast } : {}),
  }
}

function normalizedPairedSessionOpenParams(
  method: 'session.create' | 'session.resume',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const profile = safeString(params.profile, 'profile', true)!
  const source = safeString(params.source, 'source') ?? 'mobile'
  const columns = typeof params.cols === 'number' && Number.isInteger(params.cols)
    ? Math.min(500, Math.max(20, params.cols))
    : 80
  if (method === 'session.resume') {
    return {
      session_id: safeString(params.session_id, 'session_id', true)!,
      profile,
      source,
      close_on_disconnect: false,
      omit_messages: params.omit_messages === true,
      cols: columns,
    }
  }
  const title = safeString(params.title, 'title')
  const cwd = typeof params.cwd === 'string' && params.cwd.length <= 4_096 ? params.cwd : ''
  const reasoning = safeString(params.reasoning_effort, 'reasoning effort')
  const allowedReasoning = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  if (reasoning && !allowedReasoning.has(reasoning)) throw new HttpError(400, 'Reasoning effort is invalid')
  const model = safeString(params.model, 'model')
  const provider = safeString(params.provider, 'provider')
  if ((model === undefined) !== (provider === undefined)) {
    throw new HttpError(400, 'Model and provider must be set together')
  }
  const messages = params.messages
  if (messages !== undefined && (!Array.isArray(messages) || messages.length > 256)) {
    throw new HttpError(400, 'Seed messages are invalid')
  }
  return {
    profile,
    source,
    close_on_disconnect: false,
    cols: columns,
    cwd,
    hidden: params.hidden === true,
    ...(title ? { title } : {}),
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(model && provider ? { model, provider } : {}),
    ...(typeof params.fast === 'boolean' ? { fast: params.fast } : {}),
    ...(messages !== undefined ? { messages } : {}),
  }
}

function checkedChatFrame(data: RawData, isBinary: boolean, paired = false): string {
  if (isBinary) throw new HttpError(400, 'Binary chat frames are not accepted')
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  if (bytes.byteLength > CHAT_MAX_PAYLOAD) throw new HttpError(413, 'Chat frame is too large')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Chat frame must be JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Chat frame must be a JSON-RPC object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.method !== 'string' || !CHAT_METHODS.has(request.method)) {
    throw new HttpError(403, 'Chat RPC method is not allowed')
  }
  if (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number') {
    throw new HttpError(400, 'Chat RPC id is invalid')
  }
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new HttpError(400, 'Chat RPC params must be an object')
  }
  let params = { ...(request.params as Record<string, unknown>) }
  safeString(params.session_id, 'session_id', SESSION_ID_REQUIRED_METHODS.has(request.method))
  const profileRequired = request.method === 'session.create' || request.method === 'session.resume'
  safeString(params.profile, 'profile', profileRequired)
  if (request.method === 'session.create' || request.method === 'session.resume') {
    params = paired
      ? normalizedPairedSessionOpenParams(request.method, params)
      : normalizedSessionOpenParams(request.method, params)
  }
  if (request.method === 'profiles.list') {
    const preferred = params.preferred_session_ids
    if (preferred !== undefined && (!preferred || typeof preferred !== 'object' || Array.isArray(preferred))) {
      throw new HttpError(400, 'preferred_session_ids must be an object')
    }
    params = {
      ...(typeof params.include_sessions === 'boolean' ? { include_sessions: params.include_sessions } : {}),
      ...(preferred !== undefined ? { preferred_session_ids: preferred } : {}),
    }
  }
  if (request.method === 'profiles.get_asset') {
    params = {
      name: safeString(params.name, 'profile name', true)!,
      asset: safeString(params.asset, 'profile asset', true)!,
    }
  }
  if (request.method === 'profiles.set_asset') {
    const clear = params.clear === true
    const data = typeof params.data === 'string' ? params.data.trim() : ''
    if (!clear && !data) throw new HttpError(400, 'profile asset data is required')
    if (data.length > 2_800_000) throw new HttpError(413, 'profile asset exceeds 2 MiB')
    params = {
      name: safeString(params.name, 'profile name', true)!,
      asset: safeString(params.asset, 'profile asset', true)!,
      ...(clear ? { clear: true } : { data }),
    }
  }
  if (request.method === 'profiles.configure') {
    if (!params.ui_meta || typeof params.ui_meta !== 'object' || Array.isArray(params.ui_meta)) {
      throw new HttpError(400, 'ui_meta must be an object')
    }
    if (params.ui_meta_expected_revisions !== undefined
      && (!params.ui_meta_expected_revisions
        || typeof params.ui_meta_expected_revisions !== 'object'
        || Array.isArray(params.ui_meta_expected_revisions))) {
      throw new HttpError(400, 'ui_meta_expected_revisions must be an object')
    }
    params = {
      name: safeString(params.name, 'profile name', true)!,
      ui_meta: params.ui_meta,
      ...(params.ui_meta_expected_revisions !== undefined
        ? { ui_meta_expected_revisions: params.ui_meta_expected_revisions }
        : {}),
    }
  }
  if (request.method === 'config.set') params = normalizedConfigParams(params)
  if (request.method === 'prompt.submit' || request.method === 'session.steer') {
    const text = typeof params.text === 'string' ? params.text.trim() : ''
    if (!text || text.length > 200_000) throw new HttpError(400, 'Prompt text is invalid')
    params = {
      session_id: safeString(params.session_id, 'session_id', true)!,
      text,
      ...(request.method === 'prompt.submit' && params.queued === true ? { queued: true } : {}),
    }
  }

  if (request.method === 'image.attach_bytes' || request.method === 'pdf.attach') {
    const encoded = typeof params.content_base64 === 'string' ? params.content_base64 : ''
    const estimated = Math.floor(encoded.length * 0.75)
    if (!encoded || estimated > 25 * 1_024 * 1_024) {
      throw new HttpError(413, 'Attachment exceeds 25 MiB')
    }
  }
  if (request.method === 'file.attach') {
    const dataURL = typeof params.data_url === 'string' ? params.data_url : ''
    const marker = dataURL.indexOf(',')
    if (marker < 0 || Math.floor((dataURL.length - marker - 1) * 0.75) > 25 * 1_024 * 1_024) {
      throw new HttpError(413, 'Attachment exceeds 25 MiB')
    }
  }
  return JSON.stringify({ ...request, params })
}

function upstreamWebSocketURL(config: ServerConfig, channel: RealtimeChannel, lease: {
  credential: { name: 'ticket' | 'token'; value: string }
  epoch?: string
  cursor?: number
}): URL {
  const url = new URL(config.upstream)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = config.upstream.pathname === '/' ? '' : config.upstream.pathname.replace(/\/$/, '')
  url.pathname = channel === 'chat'
    ? `${prefix}/api/ws`
    : `${prefix}/api/plugins/yaoyao/v1/events`
  url.search = ''
  url.searchParams.set(lease.credential.name, lease.credential.value)
  if (channel === 'groups') {
    url.searchParams.set('epoch', lease.epoch!)
    url.searchParams.set('cursor', String(lease.cursor ?? 0))
  }
  return url
}

function pairedUpstreamWebSocketURL(
  config: ServerConfig,
  channel: RealtimeChannel,
  ticket: string,
  epoch?: string,
  cursor?: number,
): URL {
  const url = new URL(config.upstream)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = config.upstream.pathname === '/' ? '' : config.upstream.pathname.replace(/\/$/, '')
  url.pathname = channel === 'chat'
    ? `${prefix}/api/ws`
    : `${prefix}/api/plugins/yaoyao/v1/events`
  url.search = ''
  url.searchParams.set('ticket', ticket)
  if (channel === 'groups') {
    url.searchParams.set('epoch', epoch!)
    url.searchParams.set('cursor', String(cursor ?? 0))
  }
  return url
}

function closePair(client: WebSocket, upstream: WebSocket, code = 1000, reason = ''): void {
  const safeReason = safeCloseReason(reason)
  const safeCode = safeCloseCode(code)
  if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
    client.close(safeCode, safeReason)
  }
  if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
    upstream.close(safeCode, safeReason)
  }
}

class GroupFrameValidator {
  #ready = false
  #cursor: number

  constructor(readonly epoch: string, cursor: number) {
    this.#cursor = cursor
  }

  accept(data: RawData, isBinary: boolean): boolean {
    if (isBinary) throw new HttpError(400, 'Binary group frames are not accepted')
    let envelope: Record<string, unknown>
    try {
      const value = JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
      envelope = value as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'Malformed group event frame')
    }
    const type = envelope.type
    const cursor = Number(envelope.cursor)
    if (type === 'group.ready') {
      const heartbeat = Number(envelope.heartbeatSeconds)
      if (this.#ready || envelope.epoch !== this.epoch || !Number.isSafeInteger(cursor)
        || cursor !== this.#cursor || !Number.isFinite(heartbeat) || heartbeat <= 0) {
        throw new HttpError(409, 'Invalid group.ready frame')
      }
      this.#ready = true
      return true
    }
    if (type === 'group.reset_required') {
      if (typeof envelope.epoch !== 'string' || !Number.isSafeInteger(cursor)
        || typeof envelope.reason !== 'string') {
        throw new HttpError(400, 'Invalid group.reset_required frame')
      }
      return true
    }
    if (!this.#ready) throw new HttpError(409, 'Group event arrived before group.ready')
    if (type === 'group.event') {
      if (envelope.epoch !== this.epoch || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new HttpError(409, 'Group event epoch or cursor is invalid')
      }
      if (cursor <= this.#cursor) return false
      if (cursor !== this.#cursor + 1) throw new HttpError(409, 'Group event cursor gap')
      this.#cursor = cursor
      return true
    }
    if (type === 'group.heartbeat') {
      if ((envelope.epoch !== undefined && envelope.epoch !== this.epoch)
        || !Number.isSafeInteger(cursor) || cursor !== this.#cursor) {
        throw new HttpError(409, 'Group heartbeat cursor mismatch')
      }
      return true
    }
    throw new HttpError(400, 'Unknown group event frame')
  }

  resetFrame(reason: string): string {
    return JSON.stringify({
      type: 'group.reset_required',
      epoch: this.epoch,
      cursor: this.#cursor,
      reason,
    })
  }
}

function relaySocket(
  client: WebSocket,
  upstream: WebSocket,
  channel: RealtimeChannel,
  onFinished: () => void,
  groupAnchor?: { epoch: string; cursor: number },
  paired = false,
  chatObserver?: ChatPushRelayObserver,
): void {
  const groupValidator = groupAnchor
    ? new GroupFrameValidator(groupAnchor.epoch, groupAnchor.cursor)
    : undefined
  let clientAlive = true
  let upstreamAlive = true
  let finished = false
  let clientFrames = Promise.resolve()
  const finish = () => {
    if (finished) return
    finished = true
    clearInterval(heartbeat)
    chatObserver?.disconnected()
    onFinished()
  }
  const heartbeat = setInterval(() => {
    if (!clientAlive || !upstreamAlive) {
      client.terminate()
      upstream.terminate()
      finish()
      return
    }
    clientAlive = false
    upstreamAlive = false
    if (client.readyState === WebSocket.OPEN) client.ping()
    if (upstream.readyState === WebSocket.OPEN) upstream.ping()
  }, 25_000)
  heartbeat.unref()
  client.on('pong', () => { clientAlive = true })
  upstream.on('pong', () => { upstreamAlive = true })

  client.on('message', (data, isBinary) => {
    clientFrames = clientFrames.then(() => {
      if (channel === 'groups') throw new HttpError(403, 'Group event stream is read-only')
      if (upstream.readyState !== WebSocket.OPEN) throw new HttpError(409, 'Hermes socket is not ready')
      if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) throw new HttpError(429, 'Hermes socket is congested')
      const frame = checkedChatFrame(data, isBinary, paired)
      chatObserver?.observeClientFrame(frame)
      if (upstream.readyState !== WebSocket.OPEN) throw new HttpError(409, 'Hermes socket is not ready')
      upstream.send(frame)
    }).catch(error => {
      const reason = error instanceof Error ? error.message : 'Invalid frame'
      closePair(client, upstream, 1008, reason)
    })
  })
  upstream.on('message', (data, isBinary) => {
    const length = typeof data === 'string' ? Buffer.byteLength(data) : Buffer.byteLength(data as Uint8Array)
    if ((channel === 'groups' && length > GROUP_MAX_PAYLOAD) || client.bufferedAmount > MAX_BUFFERED_BYTES) {
      closePair(client, upstream, 1009, 'Upstream frame or buffer limit exceeded')
      return
    }
    if (groupValidator) {
      try {
        if (!groupValidator.accept(data, isBinary)) return
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'invalid_group_frame'
        if (client.readyState === WebSocket.OPEN) client.send(groupValidator.resetFrame(reason))
        closePair(client, upstream, 1008, 'Group event stream requires reset')
        return
      }
    }
    if (channel === 'chat') chatObserver?.observeUpstreamFrame(data, isBinary)
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  client.on('close', (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(safeCloseCode(code), safeCloseReason(reason.toString()))
    }
    finish()
  })
  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(safeCloseCode(code), safeCloseReason(reason.toString()))
    }
    finish()
  })
  client.on('error', () => {
    upstream.terminate()
    finish()
  })
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Hermes WebSocket failed')
    finish()
  })
}

export function installWebSocketRelay(
  server: HttpServer,
  config: ServerConfig,
  leases: RealtimeLeaseStore,
  pairings: NodePairingStore,
  push?: WebSocketPushDependencies,
): () => void {
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: CHAT_MAX_PAYLOAD })
  const active = new Map<string, number>()
  const onUpgrade = (request: UpgradeRequest, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'invalid'}`)
    } catch {
      rejectUpgrade(socket, 400, 'Invalid WebSocket URL')
      return
    }
    const gatewayChannel: RealtimeChannel | undefined = url.pathname === '/api/ws'
      ? 'chat'
      : url.pathname === '/api/plugins/yaoyao/v1/events' ? 'groups' : undefined
    if (gatewayChannel) {
      const host = request.headers.host
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
      const secure = Boolean(config.tlsCert)
      if (!isAllowedHostHeader(host, config)
        || (origin !== undefined && !isExactOrigin(origin, host, secure, config.allowedHosts))) {
        rejectUpgrade(socket, 403, 'Host or Origin rejected')
        return
      }
      const allowed = gatewayChannel === 'groups'
        ? new Set(['ticket', 'epoch', 'cursor']) : new Set(['ticket'])
      if ([...url.searchParams.keys()].some(name => !allowed.has(name))) {
        rejectUpgrade(socket, 400, 'Unexpected WebSocket query parameter')
        return
      }
      const ticket = url.searchParams.get('ticket')
      const epoch = gatewayChannel === 'groups' ? url.searchParams.get('epoch') : undefined
      const cursor = Number(url.searchParams.get('cursor') ?? '0')
      if (!ticket || ticket.length > 4_096
        || (gatewayChannel === 'groups' && (!epoch || !Number.isSafeInteger(cursor) || cursor < 0))) {
        rejectUpgrade(socket, 401, 'Missing or invalid Gateway ticket')
        return
      }
      const connectionKey = `gateway:${request.socket.remoteAddress ?? 'unknown'}:${gatewayChannel}`
      if ((active.get(connectionKey) ?? 0) >= (gatewayChannel === 'chat' ? 4 : 2)) {
        rejectUpgrade(socket, 429, 'Too many realtime connections')
        return
      }
      active.set(connectionKey, (active.get(connectionKey) ?? 0) + 1)
      let gatewayUserID: string | undefined
      if (gatewayChannel === 'chat' && push?.resolveGatewayUser) {
        try { gatewayUserID = push.resolveGatewayUser(request) } catch { /* unowned relays are not push-tracked */ }
      }
      socketServer.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(pairedUpstreamWebSocketURL(
          config, gatewayChannel, ticket, epoch ?? undefined, cursor,
        ), {
          headers: { Origin: config.upstream.origin },
          maxPayload: gatewayChannel === 'chat' ? CHAT_MAX_PAYLOAD : GROUP_MAX_PAYLOAD,
          handshakeTimeout: 15_000,
        })
        let released = false
        const release = () => {
          if (released) return
          released = true
          const count = (active.get(connectionKey) ?? 1) - 1
          if (count <= 0) active.delete(connectionKey)
          else active.set(connectionKey, count)
        }
        upstream.once('open', () => relaySocket(
          client, upstream, gatewayChannel, release,
          gatewayChannel === 'groups' ? { epoch: epoch!, cursor } : undefined,
          false,
          gatewayUserID && push
            ? new ChatPushRelayObserver(
                push.coordinator,
                { localUserID: gatewayUserID, source: 'gateway' },
                Date.now,
                push.notificationResolver,
              )
            : undefined,
        ))
        upstream.once('unexpected-response', release)
        upstream.once('error', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1011, 'Unable to connect to Hermes')
          release()
        })
        client.once('close', () => {
          if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
          release()
        })
      })
      return
    }
    const pairedMatch = url.pathname.match(
      /^\/node\/([0-9a-f-]{36})\/api\/(ws|plugins\/yaoyao\/v1\/events)$/,
    )
    if (pairedMatch) {
      const deviceID = pairedMatch[1]!
      const channel: RealtimeChannel = pairedMatch[2] === 'ws' ? 'chat' : 'groups'
      const host = request.headers.host
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
      const secure = Boolean(config.tlsCert)
      if (!isAllowedHostHeader(host, config)
        || (origin !== undefined && !isExactOrigin(origin, host, secure, config.allowedHosts))) {
        rejectUpgrade(socket, 403, 'Host or Origin rejected')
        return
      }
      if (!pairings.hasDevice(deviceID)) {
        rejectUpgrade(socket, 401, 'Paired device was revoked')
        return
      }
      const allowedQuery = channel === 'groups'
        ? new Set(['ticket', 'epoch', 'cursor'])
        : new Set(['ticket'])
      if ([...url.searchParams.keys()].some((name) => !allowedQuery.has(name))) {
        rejectUpgrade(socket, 400, 'Unexpected WebSocket query parameter')
        return
      }
      const ticket = url.searchParams.get('ticket')
      if (!ticket || ticket.length > 4_096) {
        rejectUpgrade(socket, 401, 'Missing paired node ticket')
        return
      }
      const epoch = channel === 'groups' ? url.searchParams.get('epoch') : undefined
      const cursorValue = channel === 'groups' ? Number(url.searchParams.get('cursor') ?? '0') : 0
      if (channel === 'groups' && (!epoch
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch)
        || !Number.isSafeInteger(cursorValue) || cursorValue < 0)) {
        rejectUpgrade(socket, 400, 'Invalid paired group cursor')
        return
      }
      const connectionKey = `paired:${deviceID}:${channel}`
      const maximum = channel === 'chat' ? 4 : 2
      if ((active.get(connectionKey) ?? 0) >= maximum) {
        rejectUpgrade(socket, 429, 'Too many realtime connections')
        return
      }
      active.set(connectionKey, (active.get(connectionKey) ?? 0) + 1)
      socketServer.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(
          pairedUpstreamWebSocketURL(
            config,
            channel,
            ticket,
            epoch ?? undefined,
            cursorValue,
          ),
          {
            headers: { Origin: config.upstream.origin },
            maxPayload: channel === 'chat' ? CHAT_MAX_PAYLOAD : GROUP_MAX_PAYLOAD,
            handshakeTimeout: 15_000,
          },
        )
        let released = false
        const release = () => {
          if (released) return
          released = true
          const count = (active.get(connectionKey) ?? 1) - 1
          if (count <= 0) active.delete(connectionKey)
          else active.set(connectionKey, count)
        }
        upstream.once('open', () => relaySocket(
          client,
          upstream,
          channel,
          release,
          channel === 'groups' ? { epoch: epoch!, cursor: cursorValue } : undefined,
          true,
        ))
        upstream.once('unexpected-response', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1011, 'Hermes rejected WebSocket')
          release()
        })
        upstream.once('error', () => {
          if (upstream.readyState !== WebSocket.OPEN && client.readyState === WebSocket.OPEN) {
            client.close(1011, 'Unable to connect to Hermes')
            release()
          }
        })
        client.once('close', () => {
          if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
          release()
        })
      })
      return
    }
    if (!url.pathname.startsWith('/ws/')) {
      if (config.production) rejectUpgrade(socket, 404, 'Unknown WebSocket endpoint')
      return
    }
    const channel: RealtimeChannel | undefined = url.pathname === '/ws/chat'
      ? 'chat'
      : url.pathname === '/ws/groups' ? 'groups' : undefined
    if (!channel) {
      rejectUpgrade(socket, 404, 'Unknown WebSocket endpoint')
      return
    }
    const host = request.headers.host
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
    const secure = Boolean(config.tlsCert)
    if (!isAllowedHostHeader(host, config) || !isExactOrigin(origin, host, secure, config.allowedHosts)) {
      rejectUpgrade(socket, 403, 'Host or Origin rejected')
      return
    }
    if ([...url.searchParams.keys()].some((name) => name !== 'lease')) {
      rejectUpgrade(socket, 400, 'Unexpected WebSocket query parameter')
      return
    }
    const leaseID = url.searchParams.get('lease')
    if (!leaseID || leaseID.length > 128) {
      rejectUpgrade(socket, 401, 'Missing realtime lease')
      return
    }
    let lease
    const accountKey = requestAccountKey(request)
    try {
      lease = leases.consume(leaseID, channel, origin!, accountKey)
    } catch {
      rejectUpgrade(socket, 401, 'Realtime lease is invalid or expired')
      return
    }
    const connectionKey = `${channel}:${accountKey}`
    const maximum = channel === 'chat' ? 4 : 2
    if ((active.get(connectionKey) ?? 0) >= maximum) {
      rejectUpgrade(socket, 429, 'Too many realtime connections')
      return
    }
    active.set(connectionKey, (active.get(connectionKey) ?? 0) + 1)

    socketServer.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(upstreamWebSocketURL(config, channel, lease), {
        headers: { Origin: config.upstream.origin },
        maxPayload: channel === 'chat' ? CHAT_MAX_PAYLOAD : GROUP_MAX_PAYLOAD,
        handshakeTimeout: 15_000,
      })
      let released = false
      const release = () => {
        if (released) return
        released = true
        const count = (active.get(connectionKey) ?? 1) - 1
        if (count <= 0) active.delete(connectionKey)
        else active.set(connectionKey, count)
      }
      upstream.once('open', () => relaySocket(
        client,
        upstream,
        channel,
        release,
        channel === 'groups' ? { epoch: lease.epoch!, cursor: lease.cursor ?? 0 } : undefined,
        false,
        channel === 'chat' && lease.localUserID && push
          ? new ChatPushRelayObserver(
              push.coordinator,
              { localUserID: lease.localUserID, accountKey, source: 'web' },
              Date.now,
              push.notificationResolver,
            )
          : undefined,
      ))
      upstream.once('unexpected-response', () => {
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'Hermes rejected WebSocket')
        release()
      })
      upstream.once('error', () => {
        if (upstream.readyState !== WebSocket.OPEN && client.readyState === WebSocket.OPEN) {
          client.close(1011, 'Unable to connect to Hermes')
          release()
        }
      })
      client.once('close', () => {
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
        release()
      })
    })
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    for (const client of socketServer.clients) client.close(1001, 'Server shutting down')
    socketServer.close()
  }
}

import type { GroupSocketEnvelope, JsonValue, RealtimeConnectionState, RpcEventFrame, RpcRequestFrame } from '@shared/types'
import { apiRequest, ApiError, unwrapData } from './client'
import { createId } from '@/utils/id'
import { number, record, string } from '@/utils/normalize'

export class RpcError extends Error {
  readonly code?: number | string
  readonly data?: JsonValue

  constructor(message: string, code?: number | string, data?: JsonValue) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

interface LeaseResponse { lease?: string; token?: string; id?: string; expiresAt?: string }

export async function createRealtimeLease(channel: 'chat' | 'groups', anchor?: { epoch: string; cursor: number }): Promise<string> {
  const payload = unwrapData(await apiRequest<LeaseResponse>('/api/app/realtime-leases', {
    method: 'POST', body: { channel, ...(anchor ?? {}) }, timeoutMs: 15_000,
  }))
  const lease = payload.lease ?? payload.token ?? payload.id
  if (!lease?.trim()) throw new ApiError('实时连接租约无效', 0, 'INVALID_LEASE')
  return lease.trim()
}

function webSocketURL(path: string, query: Record<string, string | number | undefined>): string {
  const url = new URL(path, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
  return url.toString()
}

type StateListener = (state: RealtimeConnectionState, reason?: string) => void
type RpcEventListener = (event: RpcEventFrame['params']) => void

interface PendingRequest {
  resolve(value: JsonValue): void
  reject(reason: unknown): void
  timer: number
  method: string
}

export class ChatRpcSocket {
  private socket?: WebSocket
  private generation = 0
  private pending = new Map<string, PendingRequest>()
  private eventListeners = new Set<RpcEventListener>()
  private stateListeners = new Set<StateListener>()
  private manuallyClosed = false
  state: RealtimeConnectionState = 'idle'

  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  async connect(): Promise<void> {
    this.close()
    this.manuallyClosed = false
    const generation = ++this.generation
    this.publishState('leasing')
    const lease = await createRealtimeLease('chat')
    if (generation !== this.generation || this.manuallyClosed) return
    this.publishState('connecting')
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(webSocketURL('/ws/chat', { lease }))
      this.socket = socket
      let settled = false
      const readyTimer = window.setTimeout(() => {
        if (settled) return
        settled = true
        socket.close(1011, 'gateway ready timeout')
        reject(new ApiError('等待 Hermes 实时握手超时', 0, 'GATEWAY_READY_TIMEOUT'))
      }, 15_000)
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return socket.close(1000)
        this.publishState('connected')
      }, { once: true })
      socket.addEventListener('message', event => {
        void this.handleMessage(event.data, generation).then(ready => {
          if (!ready || settled) return
          settled = true
          window.clearTimeout(readyTimer)
          resolve()
        })
      })
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true
          window.clearTimeout(readyTimer)
          reject(new ApiError('聊天实时连接失败', 0, 'WEBSOCKET_ERROR'))
        }
      })
      socket.addEventListener('close', event => {
        if (!settled) {
          settled = true
          window.clearTimeout(readyTimer)
          reject(new ApiError(event.reason || '聊天实时连接在握手前关闭', 0, 'WEBSOCKET_CLOSED'))
        }
        this.handleClose(event, generation)
      })
    })
  }

  close(): void {
    this.manuallyClosed = true
    this.generation += 1
    this.socket?.close(1000, 'client close')
    this.socket = undefined
    this.rejectAll(new ApiError('实时连接已关闭', 0, 'WEBSOCKET_CLOSED'))
    this.publishState('disconnected')
  }

  async request(method: string, params: Record<string, JsonValue> = {}, timeoutMs = 120_000): Promise<JsonValue> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new ApiError('聊天实时连接尚未就绪', 0, 'WEBSOCKET_NOT_READY')
    const id = createId('rpc')
    const frame: RpcRequestFrame = { jsonrpc: '2.0', id, method, params }
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new ApiError(`实时请求超时：${method}`, 0, 'RPC_TIMEOUT'))
        // A timed-out request has an unknown receipt and the transport may be half-open.
        this.socket?.close(1011, 'rpc timeout')
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private async handleMessage(data: unknown, generation: number): Promise<boolean> {
    if (generation !== this.generation) return false
    let text: string
    if (typeof data === 'string') text = data
    else if (data instanceof Blob) text = await data.text()
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
    else return false
    let frame: unknown
    try { frame = JSON.parse(text) } catch { return false }
    const source = record(frame)
    const id = typeof source.id === 'string' || typeof source.id === 'number' ? String(source.id) : ''
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      window.clearTimeout(pending.timer)
      const error = record(source.error)
      if (source.error) pending.reject(new RpcError(string(error.message, 'Hermes JSON-RPC 请求失败'), error.code as number | string, error.data as JsonValue))
      else pending.resolve((source.result ?? null) as JsonValue)
      return false
    }
    if (source.method !== 'event') return false
    const params = record(source.params)
    const type = string(params.type)
    if (!type) return false
    const event: RpcEventFrame['params'] = {
      type,
      session_id: string(params.session_id) || undefined,
      profile: string(params.profile) || undefined,
      payload: (params.payload ?? null) as JsonValue,
    }
    if (type === 'gateway.ready') this.publishState('ready')
    for (const listener of this.eventListeners) listener(event)
    return type === 'gateway.ready'
  }

  private handleClose(event: CloseEvent, generation: number): void {
    if (generation !== this.generation) return
    this.socket = undefined
    this.rejectAll(new ApiError('聊天实时连接已断开', 0, 'WEBSOCKET_CLOSED'))
    this.publishState(this.manuallyClosed ? 'disconnected' : 'failed', event.reason || `连接关闭（${event.code}）`)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private publishState(state: RealtimeConnectionState, reason?: string): void {
    this.state = state
    for (const listener of this.stateListeners) listener(state, reason)
  }
}

export interface GroupEventSocketOptions {
  epoch: string
  cursor: number
  onEnvelope(envelope: GroupSocketEnvelope): void
  onState?(state: RealtimeConnectionState, reason?: string): void
  onReset(reason: string): void
}

export class GroupEventSocket {
  private socket?: WebSocket
  private generation = 0
  private manuallyClosed = false
  private epoch = ''
  private cursor = 0
  state: RealtimeConnectionState = 'idle'

  async connect(options: GroupEventSocketOptions): Promise<void> {
    this.close()
    this.manuallyClosed = false
    this.epoch = options.epoch
    this.cursor = options.cursor
    const generation = ++this.generation
    this.publish(options, 'leasing')
    const lease = await createRealtimeLease('groups', { epoch: this.epoch, cursor: this.cursor })
    if (generation !== this.generation || this.manuallyClosed) return
    this.publish(options, 'connecting')
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(webSocketURL('/ws/groups', { lease }))
      this.socket = socket
      let settled = false
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return socket.close(1000)
        settled = true
        resolve()
      }, { once: true })
      socket.addEventListener('message', event => { void this.handleMessage(event.data, generation, options) })
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true
          reject(new ApiError('团队事件连接失败', 0, 'GROUP_WEBSOCKET_ERROR'))
        }
      })
      socket.addEventListener('close', event => {
        if (generation !== this.generation) return
        this.socket = undefined
        this.publish(options, this.manuallyClosed ? 'disconnected' : 'failed', event.reason || `连接关闭（${event.code}）`)
      })
    })
  }

  close(): void {
    this.manuallyClosed = true
    this.generation += 1
    this.socket?.close(1000, 'client close')
    this.socket = undefined
    this.state = 'disconnected'
  }

  private async handleMessage(data: unknown, generation: number, options: GroupEventSocketOptions): Promise<void> {
    if (generation !== this.generation) return
    let text: string
    if (typeof data === 'string') text = data
    else if (data instanceof Blob) text = await data.text()
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
    else return
    let decoded: unknown
    try { decoded = JSON.parse(text) } catch {
      this.needsReset(options, 'malformed_frame')
      return
    }
    const source = record(decoded)
    const envelope: GroupSocketEnvelope = {
      type: string(source.type) as GroupSocketEnvelope['type'],
      epoch: string(source.epoch) || undefined,
      cursor: source.cursor == null ? undefined : number(source.cursor, -1),
      heartbeatSeconds: source.heartbeatSeconds == null && source.heartbeat_seconds == null ? undefined : number(source.heartbeatSeconds ?? source.heartbeat_seconds),
      roomId: string(source.roomId ?? source.room_id) || undefined,
      event: string(source.event) || undefined,
      payload: (source.payload ?? null) as JsonValue,
      reason: string(source.reason) || undefined,
    }
    if (!['group.ready', 'group.event', 'group.heartbeat', 'group.reset_required'].includes(envelope.type)) {
      this.needsReset(options, 'unknown_envelope')
      return
    }
    if (envelope.epoch && envelope.epoch !== this.epoch) {
      this.needsReset(options, 'epoch_mismatch')
      return
    }
    if (envelope.type === 'group.ready') {
      if (envelope.cursor !== this.cursor) return this.needsReset(options, 'ready_cursor_mismatch')
      this.publish(options, 'ready')
      options.onEnvelope(envelope)
      return
    }
    if (envelope.type === 'group.event') {
      if (envelope.cursor == null || envelope.cursor < 0) return this.needsReset(options, 'invalid_cursor')
      if (envelope.cursor <= this.cursor) return
      if (envelope.cursor !== this.cursor + 1) return this.needsReset(options, 'cursor_gap')
      this.cursor = envelope.cursor
      options.onEnvelope(envelope)
      return
    }
    if (envelope.type === 'group.reset_required') {
      this.needsReset(options, envelope.reason || 'server_reset')
      return
    }
    if (envelope.cursor != null && envelope.cursor !== this.cursor) this.needsReset(options, 'heartbeat_cursor_mismatch')
  }

  private needsReset(options: GroupEventSocketOptions, reason: string): void {
    this.publish(options, 'needs-reset', reason)
    this.socket?.close(1000, 'reset required')
    options.onReset(reason)
  }

  private publish(options: GroupEventSocketOptions, state: RealtimeConnectionState, reason?: string): void {
    this.state = state
    options.onState?.(state, reason)
  }
}

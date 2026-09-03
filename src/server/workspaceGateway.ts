import WebSocket from 'ws'
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UpstreamClient } from './upstream.js'
import { UpstreamServiceSession } from './localAuth.js'
import { WorkspaceStore } from './workspaceStore.js'
import { HttpError } from './errors.js'
import type { ServerConfig } from './config.js'
import type { WorkspaceSource } from '../shared/workspace.js'

export interface WorkspaceNode {
  id: string
  name: string
  url: string
  secret: string
}
export interface GatewayTarget {
  url: URL
  client: UpstreamClient
  session: UpstreamServiceSession
}
export interface GatewayFrame {
  type: string
  session_id?: string
  payload?: Record<string, any>
}
export class WorkspaceNodes {
  private readonly key: Buffer
  private targets = new Map<string, GatewayTarget>()
  constructor(
    readonly store: WorkspaceStore,
    readonly config: ServerConfig,
    readonly local: GatewayTarget,
  ) {
    const path = join(config.home, 'workspace-key.bin')
    try {
      this.key = readFileSync(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.key = randomBytes(32)
      writeFileSync(path, this.key, { mode: 0o600, flag: 'wx' })
    }
    if (this.key.length !== 32) throw new Error('Invalid workspace encryption key')
  }
  seal(value: unknown): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, 'base64'),
      cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12))
    cipher.setAuthTag(b.subarray(12, 28))
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
    ) as T
  }
  target(owner: string, id: string): GatewayTarget {
    if (id === 'local') return this.local
    const node = this.store.require<WorkspaceNode>(owner, 'node', id),
      key = `${owner}:${id}`
    let target = this.targets.get(key)
    if (!target) {
      const credentials = this.open<{ username: string; password: string }>(node.secret)
      const url = new URL(node.url),
        client = new UpstreamClient(url)
      target = { url, client, session: new UpstreamServiceSession(client, () => credentials) }
      this.targets.set(key, target)
    }
    return target
  }
  async add(
    owner: string,
    input: { name: string; url: string; username: string; password: string },
  ): Promise<void> {
    const url = new URL(input.url)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new HttpError(400, '节点地址无效', 'invalid_node')
    const client = new UpstreamClient(url),
      session = new UpstreamServiceSession(client, () => ({
        username: input.username,
        password: input.password,
      }))
    try {
      const status = await session.request('/api/status')
      if (
        status.status === 200 &&
        JSON.parse(status.body.toString()).server_kind === 'yaoyao-web'
      ) {
        throw new HttpError(
          400,
          '请填写远端 Hermes 的 9119 地址，手机仍连接当前 Web 服务',
          'native_gateway_required',
        )
      }
      const response = await session.request('/api/profiles')
      if (response.status !== 200)
        throw new HttpError(400, '无法读取节点 Agent，请检查地址和凭据', 'node_unavailable')
      const id = randomUUID()
      this.store.put(owner, 'node', id, {
        id,
        name: input.name,
        url: url.href,
        secret: this.seal({ username: input.username, password: input.password }),
      })
      this.store.event(owner, 'nodes.changed', {})
    } finally {
      client.close()
    }
  }
  remove(owner: string, id: string): void {
    this.store.require(owner, 'node', id)
    this.store.remove(owner, 'node', id)
    this.targets.get(`${owner}:${id}`)?.client.close()
    this.targets.delete(`${owner}:${id}`)
    this.store.event(owner, 'nodes.changed', {})
  }
  async sources(owner: string): Promise<{ sources: WorkspaceSource[]; errors: string[] }> {
    const sources: WorkspaceSource[] = [],
      errors: string[] = []
    await Promise.all(
      ['local', ...this.store.list<WorkspaceNode>(owner, 'node').map((n) => n.id)].map(
        async (nodeId) => {
          try {
            const response = await this.target(owner, nodeId).session.request('/api/profiles')
            if (response.status !== 200) throw new Error('节点不可用')
            const payload = JSON.parse(response.body.toString())
            for (const p of Array.isArray(payload.profiles) ? payload.profiles : []) {
              const profile = typeof p === 'string' ? p : p.name
              if (typeof profile === 'string' && profile)
                sources.push({
                  nodeId,
                  profile,
                  name: p.ui_meta?.['hermes-bots']?.title || p.display_name || p.label || profile,
                })
            }
          } catch {
            errors.push(nodeId)
          }
        },
      ),
    )
    return { sources, errors }
  }
  close(): void {
    for (const t of this.targets.values()) t.client.close()
    this.targets.clear()
  }
}

/** One server-owned transport per execution binding, never tied to a browser. */
export class WorkspaceGateway {
  private socket?: WebSocket
  private pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  onEvent: (frame: GatewayFrame) => void = () => {}
  onDisconnect: () => void = () => {}
  constructor(readonly target: GatewayTarget) {}
  async connect(): Promise<void> {
    const credential = await this.target.session.webSocketCredential(),
      url = new URL(this.target.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`
    url.search = ''
    url.searchParams.set(credential.name, credential.value)
    const socket = new WebSocket(url, {
      agent: this.target.client.directAgent,
      headers: { Origin: this.target.url.origin },
      maxPayload: 36 * 1024 * 1024,
    })
    this.socket = socket
    let ready!: () => void
    let failed!: (e: Error) => void
    const handshake = new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    })
    const handshakeTimer = setTimeout(() => {
      socket.terminate()
      failed(new Error('Hermes gateway readiness timed out'))
    }, 20_000)
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString()),
          waiter = this.pending.get(String(frame.id))
        if (waiter) {
          clearTimeout(waiter.timer)
          this.pending.delete(String(frame.id))
          if (frame.error)
            waiter.reject(
              new HttpError(502, frame.error.message || 'Hermes 请求失败', 'gateway_rejected'),
            )
          else waiter.resolve(frame.result)
        } else if (frame.method === 'event' && frame.params) {
          if (frame.params.type === 'gateway.ready') {
            clearTimeout(handshakeTimer)
            ready()
          }
          this.onEvent(frame.params)
        }
      } catch {
        /* Malformed frames cannot mutate an execution. */
      }
    })
    socket.on('error', (error) => {
      clearTimeout(handshakeTimer)
      failed(error)
    })
    socket.on('close', () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Hermes connection closed'))
      }
      this.pending.clear()
      this.onDisconnect()
      clearTimeout(handshakeTimer)
      failed(new Error('Hermes connection closed'))
    })
    await handshake
  }
  rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Hermes connection unavailable'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Hermes response timed out'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }
  close(): void {
    this.onDisconnect = () => {}
    this.socket?.close()
  }
}

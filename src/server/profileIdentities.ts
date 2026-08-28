import WebSocket from 'ws'
import type { ServerConfig } from './config.js'
import { HttpError } from './errors.js'
import type { UpstreamServiceSession } from './localAuth.js'

export interface RemoteProfileIdentity {
  name: string
  displayName: string
  model: string
  color?: string
  avatar?: string
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {}
}

export class UpstreamProfileIdentityService {
  constructor(
    readonly config: ServerConfig,
    readonly upstream: UpstreamServiceSession,
  ) {}

  async load(): Promise<RemoteProfileIdentity[]> {
    const ticketResponse = await this.upstream.request('/api/auth/ws-ticket', {
      method: 'POST',
    })
    if (ticketResponse.status < 200 || ticketResponse.status >= 300) {
      throw new HttpError(502, 'Hermes 未签发身份读取凭据', 'profile_identity_ticket_failed')
    }
    let ticket = ''
    try { ticket = String(JSON.parse(ticketResponse.body.toString('utf8')).ticket ?? '') } catch { /* handled below */ }
    if (!ticket) throw new HttpError(502, 'Hermes 返回了空身份读取凭据', 'profile_identity_ticket_failed')

    const url = new URL(this.config.upstream)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const prefix = this.config.upstream.pathname === '/'
      ? '' : this.config.upstream.pathname.replace(/\/$/, '')
    url.pathname = `${prefix}/api/ws`
    url.search = ''
    url.searchParams.set('ticket', ticket)

    return new Promise<RemoteProfileIdentity[]>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Origin: this.config.upstream.origin },
        handshakeTimeout: 15_000,
        maxPayload: 36 * 1_024 * 1_024,
      })
      const identities = new Map<string, RemoteProfileIdentity>()
      const avatarRequests = new Map<string, string>()
      let requestedProfiles = false
      let finished = false
      const timeout = setTimeout(() => finishError(new Error('profile identity request timed out')), 30_000)
      timeout.unref()

      const cleanup = () => {
        clearTimeout(timeout)
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      }
      const finish = () => {
        if (finished) return
        finished = true
        cleanup()
        resolve([...identities.values()])
      }
      const finishError = (error: Error) => {
        if (finished) return
        finished = true
        cleanup()
        reject(new HttpError(502, `无法读取 Agent 身份：${error.message}`, 'profile_identity_failed'))
      }
      const send = (id: string, method: string, params: JsonObject) => {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      }

      socket.on('message', raw => {
        let frame: JsonObject
        try { frame = object(JSON.parse(String(raw))) } catch { return }
        if (!requestedProfiles && object(frame.params).type === 'gateway.ready') {
          requestedProfiles = true
          send('profiles', 'profiles.list', { include_sessions: false })
          return
        }
        if (String(frame.id ?? '') === 'profiles') {
          const profiles = Array.isArray(object(frame.result).profiles)
            ? object(frame.result).profiles as unknown[] : []
          for (const entry of profiles) {
            const outer = object(entry)
            const profile = Object.keys(object(outer.profile)).length
              ? object(outer.profile) : outer
            const name = typeof profile.name === 'string' ? profile.name.trim() : ''
            if (!name) continue
            const meta = object(object(profile.ui_meta)['hermes-bots'])
            const title = [meta.title, profile.display_name, profile.description, name]
              .find(value => typeof value === 'string' && value.trim()) as string
            const identity: RemoteProfileIdentity = {
              name,
              displayName: title.trim(),
              model: typeof profile.model === 'string' ? profile.model : '',
              ...(typeof meta.color === 'string' && /^#[0-9a-f]{6}$/i.test(meta.color)
                ? { color: meta.color } : {}),
            }
            identities.set(name, identity)
            if (profile.has_avatar === true) {
              const id = `avatar-${avatarRequests.size}`
              avatarRequests.set(id, name)
              send(id, 'profiles.get_asset', { name, asset: 'avatar' })
            }
          }
          if (avatarRequests.size === 0) finish()
          return
        }
        const id = String(frame.id ?? '')
        const name = avatarRequests.get(id)
        if (!name) return
        avatarRequests.delete(id)
        const data = object(frame.result).data
        if (typeof data === 'string'
          && data.length <= 2_800_000
          && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(data)) {
          const identity = identities.get(name)
          if (identity) identity.avatar = data
        }
        if (avatarRequests.size === 0) finish()
      })
      socket.once('error', finishError)
      socket.once('unexpected-response', () => finishError(new Error('Hermes rejected identity socket')))
      socket.once('close', () => {
        if (!finished) finishError(new Error('Hermes closed identity socket'))
      })
    })
  }
}

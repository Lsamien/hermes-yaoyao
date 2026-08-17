import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, createNodeServer, type NodeServerRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const closers: Array<() => Promise<void>> = []
const homes: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
}

function wsOpen(url: string, origin: string, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers: { Cookie: cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function wsMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

function closeRuntime(runtime: NodeServerRuntime): () => Promise<void> {
  return () => runtime.close()
}

describe('WebSocket relay', () => {
  it('keeps the upstream ticket server-side and filters chat RPC methods', async () => {
    const received: Array<Record<string, unknown>> = []
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/status') {
        response.setHeader('Set-Cookie', 'hermes_session_at=socket-user; Path=/; HttpOnly')
        response.end(JSON.stringify({ auth_required: true }))
      } else if (request.url === '/api/auth/me') {
        response.end(JSON.stringify({ user_id: 'socket-user', display_name: 'Socket User' }))
      } else if (request.url === '/api/profiles') {
        response.end(JSON.stringify({ profiles: [{ name: 'default', is_default: true }] }))
      } else if (request.url === '/api/auth/ws-ticket' && request.method === 'POST') {
        response.end(JSON.stringify({ ticket: 'one-time-upstream-secret' }))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      }
    })
    const upstreamSockets = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/api/ws' || url.searchParams.get('ticket') !== 'one-time-upstream-secret') {
        socket.destroy()
        return
      }
      upstreamSockets.handleUpgrade(request, socket, head, (client) => {
        client.send(JSON.stringify({ method: 'gateway.ready', params: {} }))
        client.on('message', (data) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>)
          client.send(JSON.stringify({ id: 'ok', result: {} }))
        })
      })
    })
    const upstreamPort = await listen(upstream)
    closers.push(async () => {
      for (const client of upstreamSockets.clients) client.terminate()
      upstreamSockets.close()
      await closeServer(upstream)
    })

    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-ws-'))
    homes.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 8800,
      upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
      allowedHosts: new Set(),
      home,
      allowInsecureLan: false,
      insecureLan: false,
      production: false,
    }
    const application = createApplication({ config })
    const node = createNodeServer(application)
    await listen(node.server)
    closers.push(closeRuntime(node))
    const port = (node.server.address() as AddressInfo).port
    config.port = port
    const origin = `http://127.0.0.1:${port}`

    const bootstrap = await fetch(`${origin}/api/app/bootstrap`)
    expect(bootstrap.status).toBe(200)
    const bootstrapBody = await bootstrap.json() as { csrfToken: string }
    const cookie = cookies(bootstrap)
    const leaseResponse = await fetch(`${origin}/api/app/realtime-leases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
        'X-CSRF-Token': bootstrapBody.csrfToken,
      },
      body: JSON.stringify({ channel: 'chat' }),
    })
    expect(leaseResponse.status).toBe(201)
    const leaseBody = await leaseResponse.json() as { lease: string }
    expect(JSON.stringify(leaseBody)).not.toContain('upstream-secret')
    const rotatedCookie = [cookie, cookies(leaseResponse)].filter(Boolean).join('; ')

    const socket = await wsOpen(
      `ws://127.0.0.1:${port}/ws/chat?lease=${encodeURIComponent(leaseBody.lease)}`,
      origin,
      rotatedCookie,
    )
    expect(await wsMessage(socket)).toMatchObject({ method: 'gateway.ready' })
    socket.send(JSON.stringify({
      id: 'resume-1',
      method: 'session.resume',
      params: { session_id: 'stored-session', profile: 'default', source: 'ios' },
    }))
    await wsMessage(socket)
    expect(received[0]).toMatchObject({
      method: 'session.resume',
      params: { session_id: 'stored-session', profile: 'default', source: 'web' },
    })

    socket.send(JSON.stringify({
      id: 'clarify-1',
      method: 'clarify.respond',
      params: { request_id: 'question-1', answer: '继续', },
    }))
    await wsMessage(socket)
    expect(received[1]).toMatchObject({
      method: 'clarify.respond',
      params: { request_id: 'question-1', answer: '继续' },
    })

    socket.send(JSON.stringify({
      id: 'queue-1',
      method: 'prompt.submit',
      params: { session_id: 'stored-session', text: '下一条', queued: true, ignored: 'drop-me' },
    }))
    await wsMessage(socket)
    expect(received[2]).toEqual({
      id: 'queue-1',
      method: 'prompt.submit',
      params: { session_id: 'stored-session', text: '下一条', queued: true },
    })

    socket.send(JSON.stringify({
      id: 'forbidden',
      method: 'config.set',
      params: { session_id: 'stored-session', key: 'yolo', value: 'true' },
    }))
    const closeCode = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(closeCode).toBe(1008)
  })

  it('rejects unknown production Upgrade requests instead of leaking a hanging socket', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-ws-'))
    homes.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 8800,
      upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(),
      home,
      allowInsecureLan: false,
      insecureLan: false,
      production: true,
    }
    const application = createApplication({ config })
    const node = createNodeServer(application)
    await listen(node.server)
    closers.push(closeRuntime(node))
    const port = (node.server.address() as AddressInfo).port
    config.port = port
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/vite-hmr`, {
        origin: `http://127.0.0.1:${port}`,
      })
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
      })
      socket.once('error', reject)
    })
    expect(status).toBe(404)
  })
})

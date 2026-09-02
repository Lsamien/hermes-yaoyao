// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthenticatedApplication } from './authenticatedApplication.js'
import { createNodeServer } from '../../src/server/app.js'
import { SSEParser } from '../../src/shared/sse.js'
import type { ServerConfig } from '../../src/server/config.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

async function setup(local = false) {
  const localToken = 'fixture_native_loopback_token_123456'
  const server = createServer((req, res) => {
    if (req.url === '/api/status') { res.end(JSON.stringify({ auth_required: false })); return }
    if (req.url === '/') { res.end(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(localToken)};</script>`); return }
    if (req.headers['x-hermes-session-token'] !== localToken) { res.writeHead(401); res.end('{}'); return }
    res.end(JSON.stringify({ profiles: [] }))
  })
  const wss = new WebSocketServer({ server, verifyClient: ({ req }) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    return local ? url.searchParams.get('token') === localToken && !url.searchParams.has('ticket')
      : url.searchParams.get('ticket') === 'upstream-secret'
  } })
  const peers = new Set<WebSocket>(), commands: any[] = []
  let connectionCount = 0, sequence = 0
  wss.on('connection', peer => {
    connectionCount++; peers.add(peer); peer.on('close', () => peers.delete(peer))
    peer.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'fixture' } } }))
    peer.on('message', raw => {
      const command = JSON.parse(raw.toString()); commands.push(command)
      peer.send(JSON.stringify({ id: command.id, result: command.method === 'session.resume'
        ? { session_id: 'runtime', stored_session_id: 'stored', running: false } : { status: 'streaming' } }))
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  closers.push(async () => { for (const c of wss.clients) c.terminate(); wss.close(); await new Promise<void>(r => server.close(() => r())) })
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-http-sse-api-'))
  const config: ServerConfig = { host: '127.0.0.1', port: 8800,
    upstream: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), allowedHosts: new Set(),
    home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home, mediaOwner: 'test',
    allowInsecureLan: false, insecureLan: false, production: false }
  const runtime = createAuthenticatedApplication({ config, fetchImpl: local ? undefined : (async input => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/ws-ticket') return Response.json({ ticket: 'upstream-secret' })
    if (path === '/api/status') return Response.json({ auth_required: true })
    return Response.json({ user_id: 'service', profiles: [] })
  }) as typeof fetch })
  const node = createNodeServer(runtime)
  node.server.listen(0, '127.0.0.1'); await once(node.server, 'listening')
  config.port = (node.server.address() as AddressInfo).port
  closers.push(() => node.close())
  const origin = `http://127.0.0.1:${config.port}`
  const caps = await fetch(`${origin}/api/realtime/capabilities`)
  const token = await caps.json() as { csrfToken: string }
  const cookie = caps.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': token.csrfToken, 'Content-Type': 'application/json' }
  const create = async () => {
    const response = await fetch(`${origin}/api/realtime/channels`, { method: 'POST', headers, body: '{"channel":"chat"}' })
    expect(response.status).toBe(201)
    return (await response.json() as { id: string }).id
  }
  const command = async (channel: string, id: string, method: string, params: object) => {
    const response = await fetch(`${origin}/api/realtime/channels/${channel}/commands`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': id }, body: JSON.stringify({ method, params }),
    })
    return { response, receipt: await response.json() as any }
  }
  const emit = (text: string) => {
    const payload = { text, emitted: performance.now() }
    for (const peer of peers) peer.send(JSON.stringify({ method: 'event', params: { type: 'message.delta', session_id: 'runtime', seq: ++sequence, payload } }))
  }
  return { origin, headers, create, command, emit, commands, config, count: () => connectionCount }
}

describe('HTTP/SSE realtime API', () => {
  it('connects to native loopback Hermes without an account for REST and realtime', async () => {
    const f = await setup(true)
    const c = await f.create()
    const result = await f.command(c, 'local-resume', 'session.resume', { session_id: 'stored', profile: 'default' })
    expect(result.receipt).toMatchObject({ state: 'confirmed', response: { result: { session_id: 'runtime' } } })
    const invalid = await fetch(`${f.origin}/api/realtime/channels`, { method: 'POST', headers: { ...f.headers, 'X-CSRF-Token': 'bad' }, body: '{"channel":"chat"}' })
    expect(invalid.status).toBe(403)
    expect(f.count()).toBe(1)
  })
  it('enforces CSRF and returns upstream-confirmed receipts', async () => {
    const f = await setup()
    const invalid = await fetch(`${f.origin}/api/realtime/channels`, { method: 'POST', headers: { ...f.headers, 'X-CSRF-Token': 'bad' }, body: '{"channel":"chat"}' })
    expect(invalid.status).toBe(403)
    const c = await f.create()
    const result = await f.command(c, 'resume', 'session.resume', { session_id: 'stored', profile: 'default' })
    expect(result.receipt).toMatchObject({ state: 'confirmed', response: { result: { session_id: 'runtime' } } })
    const forbidden = await f.command(c, 'forbidden', 'terminal.resize', { session_id: 'runtime' })
    expect(forbidden.response.status).toBe(403)
    expect(f.commands).toHaveLength(1)
  })
  it('allows existing attachment sizes only on the dedicated command endpoint', async () => {
    const f = await setup(), c = await f.create()
    await f.command(c, 'resume', 'session.resume', { session_id: 'stored', profile: 'default' })
    const attached = await f.command(c, 'attachment', 'image.attach_bytes', { session_id: 'runtime', content_base64: 'A'.repeat(3 * 1024 * 1024), filename: 'fixture.png' })
    expect(attached.response.status).toBe(200)
    expect(attached.receipt.state).toBe('confirmed')
    const other = await fetch(`${f.origin}/api/app/sessions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ data: 'A'.repeat(3 * 1024 * 1024) }) })
    expect(other.status).toBe(413)
  })

  it('shares Web/iOS subscriptions, replays after detach, and measures stream latency', async () => {
    const f = await setup(), a = await f.create(), b = await f.create()
    await f.command(a, 'resume-a', 'session.resume', { session_id: 'stored', profile: 'default' })
    await f.command(b, 'resume-b', 'session.resume', { session_id: 'stored', profile: 'default' })
    const controller = new AbortController()
    const response = await fetch(`${f.origin}/api/realtime/channels/${a}/events`, { headers: f.headers, signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const reader = response.body!.getReader(), decoder = new TextDecoder(), parser = new SSEParser()
    const initial = []
    while (!initial.some(x => x.event === 'frame')) initial.push(...parser.feed(decoder.decode((await reader.read()).value, { stream: true })))
    const cursor = initial.find(x => x.event === 'frame')!.id!
    controller.abort(); await reader.cancel().catch(() => {})
    f.emit('while-offline')
    await new Promise(r => setTimeout(r, 30))
    const resumedController = new AbortController()
    const resumed = await fetch(`${f.origin}/api/realtime/channels/${a}/events`, { headers: { ...f.headers, 'Last-Event-ID': cursor }, signal: resumedController.signal })
    const resumedReader = resumed.body!.getReader(), resumedParser = new SSEParser(), resumedDecoder = new TextDecoder()
    const entries = []
    while (!entries.some(x => x.event === 'frame')) entries.push(...resumedParser.feed(resumedDecoder.decode((await resumedReader.read()).value, { stream: true })))
    expect(entries.filter(e => e.event === 'frame').map(e => JSON.parse(e.data).params.payload.text)).toEqual(['while-offline'])
    expect(f.count()).toBe(1)
    const latencies: number[] = []
    const before = process.memoryUsage().rss, cpu = process.cpuUsage()
    const consume = (async () => {
      while (latencies.length < 200) {
        const chunk = await resumedReader.read()
        for (const e of resumedParser.feed(resumedDecoder.decode(chunk.value, { stream: true }))) {
          if (e.event === 'frame') latencies.push(performance.now() - JSON.parse(e.data).params.payload.emitted)
        }
      }
    })()
    for (let i = 0; i < 200; i++) { f.emit(`token-${i}`); await new Promise<void>(r => setImmediate(r)) }
    await consume
    latencies.sort((x, y) => x - y)
    console.info('SSE fixture performance', JSON.stringify({ samples: latencies.length, p95Ms: latencies[189], p99Ms: latencies[197], rssDelta: process.memoryUsage().rss - before, cpuMicros: process.cpuUsage(cpu) }))
    expect(latencies).toHaveLength(200)
    resumedController.abort(); await resumedReader.cancel().catch(() => {})
  })
  it('keeps an admitted run connected after the only SSE client is offline for over twenty seconds', async () => {
    const f = await setup(), c = await f.create()
    await f.command(c, 'open', 'session.resume', { session_id: 'stored', profile: 'default' })
    await f.command(c, 'send', 'prompt.submit', { session_id: 'runtime', text: 'long-running fixture' })
    const controller = new AbortController()
    const response = await fetch(`${f.origin}/api/realtime/channels/${c}/events`, { headers: f.headers, signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read(); controller.abort(); await reader.cancel().catch(() => {})
    await new Promise(r => setTimeout(r, 21_000))
    expect(f.count()).toBe(1)
    f.emit('finished while offline')
    const reconnect = new AbortController()
    const again = await fetch(`${f.origin}/api/realtime/channels/${c}/events`, { headers: f.headers, signal: reconnect.signal })
    const input = again.body!.getReader(), decoder = new TextDecoder()
    let text = ''
    while (!text.includes('finished while offline')) text += decoder.decode((await input.read()).value, { stream: true })
    expect(text).toContain('finished while offline')
    reconnect.abort(); await input.cancel().catch(() => {})
  }, 30_000)
})

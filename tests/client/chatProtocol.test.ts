import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatRpcSocket, GroupEventSocket } from '@/api/realtime'
import { setApiCsrfToken } from '@/api/client'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(url: string) {
    super()
    this.url = url
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  send(data: string): void { this.sent.push(data) }
  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
  message(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  setApiCsrfToken('csrf-test')
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function leaseFetch() {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ lease: 'lease-1' }), {
    status: 201, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('raw realtime protocols', () => {
  it('waits for gateway.ready and correlates JSON-RPC responses', async () => {
    leaseFetch()
    const socket = new ChatRpcSocket()
    const events: string[] = []
    socket.onEvent(event => events.push(event.type))
    const connecting = socket.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const transport = FakeWebSocket.instances[0]
    await Promise.resolve()
    expect(socket.state).toBe('connected')
    transport.message({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } })
    await connecting
    expect(socket.state).toBe('ready')

    const response = socket.request('session.usage', { session_id: 'runtime-1' })
    const frame = JSON.parse(transport.sent[0])
    expect(frame).toMatchObject({ jsonrpc: '2.0', method: 'session.usage', params: { session_id: 'runtime-1' } })
    transport.message({ jsonrpc: '2.0', id: frame.id, result: { total_tokens: 42 } })
    await expect(response).resolves.toEqual({ total_tokens: 42 })
    expect(events).toEqual(['gateway.ready'])
    socket.close()
  })

  it('binds a group lease to epoch/cursor but exposes only the lease in WS query', async () => {
    const fetchMock = leaseFetch()
    const socket = new GroupEventSocket()
    await socket.connect({
      epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cursor: 12,
      onEnvelope: () => undefined,
      onReset: () => undefined,
    })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(request).toBeDefined()
    expect(JSON.parse(String(request!.body))).toEqual({
      channel: 'groups', epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cursor: 12,
    })
    const url = new URL(FakeWebSocket.instances[0].url)
    expect([...url.searchParams.keys()]).toEqual(['lease'])
    socket.close()
  })
})

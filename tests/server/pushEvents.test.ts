// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../../src/server/config.js'
import { UpstreamServiceSession } from '../../src/server/localAuth.js'
import {
  ChatPushJobManager,
  ChatPushRelayObserver,
  HermesChatNotificationResolver,
  HermesChatPushJobWatcher,
  type ChatPushJob,
  type ChatPushObservation,
  type GroupPushCandidate,
  type GroupWatchAnchor,
  type GroupWatchReset,
  type PushEventCoordinator,
  type PushNotificationCandidate,
} from '../../src/server/pushEvents.js'
import { UpstreamClient } from '../../src/server/upstream.js'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

class FakeCoordinator implements PushEventCoordinator {
  observations: ChatPushObservation[] = []
  jobs = new Map<string, ChatPushJob>()
  notifications: PushNotificationCandidate[] = []
  anchor?: GroupWatchAnchor
  subscribers = new Map<string, string[]>()
  failEnqueue = false

  promptDigest(localUserID: string, prompt: string): string { return `${localUserID}:${prompt}` }
  canRecoverChatJob(job: ChatPushJob): boolean {
    const owners = new Set([...this.jobs.values()]
      .filter(candidate => candidate.storedSessionID === job.storedSessionID)
      .map(candidate => candidate.localUserID))
    return owners.size === 1 && owners.has(job.localUserID)
  }

  observeChat(observation: ChatPushObservation): void { this.observations.push(observation) }
  saveChatJob(job: ChatPushJob): void { this.jobs.set(job.id, { ...job }) }
  completeChatJob(jobID: string): void { this.jobs.delete(jobID) }
  pendingChatJobs(): readonly ChatPushJob[] { return [...this.jobs.values()] }
  enqueueNotification(candidate: PushNotificationCandidate): 'enqueued' | 'duplicate' {
    if (this.failEnqueue) throw new Error('outbox unavailable')
    if (this.notifications.some(item => item.localUserID === candidate.localUserID && item.eventID === candidate.eventID)) {
      return 'duplicate'
    }
    this.notifications.push(candidate)
    return 'enqueued'
  }
  groupWatchAnchor(): GroupWatchAnchor | undefined { return this.anchor && { ...this.anchor } }
  groupSubscribers(roomID: string): readonly string[] { return this.subscribers.get(roomID) ?? [] }
  advanceGroupCursor(anchor: GroupWatchAnchor): void { this.anchor = { ...anchor } }
  resetGroupCursor(reset: GroupWatchReset): GroupWatchAnchor {
    this.anchor = { epoch: reset.epoch, cursor: reset.cursor }
    return this.anchor
  }
}

describe('push event bridge', () => {
  it('persists an owned chat job and enqueues a terminal notification', async () => {
    const coordinator = new FakeCoordinator()
    const observer = new ChatPushRelayObserver(
      coordinator,
      { localUserID: 'user-a', accountKey: 'account-a', source: 'web', connectionID: 'connection-a' },
      () => 1_000,
      { resolveTerminal: async () => ({ title: '权威会话标题', body: '权威最终正文', confirmed: true }) },
    )
    await observer.observeClientFrame(JSON.stringify({
      jsonrpc: '2.0', id: 'resume', method: 'session.resume',
      params: { profile: 'default', session_id: 'stored-1' },
    }))
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 'resume', result: { session_id: 'runtime-1', stored_session_id: 'stored-1' },
    })), false)
    await observer.observeClientFrame(JSON.stringify({
      jsonrpc: '2.0', id: 'prompt', method: 'prompt.submit',
      params: { session_id: 'runtime-1', text: '执行任务' },
    }))
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 'prompt', result: { status: 'accepted' },
    })), false)
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
      jsonrpc: '2.0', method: 'event', params: {
        type: 'message.complete', session_id: 'runtime-1', profile: 'default',
        payload: { text: '中继正文', status: 'complete' },
      },
    })), false)
    await observer.flush()

    expect(coordinator.jobs.size).toBe(0)
    expect(coordinator.notifications).toEqual([
      expect.objectContaining({
        localUserID: 'user-a', kind: 'chat.completed', title: '权威会话标题', body: '权威最终正文',
        sessionID: 'stored-1', profile: 'default',
      }),
    ])
    expect(coordinator.observations.map(item => item.type)).toEqual([
      'chat.session_opened', 'chat.prompt', 'chat.prompt', 'chat.rpc_event',
    ])
  })

  it('keeps a chat job after disconnect and emits approval only once through durable dedupe', async () => {
    const coordinator = new FakeCoordinator()
    const observer = new ChatPushRelayObserver(
      coordinator,
      { localUserID: 'user-a', source: 'gateway' },
      () => 2_000,
      { resolveTerminal: async () => ({ correlated: true }) },
    )
    await observer.observeClientFrame(JSON.stringify({
      id: 'resume', method: 'session.resume', params: { profile: 'default', session_id: 'stored-2' },
    }))
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
      id: 'resume', result: { session_id: 'runtime-2', stored_session_id: 'stored-2' },
    })), false)
    await observer.observeClientFrame(JSON.stringify({
      id: 'prompt', method: 'prompt.submit', params: { session_id: 'runtime-2', text: '执行' },
    }))
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({ id: 'prompt', result: { status: 'accepted' } })), false)
    const approval = Buffer.from(JSON.stringify({
      method: 'event', params: {
        type: 'approval.requested', session_id: 'runtime-2',
        payload: { request_id: 'approval-1', message: '允许执行？' },
      },
    }))
    observer.observeUpstreamFrame(approval, false)
    observer.observeUpstreamFrame(approval, false)
    observer.disconnected()
    await observer.flush()

    expect(coordinator.jobs.size).toBe(1)
    expect(coordinator.notifications).toHaveLength(1)
    expect(coordinator.notifications[0]).toMatchObject({
      kind: 'chat.approval.requested', requestID: 'approval-1', body: '允许执行？',
    })
    expect(coordinator.observations.at(-1)).toMatchObject({ type: 'chat.disconnected' })
  })

  it('persists a submitted unknown-receipt job with an authoritative pre-submit baseline', async () => {
    const coordinator = new FakeCoordinator()
    const observer = new ChatPushRelayObserver(
      coordinator,
      { localUserID: 'user-a', source: 'gateway' },
      () => 5_000,
      {
        captureBaseline: async () => ({
          messageID: 'assistant-before', sequence: 8, total: 9, assistantCount: 4, lastRowSequence: 8,
        }),
        resolveTerminal: async () => ({}),
      },
    )
    await observer.observeClientFrame(JSON.stringify({
      id: 'resume', method: 'session.resume', params: { profile: 'default', session_id: 'stored-3' },
    }))
    observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
      id: 'resume', result: { session_id: 'runtime-3', stored_session_id: 'stored-3' },
    })), false)
    await observer.observeClientFrame(JSON.stringify({
      id: 'prompt-unknown', method: 'prompt.submit', params: { session_id: 'runtime-3', text: '可能已收到' },
    }))
    observer.disconnected()
    await observer.flush()

    expect([...coordinator.jobs.values()]).toEqual([
      expect.objectContaining({
        phase: 'submitted', storedSessionID: 'stored-3',
        metadata: expect.objectContaining({
          baselineCaptured: true, baselineMessageID: 'assistant-before', baselineSequence: 8,
          baselineTotal: 9, baselineAssistantCount: 4, baselineRowSequence: 8,
          promptDigest: 'user-a:可能已收到',
        }),
      }),
    ])
  })

  it('does not publish live terminal content when two local users own the same stored session', async () => {
    const coordinator = new FakeCoordinator()
    const makeObserver = async (user: string, runtime: string, prompt: string) => {
      const observer = new ChatPushRelayObserver(
        coordinator,
        { localUserID: user, source: 'gateway' },
        () => 10_000,
        { resolveTerminal: async () => ({ confirmed: false, correlated: false }) },
      )
      await observer.observeClientFrame(JSON.stringify({
        id: `resume-${user}`, method: 'session.resume', params: { profile: 'default', session_id: 'shared' },
      }))
      observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
        id: `resume-${user}`, result: { session_id: runtime, stored_session_id: 'shared' },
      })), false)
      await observer.observeClientFrame(JSON.stringify({
        id: `prompt-${user}`, method: 'prompt.submit', params: { session_id: runtime, text: prompt },
      }))
      observer.observeUpstreamFrame(Buffer.from(JSON.stringify({
        id: `prompt-${user}`, result: { status: 'accepted' },
      })), false)
      return observer
    }
    const first = await makeObserver('user-a', 'runtime-a', '任务 A')
    const second = await makeObserver('user-b', 'runtime-b', '任务 B')
    await first.flush()
    await second.flush()
    second.observeUpstreamFrame(Buffer.from(JSON.stringify({
      method: 'event', params: {
        type: 'message.complete', session_id: 'runtime-b', payload: { text: '不应泄漏的正文' },
      },
    })), false)
    await second.flush()
    expect(coordinator.notifications).toHaveLength(0)
  })

  it('resolves the authoritative latest assistant body from Hermes REST', async () => {
    let requested = ''
    const upstreamSession = {
      request: async (path: string, options?: { search?: URLSearchParams }) => {
        requested = `${path}?${options?.search?.toString()}`
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({
            session: { title: '会话标题' },
            messages: [
              { id: 'assistant-1', run_id: 'run-1', role: 'assistant', content: '较早回复', sequence: 1, created_at: 1 },
              { id: 'user-1', role: 'user', content: '问题', sequence: 2, created_at: 2 },
              { id: 'assistant-2', run_id: 'run-2', role: 'assistant', content: '最终权威回复', sequence: 3, created_at: 3 },
            ],
          })),
        }
      },
    } as unknown as UpstreamServiceSession
    const resolver = new HermesChatNotificationResolver(upstreamSession)
    const result = await resolver.resolveTerminal({
      id: 'job-1', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-1',
      storedSessionID: 'stored/a', requestID: 'prompt-1', queued: false, phase: 'accepted',
      submittedAt: 1, expiresAt: 2,
      metadata: {
        baselineCaptured: true, baselineMessageID: 'assistant-1', baselineSequence: 1,
        baselineAssistantCount: 1, baselineTotal: 2, runID: 'run-2',
      },
    }, 'run.completed', {})
    expect(result).toEqual({
      title: '会话标题', body: '最终权威回复', messageID: 'assistant-2', timestamp: 3_000,
      confirmed: true, correlated: true,
    })
    expect(requested).toContain('/api/sessions/stored%2Fa/messages?')
    expect(requested).toContain('order=latest')
    expect(requested).toContain('include_compacted=true')
    expect(requested).toContain('profile=default')
  })

  it('loads the title from the real Hermes session detail endpoint', async () => {
    const paths: string[] = []
    const upstream = {
      request: async (path: string) => {
        paths.push(path)
        return path.endsWith('/messages')
          ? {
              status: 200,
              body: Buffer.from(JSON.stringify({
                session_id: 'stored-real',
                messages: [{ id: 2, role: 'assistant', content: '真实正文', run_id: 'run-real' }],
                pagination: { total: 2 },
              })),
            }
          : { status: 200, body: Buffer.from('{"id":"stored-real","title":"真实会话标题"}') }
      },
    } as unknown as UpstreamServiceSession
    const resolved = await new HermesChatNotificationResolver(upstream).resolveTerminal({
      id: 'real-title', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime',
      storedSessionID: 'stored-real', requestID: 'prompt', queued: false, phase: 'accepted',
      submittedAt: 1, expiresAt: 60_000,
      metadata: {
        baselineCaptured: true, baselineSequence: 0, baselineMessageID: 'old',
        baselineAssistantCount: 0, baselineTotal: 1, runID: 'run-real',
      },
    }, 'run.completed', {})
    expect(resolved).toMatchObject({ title: '真实会话标题', body: '真实正文', confirmed: true })
    expect(paths).toEqual([
      '/api/sessions/stored-real/messages',
      '/api/sessions/stored-real',
    ])
  })

  it('does not confirm an old assistant when only a newer user message exists', async () => {
    const upstreamSession = {
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify({
          pagination: { total: 2 },
          messages: [
            { id: 'assistant-old', run_id: 'run-old', role: 'assistant', content: '旧回复', sequence: 1, timestamp: 1 },
            { id: 'user-new', role: 'user', content: '新问题', sequence: 2, timestamp: 2 },
          ],
        })),
      }),
    } as unknown as UpstreamServiceSession
    const resolver = new HermesChatNotificationResolver(upstreamSession)
    const resolved = await resolver.resolveTerminal({
      id: 'job-old-only', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-1',
      storedSessionID: 'stored-1', requestID: 'prompt-1', queued: false, phase: 'submitted',
      submittedAt: 2_000, expiresAt: 60_000,
      metadata: {
        baselineCaptured: true, baselineMessageID: 'assistant-old', baselineSequence: 1,
        baselineTotal: 1, baselineAssistantCount: 1, runID: 'run-new',
      },
    }, 'run.completed', {})
    expect(resolved.confirmed).toBe(false)
    expect(resolved.body).toBeUndefined()
  })

  it('does not attribute another user run in the same stored session', async () => {
    const upstreamSession = {
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify({
          messages: [
            { id: 'assistant-old', run_id: 'run-old', role: 'assistant', content: '旧回复', sequence: 1 },
            { id: 'assistant-a', run_id: 'run-user-a', role: 'assistant', content: '用户 A 的回复', sequence: 2 },
            { id: 'assistant-b', run_id: 'run-user-b', role: 'assistant', content: '用户 B 的回复', sequence: 3 },
          ],
        })),
      }),
    } as unknown as UpstreamServiceSession
    const resolver = new HermesChatNotificationResolver(upstreamSession)
    const common = {
      profile: 'default', runtimeSessionID: 'runtime', storedSessionID: 'shared-session',
      requestID: 'prompt', queued: false, phase: 'accepted' as const, submittedAt: 1, expiresAt: 60_000,
      metadata: {
        baselineCaptured: true, baselineMessageID: 'assistant-old', baselineSequence: 1,
        baselineAssistantCount: 1, baselineTotal: 1,
      },
    }
    const userA = await resolver.resolveTerminal({
      ...common, id: 'job-a', localUserID: 'user-a', metadata: { ...common.metadata, runID: 'run-user-a' },
    }, 'run.completed', {})
    const userB = await resolver.resolveTerminal({
      ...common, id: 'job-b', localUserID: 'user-b', metadata: { ...common.metadata, runID: 'run-user-b' },
    }, 'run.completed', {})
    const missing = await resolver.resolveTerminal({
      ...common, id: 'job-c', localUserID: 'user-c', metadata: { ...common.metadata, runID: 'run-user-c' },
    }, 'run.completed', {})
    expect(userA).toMatchObject({ confirmed: true, body: '用户 A 的回复' })
    expect(userB).toMatchObject({ confirmed: true, body: '用户 B 的回复' })
    expect(missing.confirmed).toBe(false)
  })

  it('recognizes an authoritative failed assistant record during recovery', async () => {
    const upstreamSession = {
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify({
          messages: [{
            id: 'assistant-failed', run_id: 'run-failed', role: 'assistant', status: 'failed',
            error: 'permission denied', sequence: 2,
          }],
        })),
      }),
    } as unknown as UpstreamServiceSession
    const resolved = await new HermesChatNotificationResolver(upstreamSession).resolveTerminal({
      id: 'job-failed', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime',
      storedSessionID: 'stored', requestID: 'prompt', queued: false, phase: 'accepted',
      submittedAt: 1, expiresAt: 60_000,
      metadata: {
        baselineCaptured: true, baselineAssistantCount: 0, baselineTotal: 0,
        baselineRowSequence: 0, runID: 'run-failed',
      },
    }, 'run.completed', {})
    expect(resolved).toMatchObject({
      confirmed: true, failed: true, error: 'permission denied', body: 'permission denied',
    })
  })

  it('correlates the real Hermes history shape by a private prompt digest without run IDs', async () => {
    const digest = async (userID: string, prompt: string) => `${userID}:${prompt}`
    let repeated = false
    const upstreamSession = {
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify({
          messages: [
            { id: 10, role: 'assistant', content: '旧回复' },
            { id: 11, role: 'user', content: '生成报告' },
            ...(repeated ? [{ id: 12, role: 'user', content: '生成报告' }] : []),
            { id: 13, role: 'assistant', content: '新报告' },
          ],
        })),
      }),
    } as unknown as UpstreamServiceSession
    const resolver = new HermesChatNotificationResolver(upstreamSession, digest)
    const job: ChatPushJob = {
      id: 'job-real-shape', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime',
      storedSessionID: 'stored', requestID: 'prompt', queued: false, phase: 'submitted',
      submittedAt: 1, expiresAt: 60_000,
      metadata: {
        baselineCaptured: true, baselineRowSequence: 10,
        promptDigest: await digest('user-a', '生成报告'),
      },
    }
    await expect(resolver.resolveTerminal(job, 'run.completed', {})).resolves.toMatchObject({
      confirmed: true, correlated: true, body: '新报告', messageID: '13',
    })
    repeated = true
    await expect(resolver.resolveTerminal(job, 'run.completed', {})).resolves.toMatchObject({
      confirmed: false, correlated: false,
    })
  })

  it('uses row zero as the recovery baseline for a new empty session', async () => {
    const upstream = {
      request: async () => ({ status: 200, body: Buffer.from('{"messages":[],"pagination":{"total":0}}') }),
    } as unknown as UpstreamServiceSession
    const baseline = await new HermesChatNotificationResolver(upstream).captureBaseline({
      id: 'empty', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime',
      storedSessionID: 'stored', requestID: 'prompt', queued: false, phase: 'submitted',
      submittedAt: 1, expiresAt: 60_000,
    })
    expect(baseline).toMatchObject({ total: 0, assistantCount: 0, lastRowSequence: 0 })
  })

  it('starts pending chat recovery immediately and enforces the socket cap', async () => {
    const coordinator = new FakeCoordinator()
    const now = Date.now()
    for (let index = 1; index <= 3; index += 1) {
      coordinator.saveChatJob({
        id: `job-${index}`, localUserID: 'user-a', profile: 'default',
        runtimeSessionID: `runtime-${index}`, storedSessionID: `stored-${index}`,
        requestID: `prompt-${index}`, queued: false, phase: index === 1 ? 'submitted' : 'accepted',
        metadata: {
          baselineCaptured: true, baselineTotal: 0, baselineAssistantCount: 0,
          runID: `run-${index}`, disconnectedAt: now,
        },
        submittedAt: now + index, expiresAt: now + 60_000,
      })
    }
    coordinator.saveChatJob({
      id: 'job-online', localUserID: 'user-a', profile: 'default',
      runtimeSessionID: 'runtime-online', storedSessionID: 'stored-online',
      requestID: 'prompt-online', queued: false, phase: 'accepted',
      submittedAt: now + 4, expiresAt: now + 60_000,
      metadata: { baselineCaptured: true, baselineRowSequence: 0, promptDigest: 'digest-online' },
    })
    coordinator.saveChatJob({
      id: 'job-submitted', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-submitted',
      storedSessionID: 'stored-submitted', requestID: 'prompt-submitted', queued: false, phase: 'submitted',
      submittedAt: now + 4, expiresAt: now + 60_000,
    })
    coordinator.saveChatJob({
      id: 'job-expired', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-expired',
      storedSessionID: 'stored-expired', requestID: 'prompt-expired', queued: false, phase: 'submitted',
      submittedAt: now - 60_000, expiresAt: now - 1,
    })
    let ticketRequests = 0
    const session = {
      webSocketCredential: () => {
        ticketRequests += 1
        return new Promise<never>(() => undefined)
      },
    } as unknown as UpstreamServiceSession
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home: '/tmp', mediaRoot: '/tmp/media', attachmentsRoot: '/tmp/attachments',
      imagesRoot: '/tmp/images', mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const manager = new ChatPushJobManager(config, session, coordinator, {
      maximumConcurrent: 2, reconcileMilliseconds: 60_000,
    })
    manager.start()
    await manager.reconcile()
    expect(ticketRequests).toBe(2)
    expect(coordinator.jobs.has('job-submitted')).toBe(true)
    expect(coordinator.jobs.has('job-expired')).toBe(false)

    coordinator.completeChatJob('job-1')
    await manager.reconcile()
    expect(ticketRequests).toBe(3)
    manager.stop()
  })

  it('does not push an uncorrelated terminal frame seen by a recovery watcher', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path === '/api/status') response.end('{"auth_required":true}')
      else if (path === '/api/auth/ws-ticket') response.end('{"ticket":"ownership-ticket"}')
      else response.end('{}')
    })
    const sockets = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (_request, socket, head) => {
      sockets.handleUpgrade(_request, socket, head, client => {
        client.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready', payload: {} } }))
        client.on('message', raw => {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>
          client.send(JSON.stringify({ id: frame.id, result: { session_id: 'runtime', running: true } }))
          setTimeout(() => client.send(JSON.stringify({
            method: 'event', params: {
              type: 'message.complete', session_id: 'runtime', payload: { text: '另一位用户的回复' },
            },
          })), 10)
        })
      })
    })
    const port = await listen(upstream)
    closers.push(async () => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      await closeServer(upstream)
    })
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL(`http://127.0.0.1:${port}`),
      allowedHosts: new Set(), home: '/tmp', mediaRoot: '/tmp/media', attachmentsRoot: '/tmp/attachments',
      imagesRoot: '/tmp/images', mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const session = new UpstreamServiceSession(new UpstreamClient(config.upstream), () => undefined)
    const coordinator = new FakeCoordinator()
    const job: ChatPushJob = {
      id: 'job-owned', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'old-runtime',
      storedSessionID: 'stored', requestID: 'prompt', queued: false, phase: 'accepted',
      submittedAt: Date.now(), expiresAt: Date.now() + 60_000,
      metadata: { baselineCaptured: true, baselineRowSequence: 1, promptDigest: 'user-a:我的任务' },
    }
    coordinator.saveChatJob(job)
    const watcher = new HermesChatPushJobWatcher(
      job,
      config,
      session,
      coordinator,
      { resolveTerminal: async () => ({ confirmed: false, correlated: false }) },
    )
    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    watcher.stop()
    expect(coordinator.notifications).toHaveLength(0)
    expect(coordinator.jobs.has(job.id)).toBe(true)
  })

  it('recovers a persisted chat job through ticket, resume, and authoritative REST', async () => {
    const rpcFrames: Array<Record<string, unknown>> = []
    const submittedAt = Date.now()
    let messageReads = 0
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/status') response.end(JSON.stringify({ auth_required: true }))
      else if (url.pathname === '/api/auth/me') response.end(JSON.stringify({ user_id: 'service' }))
      else if (url.pathname === '/api/auth/ws-ticket') response.end(JSON.stringify({ ticket: 'push-ticket' }))
      else if (url.pathname === '/api/sessions/stored-1/messages') {
        messageReads += 1
        response.end(JSON.stringify({
          session: { title: '恢复后的会话' },
          messages: [{
            id: messageReads === 1 ? 'old-assistant' : 'new-assistant',
            run_id: messageReads === 1 ? 'run-old' : 'run-recovery',
            role: 'assistant',
            content: messageReads === 1 ? '提交任务前的旧回复' : '后台恢复取得的最终正文',
            sequence: messageReads === 1 ? 2 : 3,
            created_at: (submittedAt + (messageReads === 1 ? -10_000 : 1_000)) / 1_000,
          }],
        }))
      } else {
        response.statusCode = 404
        response.end('{}')
      }
    })
    const sockets = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/api/ws' || url.searchParams.get('ticket') !== 'push-ticket') return socket.destroy()
      sockets.handleUpgrade(request, socket, head, client => {
        client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
        client.on('message', raw => {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>
          rpcFrames.push(frame)
          client.send(JSON.stringify({
            jsonrpc: '2.0', id: frame.id,
            result: { session_id: 'runtime-recovered', stored_session_id: 'stored-1', run_id: 'run-recovery', running: false },
          }))
        })
      })
    })
    const port = await listen(upstream)
    closers.push(async () => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      await closeServer(upstream)
    })
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL(`http://127.0.0.1:${port}`),
      allowedHosts: new Set(), home: '/tmp', mediaRoot: '/tmp/media', attachmentsRoot: '/tmp/attachments',
      imagesRoot: '/tmp/images', mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const session = new UpstreamServiceSession(new UpstreamClient(config.upstream), () => undefined)
    const coordinator = new FakeCoordinator()
    const job: ChatPushJob = {
      id: 'job-recovery', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-old',
      storedSessionID: 'stored-1', requestID: 'prompt-1', queued: false, phase: 'accepted',
      metadata: {
        baselineCaptured: true, baselineTotal: 2, baselineAssistantCount: 1,
        baselineMessageID: 'old-assistant', baselineSequence: 2, runID: 'run-recovery',
      },
      submittedAt, expiresAt: submittedAt + 60_000,
    }
    coordinator.saveChatJob(job)
    const watcher = new HermesChatPushJobWatcher(job, config, session, coordinator)
    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(coordinator.notifications).toHaveLength(0)
    expect(coordinator.jobs.has(job.id)).toBe(true)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('notification timeout')), 3_000)
      const poll = setInterval(() => {
        if (!coordinator.notifications.length) return
        clearTimeout(timeout)
        clearInterval(poll)
        resolve()
      }, 10)
    })
    watcher.stop()

    expect(rpcFrames.length).toBeGreaterThanOrEqual(2)
    expect(rpcFrames.every(frame => frame.method === 'session.resume')).toBe(true)
    expect(rpcFrames[0]).toMatchObject({
      params: { session_id: 'stored-1', profile: 'default', close_on_disconnect: false, omit_messages: true },
    })
    expect(coordinator.notifications[0]).toMatchObject({
      kind: 'chat.completed', title: '恢复后的会话', body: '后台恢复取得的最终正文', sessionID: 'stored-1',
    })
    expect(messageReads).toBeGreaterThanOrEqual(2)
    expect(coordinator.jobs.size).toBe(0)
  })
})

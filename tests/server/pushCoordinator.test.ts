import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { APNsRequest, APNsSendResult } from '../../src/server/apns.js'
import { loadServerConfig, type APNsProviderConfig } from '../../src/server/config.js'
import {
  PushCoordinator,
  type PushSender,
} from '../../src/server/pushCoordinator.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'yaoyao-push-'))
  roots.push(value)
  return value
}

const apns: APNsProviderConfig = {
  keyFile: '/private/not-read-when-provider-is-injected.p8',
  keyId: 'KEY1234567',
  teamId: 'TEAM123456',
  topic: 'cn.samien.yaoyao.hermes',
}

class FakeSender implements PushSender {
  readonly requests: APNsRequest[] = []
  readonly results: APNsSendResult[] = []
  closed = false

  async send(request: APNsRequest): Promise<APNsSendResult> {
    this.requests.push(request)
    return this.results.shift() ?? { disposition: 'success', status: 200 }
  }

  close(): void { this.closed = true }
}

function register(coordinator: PushCoordinator, suffix = '1') {
  return coordinator.registerInstallation({
    userId: 'user-a',
    installationId: `phone-${suffix}`,
    clientAccountId: 'account-a',
    deviceToken: 'ab'.repeat(16 + Number(suffix)),
    environment: 'development',
    appVersion: '1.2.3',
  })
}

describe('push configuration', () => {
  it('keeps APNs optional and reports partial configuration without preventing startup', () => {
    expect(loadServerConfig({}).apns).toBeUndefined()
    const partial = loadServerConfig({ HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567' })
    expect(partial.apns).toBeUndefined()
    expect(partial.apnsConfigurationError).toMatch(/must be set together/)
  })

  it('loads a complete provider configuration and the default topic', () => {
    const directory = root()
    const keyFile = join(directory, 'AuthKey.p8')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const config = loadServerConfig({
      HERMES_YAOYAO_APNS_KEY_FILE: keyFile,
      HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567',
      HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123456',
    })
    expect(config.apns).toEqual({
      keyFile,
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      topic: 'cn.samien.yaoyao.hermes',
    })
  })

  it('disables an unreadable provider key as a capability error', () => {
    const keyFile = join(root(), 'AuthKey.p8')
    writeFileSync(keyFile, 'not a private key')
    const config = loadServerConfig({
      HERMES_YAOYAO_APNS_KEY_FILE: keyFile,
      HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567',
      HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123456',
    })
    expect(config.apns).toBeUndefined()
    expect(config.apnsConfigurationError).toMatch(/ES256 private key/)
  })
})

describe('PushCoordinator durable state and delivery', () => {
  it('persists private registrations, subscriptions, outbox delivery, and badge state', async () => {
    const home = root()
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home, apns, provider: sender, autoFlush: false })
    expect(coordinator.capabilities()).toMatchObject({
      protocolVersion: 1, enabled: true, topic: apns.topic, maxSummaryCharacters: 180,
    })
    expect(register(coordinator)).not.toHaveProperty('deviceToken')
    expect(coordinator.setGroupSubscription('user-a', 'room-1', true)).toMatchObject({ roomId: 'room-1', enabled: true })
    expect(coordinator.isGroupSubscribed('user-a', 'room-1')).toBe(true)
    expect(coordinator.subscribedUserIds('room-1')).toEqual(['user-a'])

    expect(coordinator.enqueue({
      eventId: 'event-1',
      userId: 'user-a',
      kind: 'group.message.completed',
      title: '任务完成',
      body: '好'.repeat(250),
      roomId: 'room-1',
      threadId: 'topic-1',
      collapseId: 'message-1',
      data: { roomId: 'room-1', aps: 'untrusted', version: 99 },
    })).toBe(1)
    expect(coordinator.enqueue({
      eventId: 'event-1', userId: 'user-a', kind: 'group.message.completed', title: '重复', body: '重复',
    })).toBe(0)
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 1, topic: apns.topic })

    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1 })
    expect(sender.requests).toHaveLength(1)
    expect(sender.requests[0]!.payload).toMatchObject({
      version: 1,
      eventId: 'event-1',
      kind: 'group.message.completed',
      clientAccountId: 'account-a',
      aps: { alert: { title: '任务完成' }, badge: 1, 'thread-id': 'topic-1' },
    })
    expect(Array.from(((sender.requests[0]!.payload.aps as { alert: { body: string } }).alert.body))).toHaveLength(180)
    expect(sender.requests[0]!.payload).not.toHaveProperty('userId')
    expect(coordinator.status()).toMatchObject({ healthy: true, pendingCount: 0 })

    const statePath = join(home, 'push', 'state.json')
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    const stored = readFileSync(statePath, 'utf8')
    expect(stored).toContain('ab'.repeat(17))
    expect(stored).not.toContain(apns.keyFile)
    coordinator.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.status()).toMatchObject({ registrationCount: 1, subscriptionCount: 1 })
    expect(restored.listGroupSubscriptions('user-a')).toEqual([
      expect.objectContaining({ roomId: 'room-1', enabled: true }),
    ])
    restored.close()
  })

  it('retries transient failures exponentially and removes invalid registrations', async () => {
    const home = root()
    let now = 1_000_000
    const sender = new FakeSender()
    sender.results.push(
      { disposition: 'retry', status: 503, reason: 'Shutdown' },
      { disposition: 'unregister', status: 410, reason: 'Unregistered' },
    )
    const coordinator = new PushCoordinator({
      home, apns, provider: sender, autoFlush: false, now: () => now, baseRetryMilliseconds: 100,
    })
    register(coordinator)
    coordinator.enqueue({ eventId: 'retry-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })

    await expect(coordinator.flushDue()).resolves.toMatchObject({ retried: 1 })
    expect(coordinator.status()).toMatchObject({ pendingCount: 1, healthy: false })
    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 0, retried: 0 })
    expect(sender.requests).toHaveLength(1)
    now += 100
    await expect(coordinator.flushDue()).resolves.toMatchObject({ removedRegistrations: 1 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, pendingCount: 0 })
    coordinator.close()
  })

  it('does not delete a token that rotated while an APNs request was in flight', async () => {
    let release!: (result: APNsSendResult) => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const first = new Promise<APNsSendResult>(resolve => { release = resolve })
    const requests: APNsRequest[] = []
    const sender: PushSender = {
      send: async request => {
        requests.push(request)
        if (requests.length === 1) {
          started()
          return first
        }
        return { disposition: 'success', status: 200 }
      },
    }
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender, autoFlush: false })
    register(coordinator)
    coordinator.enqueue({ eventId: 'rotated-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })

    const flushing = coordinator.flushDue()
    await began
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-1', clientAccountId: 'account-a',
      deviceToken: 'cd'.repeat(32), environment: 'development', appVersion: '1.2.4',
    })
    release({ disposition: 'unregister', status: 410, reason: 'Unregistered' })
    await expect(flushing).resolves.toMatchObject({ retried: 1, removedRegistrations: 0 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 1, pendingCount: 1 })
    await expect(coordinator.flushDue()).resolves.toMatchObject({ delivered: 1 })
    expect(requests[0]!.deviceToken).not.toBe(requests[1]!.deviceToken)
    expect(requests[1]!.deviceToken).toBe('cd'.repeat(32))
    coordinator.close()
  })

  it('fails closed when a user is disabled or their authentication version changes', async () => {
    let active = true
    let authVersion = 1
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({
      home: root(), apns, provider: sender, autoFlush: false,
      isUserActive: () => active,
      userAuthorizationVersion: () => authVersion,
    })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development', authorizationVersion: 1,
    })
    coordinator.enqueue({ eventId: 'version-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })
    authVersion = 2
    await expect(coordinator.flushDue()).resolves.toMatchObject({ failed: 1, delivered: 0 })
    expect(sender.requests).toHaveLength(0)
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, pendingCount: 0 })

    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'cd'.repeat(32), environment: 'development', authorizationVersion: 2,
    })
    active = false
    expect(coordinator.enqueue({
      eventId: 'disabled', userId: 'user-a', kind: 'chat.completed', title: '不应发送', body: '正文',
    })).toBe(0)
    coordinator.close()
  })

  it('cancels pending team notifications on unsubscribe and removes all user-owned state', () => {
    const home = root()
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    register(coordinator)
    coordinator.setGroupSubscription('user-a', 'room-1', true)
    expect(coordinator.enqueueGroupEvent({
      eventID: 'group-1', localUserID: 'user-a', kind: 'group.message.completed',
      title: '团队消息', body: '正文', collapseID: 'group-1', data: {}, roomID: 'room-1',
    })).toBe('enqueued')
    coordinator.setGroupSubscription('user-a', 'room-1', false)
    expect(coordinator.status().pendingCount).toBe(0)

    coordinator.setGroupSubscription('user-a', 'room-2', true)
    const removed = coordinator.removeUser('user-a')
    expect(removed).toMatchObject({ registrations: 1, subscriptions: 1 })
    expect(coordinator.status()).toMatchObject({ registrationCount: 0, subscriptionCount: 0 })
    expect(coordinator.listGroupSubscriptions('user-a')).toEqual([])
    coordinator.close()
  })

  it('persists the global group cursor and resumable chat jobs in the same state file', () => {
    const home = root()
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(coordinator.resetGroupCursor({ epoch: 'epoch-1', cursor: 10, reason: 'initial' })).toMatchObject({
      epoch: 'epoch-1', cursor: 10,
    })
    coordinator.advanceGroupCursor({ epoch: 'epoch-1', cursor: 11 })
    expect(() => coordinator.advanceGroupCursor({ epoch: 'epoch-1', cursor: 9 })).toThrow(/backwards/)
    coordinator.saveChatJob({
      id: 'job-1', localUserID: 'user-a', profile: 'default', runtimeSessionID: 'runtime-1',
      storedSessionID: 'stored-1', requestID: 'request-1', queued: false, phase: 'watching',
      submittedAt: 1, expiresAt: Date.now() + 60_000,
    })
    coordinator.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.groupWatchAnchor()).toMatchObject({ epoch: 'epoch-1', cursor: 11 })
    expect(restored.pendingChatJobs()).toEqual([expect.objectContaining({ id: 'job-1', localUserID: 'user-a' })])
    restored.completeChatJob('job-1')
    expect(restored.pendingChatJobs()).toEqual([])
    restored.close()
  })

  it('fails closed when more than one local user has written the same stored session', () => {
    const coordinator = new PushCoordinator({ home: root(), apns, provider: new FakeSender(), autoFlush: false })
    const job = (id: string, localUserID: string) => ({
      id, localUserID, profile: 'default', runtimeSessionID: `runtime-${id}`, storedSessionID: 'shared',
      requestID: `request-${id}`, queued: false, phase: 'accepted' as const,
      submittedAt: 1, expiresAt: Date.now() + 60_000,
    })
    const first = job('a', 'user-a')
    coordinator.saveChatJob(first)
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(true)
    const second = job('b', 'user-b')
    coordinator.saveChatJob(second)
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(false)
    expect(coordinator.chatJobRecoveryAllowed(second)).toBe(false)
    coordinator.completeChatJob('b')
    expect(coordinator.chatJobRecoveryAllowed(first)).toBe(false)
    coordinator.close()
  })

  it('keeps prompt correlation private and stable across restart', () => {
    const home = root()
    const first = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    const digest = first.promptDigest('user-a', '继续执行')
    expect(digest).not.toContain('继续执行')
    expect(first.promptDigest('user-b', '继续执行')).not.toBe(digest)
    first.close()

    const restored = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })
    expect(restored.promptDigest('user-a', '继续执行')).toBe(digest)
    expect(statSync(join(home, 'push', 'correlation.key')).mode & 0o777).toBe(0o600)
    restored.close()
  })

  it('automatically flushes newly queued work and closes the injected provider', async () => {
    const sender = new FakeSender()
    const coordinator = new PushCoordinator({ home: root(), apns, provider: sender })
    register(coordinator)
    coordinator.enqueue({ eventId: 'auto-1', userId: 'user-a', kind: 'chat.completed', title: '完成', body: '正文' })
    await expect.poll(() => sender.requests.length).toBe(1)
    expect(coordinator.status().pendingCount).toBe(0)
    coordinator.close()
    expect(sender.closed).toBe(true)
  })

  it('protects and preserves a malformed existing state file instead of overwriting it', () => {
    const home = root()
    const directory = join(home, 'push')
    const statePath = join(directory, 'state.json')
    mkdirSync(directory)
    writeFileSync(statePath, '{malformed', { mode: 0o644, flag: 'w' })
    const coordinator = new PushCoordinator({ home, apns, provider: new FakeSender(), autoFlush: false })

    expect(coordinator.capabilities()).toMatchObject({ enabled: false })
    expect(coordinator.status().lastError).toMatch(/避免覆盖/)
    expect(() => register(coordinator)).toThrow(/推送状态文件无法读取/)
    expect(readFileSync(statePath, 'utf8')).toBe('{malformed')
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    coordinator.close()
  })
})

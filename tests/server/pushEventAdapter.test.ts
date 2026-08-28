import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { APNsRequest } from '../../src/server/apns.js'
import type { APNsProviderConfig } from '../../src/server/config.js'
import type { UpstreamServiceSession } from '../../src/server/localAuth.js'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'
import { PushCoordinatorEventAdapter } from '../../src/server/pushEventAdapter.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('push event reset reconciliation', () => {
  it('recovers only post-subscription terminal messages and pending interactions before advancing cursor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-reconcile-'))
    roots.push(home)
    let now = 1_000_000
    const requests: APNsRequest[] = []
    const apns: APNsProviderConfig = {
      keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes',
    }
    const push = new PushCoordinator({
      home, apns, autoFlush: false, now: () => now,
      provider: { send: async request => { requests.push(request); return { disposition: 'success', status: 200 } } },
    })
    push.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development',
    })
    push.setGroupSubscription('user-a', 'room-1', true, 1)
    now += 10_000

    const upstreamSession = {
      request: async (path: string) => {
        if (path.endsWith('/messages')) {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ items: [
              { id: 'old-message', seq: 1, senderKind: 'agent', senderName: '旧 Agent', status: 'completed', content: '旧消息', updatedAt: 900 },
              { id: 'new-message', seq: 2, topicId: 'topic-1', senderKind: 'agent', senderName: '新 Agent', status: 'completed', content: '断线期间回复', updatedAt: 1_005 },
            ] })),
          }
        }
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({
            room: {
              id: 'room-1', name: '项目团队',
              pendingInteractions: [{
                id: 'interaction-1', kind: 'clarification', status: 'pending', topicId: 'topic-1',
                updatedAt: 1_006, payload: { question: '请选择方案' },
              }],
            },
          })),
        }
      },
    } as unknown as UpstreamServiceSession
    const adapter = new PushCoordinatorEventAdapter(push, upstreamSession)

    await expect(adapter.resetGroupCursor({
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 42, reason: 'cursor_expired',
    })).resolves.toEqual({ epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 42 })
    expect(push.status().pendingCount).toBe(2)
    await expect(push.flushDue()).resolves.toMatchObject({ delivered: 2 })
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'group-message:new-message:completed', roomId: 'room-1', messageId: 'new-message' }),
      expect.objectContaining({ eventId: 'group-interaction:interaction-1', roomId: 'room-1', interactionId: 'interaction-1' }),
    ]))
    expect(JSON.stringify(requests)).not.toContain('old-message')

    await adapter.resetGroupCursor({
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 43, reason: 'cursor_expired',
    })
    expect(push.status().pendingCount).toBe(0)
    push.close()
  })

  it('ignores a lagged live event older than the current subscription', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-lagged-'))
    roots.push(home)
    let now = 2_000_000
    const apns: APNsProviderConfig = {
      keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes',
    }
    const push = new PushCoordinator({
      home, apns, autoFlush: false, now: () => now,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
    })
    push.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development',
    })
    push.setGroupSubscription('user-a', 'room-1', true)
    const adapter = new PushCoordinatorEventAdapter(push, {} as UpstreamServiceSession)

    expect(adapter.enqueueNotification({
      eventID: 'group-message:old:completed', localUserID: 'user-a', kind: 'group.message.completed',
      title: '旧消息', body: '旧消息', collapseID: 'old', data: {}, roomID: 'room-1',
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 1, occurredAt: now - 10_000,
    })).toBe('ignored')
    expect(push.status().pendingCount).toBe(0)
    now += 10_000
    expect(adapter.enqueueNotification({
      eventID: 'group-message:new:completed', localUserID: 'user-a', kind: 'group.message.completed',
      title: '新消息', body: '新消息', collapseID: 'new', data: {}, roomID: 'room-1',
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 2, occurredAt: now,
    })).toBe('enqueued')
    push.close()
  })

  it('drops a deleted room subscription instead of wedging the global reset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-deleted-room-'))
    roots.push(home)
    const apns: APNsProviderConfig = {
      keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes',
    }
    const push = new PushCoordinator({
      home, apns, autoFlush: false,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
    })
    push.setGroupSubscription('user-a', 'deleted-room', true, 9)
    const upstream = {
      request: async () => ({ status: 404, body: Buffer.from('{}') }),
    } as unknown as UpstreamServiceSession
    const adapter = new PushCoordinatorEventAdapter(push, upstream)

    await expect(adapter.resetGroupCursor({
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 10, reason: 'epoch_mismatch',
    })).resolves.toMatchObject({ cursor: 10 })
    expect(push.listGroupSubscriptions('user-a')).toEqual([])
    push.close()
  })

  it('walks backward from the latest page when a room baseline is zero', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-zero-baseline-'))
    roots.push(home)
    const apns: APNsProviderConfig = {
      keyFile: join(home, 'unused.p8'), keyId: 'KEY123', teamId: 'TEAM123', topic: 'cn.samien.yaoyao.hermes',
    }
    const push = new PushCoordinator({
      home, apns, autoFlush: false,
      provider: { send: async () => ({ disposition: 'success', status: 200 }) },
    })
    push.setGroupSubscription('user-a', 'room-zero', true, 0)
    const searches: string[] = []
    const message = (seq: number) => ({
      id: `message-${seq}`, seq, senderKind: 'agent', senderName: 'Agent', status: 'completed', content: `消息 ${seq}`,
    })
    const upstream = {
      request: async (path: string, options?: { search?: URLSearchParams }) => {
        if (!path.endsWith('/messages')) {
          return { status: 200, body: Buffer.from('{"room":{"id":"room-zero","name":"零基线团队"}}') }
        }
        const search = options?.search?.toString() ?? ''
        searches.push(search)
        const before = Number(options?.search?.get('beforeSeq') ?? 0)
        const items = before === 51
          ? Array.from({ length: 50 }, (_, index) => message(index + 1))
          : Array.from({ length: 100 }, (_, index) => message(index + 51))
        return { status: 200, body: Buffer.from(JSON.stringify({ items })) }
      },
    } as unknown as UpstreamServiceSession
    const adapter = new PushCoordinatorEventAdapter(push, upstream)

    await adapter.resetGroupCursor({
      epoch: '123e4567-e89b-42d3-a456-426614174000', cursor: 150, reason: 'cursor_expired',
    })
    expect(searches).toEqual(['limit=100', 'limit=100&beforeSeq=51'])
    expect(push.listGroupSubscriptions('user-a')[0]?.lastMessageSeq).toBe(150)
    push.close()
  })
})

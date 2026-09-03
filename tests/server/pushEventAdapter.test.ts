import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'
import { PushCoordinatorEventAdapter } from '../../src/server/pushEventAdapter.js'
import type { APNsRequest } from '../../src/server/apns.js'
const roots: string[] = []
afterEach(() => {
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-web-push-'))
  roots.push(home)
  const requests: APNsRequest[] = []
  const push = new PushCoordinator({
    home,
    autoFlush: false,
    apns: {
      keyFile: join(home, 'unused.p8'),
      keyId: 'KEY123',
      teamId: 'TEAM123',
      topic: 'cn.samien.yaoyao.hermes',
    },
    provider: {
      send: async (request) => {
        requests.push(request)
        return { disposition: 'success', status: 200 }
      },
    },
  })
  push.registerInstallation({
    userId: 'owner',
    installationId: 'phone',
    clientAccountId: 'account',
    deviceToken: 'ab'.repeat(32),
    environment: 'development',
  })
  return { push, requests, adapter: new PushCoordinatorEventAdapter(push) }
}
describe('Web-owned push delivery', () => {
  it('deduplicates workspace completion notifications and retains application navigation', async () => {
    const { push, requests, adapter } = fixture()
    push.setGroupSubscription('owner', 'room', true, 0)
    const candidate = {
      kind: 'group.message.completed' as const,
      eventID: 'workspace:run',
      localUserID: 'owner',
      roomID: 'room',
      title: '团队',
      body: '已完成',
      collapseID: 'workspace:room',
      data: { workspace: '1', conversationId: 'room' },
    }
    expect(adapter.enqueueNotification(candidate)).toBe('enqueued')
    expect(adapter.enqueueNotification(candidate)).toBe('duplicate')
    await push.flushDue()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.payload).toMatchObject({ workspace: '1', conversationId: 'room' })
    push.close()
  })
  it('does not deliver group events to an unsubscribed account', () => {
    const { push, adapter } = fixture()
    expect(
      adapter.enqueueNotification({
        kind: 'group.message.completed',
        eventID: 'workspace:run',
        localUserID: 'owner',
        roomID: 'other-room',
        title: '团队',
        body: '结果',
        collapseID: 'workspace:other',
        data: { conversationId: 'other-room' },
      }),
    ).toBe('ignored')
    expect(push.status().pendingCount).toBe(0)
    push.close()
  })
})

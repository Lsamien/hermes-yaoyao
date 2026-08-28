import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getGroupPushSubscriptions,
  getPushCapabilities,
  getPushSystemStatus,
  setGroupPushSubscription,
} from '@/api/push'
import { clearApiSecurityContext, setApiCsrfToken } from '@/api/client'

afterEach(() => {
  clearApiSecurityContext()
  vi.unstubAllGlobals()
})

describe('push client protocol', () => {
  it('uses the versioned push API and protects subscription mutations', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      const payload = path === '/api/app/push/v1/capabilities'
        ? { protocolVersion: 1, enabled: true, events: [], maximumSummaryCharacters: 180 }
        : path === '/api/app/push/v1/group-subscriptions'
          ? { subscriptions: [{ roomId: 'room-1', enabled: true }] }
          : path === '/api/app/system/push-status'
            ? { configured: true, healthy: true, registrationCount: 1, pendingCount: 0 }
            : { subscription: { roomId: 'room-1', enabled: false } }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    setApiCsrfToken('csrf-push')

    await expect(getPushCapabilities()).resolves.toMatchObject({ protocolVersion: 1, enabled: true })
    await expect(getGroupPushSubscriptions()).resolves.toEqual(new Set(['room-1']))
    await expect(setGroupPushSubscription('room-1', false)).resolves.toBe(false)
    await expect(getPushSystemStatus()).resolves.toMatchObject({ configured: true, registrationCount: 1 })

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/push/v1/capabilities',
      '/api/app/push/v1/group-subscriptions',
      '/api/app/push/v1/group-subscriptions/room-1',
      '/api/app/system/push-status',
    ])
    expect(new Headers(calls[2]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-push')
  })
})

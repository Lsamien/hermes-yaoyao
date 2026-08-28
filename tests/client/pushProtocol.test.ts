import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getGroupPushSubscriptions,
  getPushCapabilities,
  getPushSystemStatus,
  savePushSystemConfig,
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
            ? {
                configured: true,
                healthy: true,
                registration_count: 1,
                pending_count: 0,
                source: 'file',
                editable: true,
                key_file: '/srv/secrets/AuthKey_TEST.p8',
                key_id: 'KEY123',
                team_id: 'TEAM123',
                environments: ['development', 'production'],
                warnings: [{ code: 'apns_key_permissions', message: '建议调整为 0600', actual_mode: '0644', recommended_mode: '0600' }],
              }
            : path === '/api/app/system/push-config'
              ? {
                  configured: true,
                  healthy: true,
                  registrationCount: 1,
                  pendingCount: 0,
                  source: 'file',
                  editable: true,
                  keyFile: '/srv/secrets/AuthKey_TEST.p8',
                  keyId: 'KEY123',
                  teamId: 'TEAM123',
                  topic: 'cn.samien.yaoyao.hermes',
                  environments: ['development', 'production'],
                  warnings: [],
                }
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
    await expect(getPushSystemStatus()).resolves.toMatchObject({
      configured: true,
      registrationCount: 1,
      source: 'file',
      editable: true,
      managementAvailable: true,
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      environments: ['development', 'production'],
      warnings: [{ code: 'apns_key_permissions', actualMode: '0644', recommendedMode: '0600' }],
    })
    await expect(savePushSystemConfig({
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      topic: 'cn.samien.yaoyao.hermes',
      environments: ['development', 'production'],
    })).resolves.toMatchObject({ configured: true, source: 'file', editable: true })

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/push/v1/capabilities',
      '/api/app/push/v1/group-subscriptions',
      '/api/app/push/v1/group-subscriptions/room-1',
      '/api/app/system/push-status',
      '/api/app/system/push-config',
    ])
    expect(new Headers(calls[2]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-push')
    expect(new Headers(calls[4]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-push')
    expect(calls[4]!.init?.body).toBe(JSON.stringify({
      keyFile: '/srv/secrets/AuthKey_TEST.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      topic: 'cn.samien.yaoyao.hermes',
      environments: ['development', 'production'],
    }))
  })

  it('keeps an old status response read-only instead of guessing its configuration source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      configured: true,
      healthy: true,
      registrationCount: 2,
      pendingCount: 0,
      topic: 'cn.samien.yaoyao.hermes',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(getPushSystemStatus()).resolves.toMatchObject({
      configured: true,
      source: 'none',
      editable: false,
      managementAvailable: false,
      environments: [],
      warnings: [],
    })
  })

  it('normalizes startup configuration errors as the visible push error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      configured: false,
      healthy: false,
      source: 'environment',
      editable: false,
      configuration_error: 'APNs key is invalid',
      registration_count: 1,
      pending_count: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(getPushSystemStatus()).resolves.toMatchObject({
      configured: false,
      source: 'environment',
      lastError: 'APNs key is invalid',
    })
  })
})

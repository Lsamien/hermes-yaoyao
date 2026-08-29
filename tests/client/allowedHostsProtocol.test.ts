import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAllowedHostsSettings, saveAllowedHostsSettings } from '@/api/admin'
import { clearApiSecurityContext, setApiCsrfToken } from '@/api/client'

afterEach(() => {
  clearApiSecurityContext()
  vi.unstubAllGlobals()
})

describe('allowed hosts client protocol', () => {
  it('reads and saves domains and IP addresses inside the protected system API', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return new Response(JSON.stringify({
        source: 'file',
        hosts: ['127.0.0.1', '203.0.113.10', 'yaoyao.example.com'],
        editableHosts: ['203.0.113.10', 'yaoyao.example.com'],
        environmentHosts: ['127.0.0.1'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    setApiCsrfToken('csrf-allowed-hosts')

    await expect(getAllowedHostsSettings()).resolves.toMatchObject({ source: 'file' })
    await expect(saveAllowedHostsSettings(['yaoyao.example.com', '203.0.113.10']))
      .resolves.toMatchObject({ editableHosts: ['203.0.113.10', 'yaoyao.example.com'] })

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/system/allowed-hosts',
      '/api/app/system/allowed-hosts',
    ])
    expect(new Headers(calls[1]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-allowed-hosts')
    expect(calls[1]!.init?.body).toBe(JSON.stringify({
      hosts: ['yaoyao.example.com', '203.0.113.10'],
    }))
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrap, login } from '@/api/auth'
import {
  apiRequest,
  clearApiSecurityContext,
  onApiUnauthorized,
  setApiCsrfToken,
} from '@/api/client'

afterEach(() => {
  clearApiSecurityContext()
  vi.unstubAllGlobals()
})

describe('authentication and CSRF protocol', () => {
  it('keeps credentials in cookies and forwards the bootstrap CSRF token on login', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const body = path.endsWith('/bootstrap')
        ? { authRequired: true, authenticated: false, profiles: [], csrfToken: 'csrf-from-bootstrap' }
        : {
            authRequired: true,
            authenticated: true,
            user: { user_id: 'user-1', display_name: '夭夭' },
            profiles: [{ name: 'yaoyao', is_default: true }],
            csrfToken: 'csrf-after-login',
          }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const initial = await bootstrap()
    expect(initial.user).toBeUndefined()
    const authenticated = await login({ username: 'name', password: 'secret' })
    expect(authenticated.user).toMatchObject({ id: 'user-1', username: '夭夭' })
    const loginInit = fetchMock.mock.calls[1][1]!
    expect(loginInit.credentials).toBe('include')
    expect(new Headers(loginInit.headers).get('X-CSRF-Token')).toBe('csrf-from-bootstrap')
  })

  it('keeps the CSRF context after a rejected password so login can be retried', async () => {
    let loginAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path.endsWith('/bootstrap')) {
        return new Response(JSON.stringify({ authRequired: true, profiles: [], csrfToken: 'retry-token' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      loginAttempts += 1
      if (loginAttempts === 1) {
        return new Response(JSON.stringify({ error: 'Invalid credentials', code: 'login_failed' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('retry-token')
      return new Response(JSON.stringify({
        authRequired: true,
        user: { user_id: 'user-1', display_name: '夭夭' },
        profiles: [{ name: 'yaoyao', is_default: true }],
        csrfToken: 'after-retry',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await bootstrap()
    await expect(login({ username: 'name', password: 'wrong' })).rejects.toMatchObject({ status: 401 })
    await expect(login({ username: 'name', password: 'correct' })).resolves.toMatchObject({ user: { id: 'user-1' } })
  })

  it('keeps the login session for an authenticated 403 permission error', async () => {
    let expirations = 0
    const unsubscribe = onApiUnauthorized(() => { expirations += 1 })
    setApiCsrfToken('csrf-permission')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: '系统升级默认只允许在本机执行',
      code: 'remote_system_update_disabled',
    }), { status: 403, headers: { 'content-type': 'application/json' } })))
    try {
      await expect(apiRequest('/api/app/system/update/apply', {
        method: 'POST',
        body: { targetVersion: '0.3.0' },
      })).rejects.toMatchObject({
        status: 403,
        code: 'remote_system_update_disabled',
        message: '系统升级默认只允许在本机执行',
      })
      expect(expirations).toBe(0)
    } finally {
      unsubscribe()
    }
  })
})

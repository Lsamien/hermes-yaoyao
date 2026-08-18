import { randomBytes } from 'node:crypto'
import type Koa from 'koa'
import { describe, expect, it } from 'vitest'
import { loadServerConfig, type ServerConfig } from '../../src/server/config.js'
import {
  CsrfProtection,
  isAllowedHostHeader,
  isExactOrigin,
  applySecurityHeaders,
} from '../../src/server/security.js'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 8800,
    upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(),
    home: '/tmp/hermes-yaoyao-test',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
    ...overrides,
  }
}

describe('server security boundary', () => {
  it('accepts loopback/private hosts and configured DNS only', () => {
    const value = config({ allowedHosts: new Set(['yaoyao.internal']) })
    expect(isAllowedHostHeader('127.0.0.1:8800', value)).toBe(true)
    expect(isAllowedHostHeader('[::1]:8800', value)).toBe(true)
    expect(isAllowedHostHeader('192.168.10.8:8800', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao.internal:8800', value)).toBe(true)
    expect(isAllowedHostHeader('127.0.0.1:9999', value)).toBe(false)
    expect(isAllowedHostHeader('127.0.0.1', value)).toBe(true)
    expect(isAllowedHostHeader('192.168.10.8:443', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao.internal', value)).toBe(true)
    expect(isAllowedHostHeader('attacker.example:8800', value)).toBe(false)
    expect(isAllowedHostHeader('127.0.0.1@attacker.example', value)).toBe(false)
  })

  it('accepts the configured production reverse-proxy domain on public ports', () => {
    const value = config({ allowedHosts: new Set(['yaoyao-lc.samien.cn']) })
    expect(isAllowedHostHeader('yaoyao-lc.samien.cn', value)).toBe(true)
    expect(isAllowedHostHeader('yaoyao-lc.samien.cn:443', value)).toBe(true)
    expect(isAllowedHostHeader('other.samien.cn', value)).toBe(false)
  })

  it('accepts an HTTPS browser Origin behind an HTTP TLS-terminating proxy', () => {
    expect(isExactOrigin('https://yaoyao.internal', 'yaoyao.internal', false)).toBe(true)
    expect(isExactOrigin('https://attacker.example', 'yaoyao.internal', false)).toBe(false)
  })

  it('accepts a configured public Origin when the reverse proxy rewrites Host internally', () => {
    const allowed = new Set(['yaoyao-lc.samien.cn'])
    expect(isExactOrigin('http://yaoyao-lc.samien.cn', '10.1.5.100', false, allowed)).toBe(true)
    expect(isExactOrigin('http://attacker.example', '10.1.5.100', false, allowed)).toBe(false)
  })

  it('adds configured reverse-proxy domains to the WebSocket CSP', () => {
    const headers: Record<string, string> = {}
    const ctx = { host: '10.1.5.100', set(name: string, value: string) { headers[name] = value } } as unknown as Koa.Context
    applySecurityHeaders(ctx, false, new Set(['yaoyao-lc.samien.cn']))
    expect(headers['Content-Security-Policy']).toContain('ws://yaoyao-lc.samien.cn')
    expect(headers['Content-Security-Policy']).toContain('wss://yaoyao-lc.samien.cn')
  })

  it('requires an exact scheme and host Origin', () => {
    expect(isExactOrigin('http://127.0.0.1:8800', '127.0.0.1:8800', false)).toBe(true)
    expect(isExactOrigin('https://127.0.0.1:8800', '127.0.0.1:8800', false)).toBe(true)
    expect(isExactOrigin('http://127.0.0.1:8801', '127.0.0.1:8800', false)).toBe(false)
    expect(isExactOrigin('null', '127.0.0.1:8800', false)).toBe(false)
  })

  it('uses a signed double-submit CSRF token', () => {
    const csrf = new CsrfProtection(randomBytes(32), false)
    const headers: Record<string, unknown> = {}
    let incomingCookie = ''
    const ctx = {
      response: { headers },
      set(name: string, value: unknown) { headers[name.toLowerCase()] = value },
      get(name: string) { return name.toLowerCase() === 'cookie' ? incomingCookie : '' },
    } as unknown as Koa.Context
    const token = csrf.issue(ctx)
    const setCookie = (headers['set-cookie'] as string[])[0]!
    const cookie = setCookie.split(';', 1)[0]!
    incomingCookie = cookie
    expect(csrf.verify(cookie, token)).toBe(true)
    expect(csrf.issue(ctx)).toBe(token)
    expect(csrf.issue(ctx, true)).not.toBe(token)
    expect(csrf.verify(cookie, `${token}x`)).toBe(false)
    expect(csrf.verify(cookie.replace(/.$/, 'x'), token)).toBe(false)
  })

  it('refuses production LAN HTTP unless explicitly enabled', () => {
    expect(() => loadServerConfig({
      NODE_ENV: 'production',
      HERMES_YAOYAO_HOST: '0.0.0.0',
    })).toThrow(/ALLOW_INSECURE_LAN/)
    expect(loadServerConfig({
      NODE_ENV: 'production',
      HERMES_YAOYAO_HOST: '0.0.0.0',
      HERMES_YAOYAO_ALLOW_INSECURE_LAN: '1',
    }).insecureLan).toBe(true)
  })
})

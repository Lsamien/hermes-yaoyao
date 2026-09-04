import { describe, expect, it, vi } from 'vitest'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'

describe('upstream request boundary', () => {
  it('rejects a path that URL normalization would escape', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetchImpl)
    await expect(client.request('/api/sessions/..', new CookieJar())).rejects.toThrow(/normalization/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('derives proxy scheme from public 15300 TLS and forwards only the trusted peer IP', async () => {
    let headers = new Headers()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=test; Path=/; HttpOnly; SameSite=Lax' },
      })
    })
    const jar = new CookieJar()
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetchImpl, true)
    await client.request('/api/status', jar, { clientAddress: '::ffff:192.168.1.22' })
    expect(headers.get('x-forwarded-proto')).toBe('https')
    expect(headers.get('x-forwarded-for')).toBe('192.168.1.22')
    expect(jar.browserCookies[0]).toContain('Secure')
    expect(jar.browserCookies[0]).not.toMatch(/Domain=/i)
  })
})

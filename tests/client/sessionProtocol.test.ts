import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMessages } from '@/api/sessions'

afterEach(() => vi.unstubAllGlobals())

describe('ordinary session history protocol', () => {
  it('always uses Desktop-compatible latest compacted pagination', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      messages: [{ id: 'm1', role: 'assistant', content: 'ok', timestamp: 1 }],
      pagination: { total: 20, returned: 1, has_more: true, limit: 500 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await getMessages('session/a', 12, 900, 'yao er')
    const [input, init] = fetchMock.mock.calls[0]
    const url = new URL(String(input), 'http://localhost')
    expect(url.pathname).toBe('/api/app/sessions/session%2Fa/messages')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      offset: '12', limit: '500', order: 'latest', include_compacted: 'true', profile: 'yao er',
    })
    expect(init).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(page).toMatchObject({ total: 20, returned: 1, hasMore: true })
  })
})

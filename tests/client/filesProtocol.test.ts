import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFiles } from '@/api/files'

afterEach(() => vi.unstubAllGlobals())

describe('file library profile routing', () => {
  it('uses the response/request profile when plugin origins omit it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      profile: 'yaoer',
      items: [{
        id: 7,
        name: 'result.pdf',
        path: '/tmp/result.pdf',
        mimeType: 'application/pdf',
        size: 10,
        origins: [{ profile: '', sessionId: 'session-1', messageId: 'message-1' }],
      }],
      nextCursor: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const page = await getFiles({ profile: 'yaoer' })
    expect(page.items[0].origins[0].profile).toBe('yaoer')
    expect(page.items[0].previewUrl).toContain('profile=yaoer')
    expect(page.items[0].downloadUrl).toContain('profile=yaoer')
  })
})

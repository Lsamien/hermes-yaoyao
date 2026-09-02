import { describe, expect, it } from 'vitest'
import { SSEParser } from '../../src/shared/sse'
describe('SSE framing', () => {
  it('handles UTF8 and CRLF across arbitrary byte boundaries', () => {
    const bytes = new TextEncoder().encode('\uFEFF: heartbeat\r\nid: e:1\r\nevent: frame\r\ndata: 你好\r\ndata: 世界\r\n\r\n')
    const decoder = new TextDecoder(), parser = new SSEParser(), messages = []
    for (const byte of bytes) messages.push(...parser.feed(decoder.decode(new Uint8Array([byte]), { stream: true })))
    expect(messages).toEqual([{ id: 'e:1', event: 'frame', data: '你好\n世界' }])
  })
  it('ignores comments and does not emit an incomplete frame', () => {
    const parser = new SSEParser()
    expect(parser.feed(': heartbeat\n\ndata: partial')).toEqual([])
    expect(parser.feed('\n\n')).toEqual([{ event: 'message', data: 'partial' }])
  })
})

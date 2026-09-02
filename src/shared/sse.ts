export interface SSEMessage { event: string; data: string; id?: string }

/** Incremental SSE framing; callers supply a streaming UTF-8 decoder. */
export class SSEParser {
  private buffer = ''
  private data: string[] = []
  private event = ''
  private id: string | undefined
  private size = 0
  private first = true
  feed(chunk: string): SSEMessage[] {
    if (this.first && chunk) { chunk = chunk.replace(/^\uFEFF/, ''); this.first = false }
    this.buffer += chunk
    if (this.buffer.length + this.size > 36 * 1024 * 1024) throw new Error('SSE frame exceeds limit')
    const result: SSEMessage[] = []
    while (true) {
      const i = this.buffer.search(/[\r\n]/)
      if (i < 0 || (this.buffer[i] === '\r' && i === this.buffer.length - 1)) break
      const line = this.buffer.slice(0, i)
      this.buffer = this.buffer.slice(i + (this.buffer[i] === '\r' && this.buffer[i + 1] === '\n' ? 2 : 1))
      if (!line) {
        if (this.data.length) result.push({ event: this.event || 'message', data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) })
        this.data = []; this.event = ''; this.size = 0
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') { this.data.push(value); this.size += value.length }
        else if (field === 'event') this.event = value
        else if (field === 'id' && !value.includes('\0')) this.id = value
      }
    }
    return result
  }
}

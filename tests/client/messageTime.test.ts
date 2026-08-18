import { describe, expect, it } from 'vitest'
import { formatMessageTime } from '@/utils/messageTime'

describe('message timestamps', () => {
  const now = new Date('2026-08-18T12:00:00+08:00')

  it('uses time, yesterday, weekday, and a concrete date by recency', () => {
    expect(formatMessageTime('2026-08-18T09:05:00+08:00', now)).toBe('09:05')
    expect(formatMessageTime('2026-08-17T09:05:00+08:00', now)).toBe('昨天 09:05')
    expect(formatMessageTime('2026-08-15T09:05:00+08:00', now)).toBe('周六 09:05')
    expect(formatMessageTime('2026-08-09T09:05:00+08:00', now)).toBe('8月9日 09:05')
    expect(formatMessageTime('2025-08-09T09:05:00+08:00', now)).toBe('2025年8月9日 09:05')
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { appendSessionPage, pinnedSessionsFirst } from '@/utils/sessionOrder'

function session(id: string, pinned = false): SessionSummary {
  return { id, profile: 'yaoyao', source: 'web', title: id, pinned, messageCount: 0, toolCallCount: 0, startedAt: 0, updatedAt: 0 }
}

describe('session sidebar order', () => {
  it('puts pinned conversations first without reordering either server bucket', () => {
    expect(pinnedSessionsFirst([session('recent'), session('pinned-one', true), session('older'), session('pinned-two', true)])
      .map(value => value.id)).toEqual(['pinned-one', 'pinned-two', 'recent', 'older'])
  })

  it('appends a page without duplicating sessions and promotes newly discovered pins', () => {
    expect(appendSessionPage([session('recent')], [session('pinned', true), session('recent'), session('older')])
      .map(value => value.id)).toEqual(['pinned', 'recent', 'older'])
  })
})

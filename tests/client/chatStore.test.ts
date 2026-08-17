import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRouteState, RpcEventFrame } from '@shared/types'
import { applyChatEvent, mergeChatMessages } from '@/utils/messageReducer'

function message(id: string, content = '相同内容', clientMessageId?: string): ChatMessage {
  return {
    id, sessionId: 'session-1', profile: 'yaoyao', role: 'user', content,
    clientMessageId, timestamp: 1, stage: 'settled',
  }
}

function state(): ChatRouteState {
  return {
    route: { profile: 'yaoyao', sessionId: 'session-1' }, messages: [], historySynced: true,
    hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0, isLoadingHistory: false,
    isStreaming: false, isQueued: false, generation: 1,
  }
}

function event(type: string, payload: Record<string, unknown>, sessionId = 'session-1'): RpcEventFrame['params'] {
  return { type, session_id: sessionId, profile: 'yaoyao', payload: payload as never }
}

describe('chat message reducer', () => {
  it('preserves repeated user text when server identities differ', () => {
    const merged = mergeChatMessages([message('one')], [message('two')])
    expect(merged).toHaveLength(2)
    expect(merged.map(item => item.content)).toEqual(['相同内容', '相同内容'])
  })

  it('reconciles an optimistic row only by client message identity', () => {
    const optimistic = { ...message('local', 'hello', 'client-1'), stage: 'pending' as const }
    const persisted = { ...message('server-1', 'hello', 'client-1'), serverMessageId: 'server-1' }
    const merged = mergeChatMessages([optimistic], [persisted])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('server-1')
    expect(merged[0].stage).toBe('settled')
  })

  it('ignores events attributed to another route', () => {
    const original = state()
    const reduced = applyChatEvent(original, event('message.delta', { delta: 'wrong' }, 'session-2'))
    expect(reduced).toBe(original)
    expect(reduced.messages).toEqual([])
  })

  it('uses terminal authoritative output to repair missed deltas', () => {
    let current = applyChatEvent(state(), event('message.start', { message_id: 'assistant-1' }))
    current = applyChatEvent(current, event('message.delta', { message_id: 'assistant-1', delta: '少量' }))
    current = applyChatEvent(current, event('message.complete', {
      message_id: 'assistant-1', text: '完整最终回答', authoritative_output: true,
      usage: { input: 10, output: 20, total: 30 },
    }))
    expect(current.messages).toHaveLength(1)
    expect(current.messages[0].content).toBe('完整最终回答')
    expect(current.messages[0].stage).toBe('settled')
    expect(current.usage?.totalTokens).toBe(30)
  })

  it('treats message.complete status=error as a failed terminal row', () => {
    let current = applyChatEvent(state(), event('message.start', { message_id: 'assistant-1' }))
    current = applyChatEvent(current, event('message.complete', {
      message_id: 'assistant-1', status: 'error', text: '工具执行失败', error: 'permission denied',
    }))
    expect(current.messages[0]).toMatchObject({ stage: 'failed', isStreaming: false })
    expect(current.error).toContain('permission denied')
  })

  it('maps the current 9119 context usage field names', () => {
    const current = applyChatEvent(state(), event('session.usage', {
      input: 10, output: 20, total: 30, context_used: 12_500, context_max: 114_688, context_percent: 10.9,
    }))
    expect(current.usage).toMatchObject({ contextTokens: 12_500, contextLimit: 114_688, percentUsed: 10.9 })
  })

  it('tracks approval and clarification independently', () => {
    let current = applyChatEvent(state(), event('approval.request', { request_id: 'approval-1', message: '允许吗？' }))
    current = applyChatEvent(current, event('clarify.request', { request_id: 'clarify-1', question: '选哪个？' }))
    expect(current.pendingApproval?.id).toBe('approval-1')
    expect(current.pendingClarification?.id).toBe('clarify-1')
    current = applyChatEvent(current, event('approval.resolved', {}))
    expect(current.pendingApproval).toBeUndefined()
    expect(current.pendingClarification?.id).toBe('clarify-1')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { routeKey } from '@/utils/id'

const realtime = vi.hoisted(() => ({
  eventHandler: undefined as ((event: unknown) => void) | undefined,
  request: vi.fn(),
}))
const sessionsApi = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/api/realtime', () => {
  class RpcError extends Error {}
  class ChatRpcSocket {
    onState(): void {}
    onEvent(handler: (event: unknown) => void): void { realtime.eventHandler = handler }
    async connect(): Promise<void> {}
    close(): void {}
    async request(...args: unknown[]): Promise<unknown> { return realtime.request(...args) }
  }
  return { ChatRpcSocket, RpcError }
})

vi.mock('@/api/sessions', () => ({
  deleteSession: vi.fn(),
  getMessages: vi.fn(),
  getSession: sessionsApi.getSession,
  getSessions: vi.fn(),
  getSessionUnread: vi.fn(),
  markSessionRead: vi.fn(),
  updateSession: vi.fn(),
}))
vi.mock('@/api/profiles', () => ({ getModels: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'account-1' },
    activeProfile: { name: 'alpha' },
    status: 'authenticated',
  }),
}))

import { useChatStore } from '@/stores/chat'

describe('chat model realtime synchronization', () => {
  beforeEach(() => {
    realtime.eventHandler = undefined
    realtime.request.mockReset().mockResolvedValue({})
    sessionsApi.getSession.mockReset()
    setActivePinia(createPinia())
  })

  it('applies another viewer model switch to the active selector and session summary', () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' },
      runtimeSessionId: 'runtime-1', messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel

    realtime.eventHandler?.({
      type: 'session.info', session_id: 'runtime-1',
      payload: { info: { model: newModel.id, provider: newModel.provider } },
    })

    expect(chat.selectedModel).toEqual(newModel)
    expect(chat.sessions[0]).toMatchObject({ model: newModel.id, provider: newModel.provider })
  })

  it('reconciles the active model through REST when another client owns realtime events', async () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel
    sessionsApi.getSession.mockResolvedValue({
      ...chat.sessions[0], model: newModel.id, provider: newModel.provider,
    })

    await chat.refreshActiveSessionModel()

    expect(sessionsApi.getSession).toHaveBeenCalledWith('session-1', 'alpha')
    expect(chat.selectedModel).toEqual(newModel)
  })

  it('releases the local model guard after a failed switch', async () => {
    const chat = useChatStore()
    const oldModel = { id: 'model-a', name: 'Model A', provider: 'provider-a' }
    const newModel = { id: 'model-b', name: 'Model B', provider: 'provider-b' }
    chat.models = [oldModel, newModel]
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '会话',
      model: oldModel.id, provider: oldModel.provider, messageCount: 0,
      toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.activeSessionId = 'session-1'
    chat.activeProfileName = 'alpha'
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, runtimeSessionId: 'runtime-1',
      messages: [], historySynced: true, hasMoreBefore: false, loadedMessageCount: 0,
      messageTotal: 0, isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }
    chat.selectedModel = oldModel
    realtime.request.mockRejectedValueOnce(new Error('switch failed'))

    await expect(chat.setModel(newModel)).rejects.toThrow('switch failed')
    expect(chat.selectedModel).toEqual(oldModel)

    realtime.eventHandler?.({
      type: 'session.info', session_id: 'runtime-1',
      payload: { model: newModel.id, provider: newModel.provider },
    })
    expect(chat.selectedModel).toEqual(newModel)
  })

  it('does not resume an old session merely to show its context usage', async () => {
    const chat = useChatStore()
    chat.sessions = [{
      id: 'session-1', profile: 'alpha', source: 'web', title: '旧会话',
      messageCount: 1, toolCallCount: 0, startedAt: 1, updatedAt: 1,
    }]
    chat.routes[routeKey('alpha', 'session-1')] = {
      route: { profile: 'alpha', sessionId: 'session-1' }, messages: [], historySynced: true,
      hasMoreBefore: false, loadedMessageCount: 0, messageTotal: 0,
      isLoadingHistory: false, isStreaming: false, isQueued: false, generation: 1,
    }

    await chat.selectSession('session-1', 'alpha')
    await Promise.resolve()

    expect(realtime.request).not.toHaveBeenCalled()
  })
})

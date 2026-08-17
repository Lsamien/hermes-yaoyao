import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  GroupAgent, GroupCapabilities, GroupMessage, GroupMessagePage, GroupRoomDetail, GroupRoomSummary, GroupSocketEnvelope, RealtimeConnectionState,
} from '@shared/types'
import {
  addGroupAgent, approveGroupInteraction as approveApi, archiveGroupRoom as archiveApi,
  clarifyGroupInteraction as clarifyApi, createGroupRoom as createApi, getGroupCapabilities,
  getGroupMessages, getGroupRoom, getGroupRooms, interruptGroupAgent as interruptApi,
  removeGroupAgent as removeAgentApi, sendGroupMessage as sendApi, updateGroupAgent as updateAgentApi,
  updateGroupRoom as updateRoomApi, uploadGroupFiles, type AgentSeed,
} from '@/api/groups'
import { GroupEventSocket } from '@/api/realtime'
import { ScopedCache } from '@/utils/cache'
import {
  applyGroupEnvelope, snapshotGroupRoom, upsertGroupMessage, type GroupProtocolState,
} from '@/utils/groupProtocol'
import { createUuid } from '@/utils/id'
import { ApiError } from '@/api/client'
import { useAuthStore } from './auth'

type GroupAvailability = 'checking' | 'available' | 'unsupported' | 'unavailable'

interface CachedGroups { state: GroupProtocolState; savedAt: number }
const cache = new ScopedCache<CachedGroups>('groups-v2')

function initialProtocol(): GroupProtocolState {
  return { epoch: '', cursor: 0, rooms: [], roomDetails: {}, messagesByRoom: {} }
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : '群聊请求失败' }

export const useGroupsStore = defineStore('groups', () => {
  const auth = useAuthStore()
  const availability = ref<GroupAvailability>('checking')
  const capabilities = ref<GroupCapabilities>()
  const protocol = shallowRef<GroupProtocolState>(initialProtocol())
  const selectedRoomId = ref<string>()
  const connectionState = ref<RealtimeConnectionState>('idle')
  const isLoading = ref(false)
  const isSending = ref(false)
  const error = ref<string>()
  const hasOlderByRoom = ref<Record<string, boolean>>({})
  const socket = new GroupEventSocket()
  let generation = 0
  let rebuildPromise: Promise<void> | undefined
  let reconnectTimer: number | undefined
  let reconnectAttempt = 0
  let selectionGeneration = 0
  const loadingRoomEvents = new Map<string, GroupSocketEnvelope[]>()

  const rooms = computed(() => protocol.value.rooms)
  const selectedRoom = computed(() => selectedRoomId.value ? protocol.value.roomDetails[selectedRoomId.value] : undefined)
  const messages = computed(() => selectedRoomId.value ? protocol.value.messagesByRoom[selectedRoomId.value] ?? [] : [])
  const agents = computed(() => selectedRoom.value?.agents ?? [])
  const pendingInteractions = computed(() => selectedRoom.value?.pendingInteractions ?? [])
  const hasMoreBefore = computed(() => selectedRoomId.value ? hasOlderByRoom.value[selectedRoomId.value] ?? false : false)

  function scope(): string { return `${auth.user?.id ?? 'anonymous'}:${auth.activeProfile?.name ?? 'all'}` }

  async function saveCache(): Promise<void> {
    await cache.set(scope(), 'snapshot', { state: protocol.value, savedAt: Date.now() })
  }

  async function loadRooms(): Promise<GroupRoomSummary[]> {
    const loaded: GroupRoomSummary[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const key = cursor ?? '<first-page>'
      if (seen.has(key)) throw new Error('群聊房间分页返回了重复游标')
      seen.add(key)
      const page = await getGroupRooms(cursor, 50)
      loaded.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor && loaded.length < 2_000)
    return loaded.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function connectEvents(anchor: GroupCapabilities, expectedGeneration: number): Promise<void> {
    await socket.connect({
      epoch: anchor.journalEpoch,
      cursor: anchor.latestCursor,
      onState(state, reason) {
        if (expectedGeneration !== generation) return
        connectionState.value = state
        if (state === 'ready') reconnectAttempt = 0
        if (reason && state === 'failed') {
          error.value = reason
          scheduleReconnect(expectedGeneration)
        }
      },
      onEnvelope(envelope) {
        if (expectedGeneration !== generation) return
        if (envelope.roomId && loadingRoomEvents.has(envelope.roomId)) {
          loadingRoomEvents.get(envelope.roomId)!.push(envelope)
        }
        protocol.value = applyGroupEnvelope(protocol.value, envelope)
        void saveCache()
      },
      onReset(reason) {
        if (expectedGeneration !== generation) return
        error.value = `群聊事件需要重新同步：${reason}`
        void rebuildSnapshot()
      },
    })
  }

  function scheduleReconnect(expectedGeneration: number): void {
    if (reconnectTimer !== undefined || expectedGeneration !== generation || !auth.isAuthenticated) return
    connectionState.value = 'reconnecting'
    const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      if (expectedGeneration !== generation || !capabilities.value) return
      const anchor: GroupCapabilities = {
        ...capabilities.value,
        journalEpoch: protocol.value.epoch,
        latestCursor: protocol.value.cursor,
      }
      void connectEvents(anchor, expectedGeneration).catch(() => scheduleReconnect(expectedGeneration))
    }, delay)
  }

  async function rebuildSnapshot(): Promise<void> {
    if (rebuildPromise) return rebuildPromise
    const expectedGeneration = ++generation
    const operation = (async () => {
      isLoading.value = true
      error.value = undefined
      socket.close()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      try {
        const anchor = await getGroupCapabilities()
        if (anchor.protocolVersion !== 2) {
          availability.value = 'unsupported'
          throw new Error(`群聊协议版本不兼容：需要 v2，服务器返回 v${anchor.protocolVersion || 'unknown'}`)
        }
        const loadedRooms = await loadRooms()
        if (expectedGeneration !== generation) return
        capabilities.value = anchor
        protocol.value = {
          epoch: anchor.journalEpoch,
          cursor: anchor.latestCursor,
          rooms: loadedRooms,
          roomDetails: {},
          messagesByRoom: {},
        }
        const restoreId = selectedRoomId.value && loadedRooms.some(room => room.id === selectedRoomId.value)
          ? selectedRoomId.value
          : loadedRooms[0]?.id
        if (restoreId) await loadRoomSnapshot(restoreId, expectedGeneration)
        if (expectedGeneration !== generation) return
        availability.value = 'available'
        await saveCache()
        await connectEvents(anchor, expectedGeneration)
      } catch (cause) {
        if (expectedGeneration !== generation) return
        if (availability.value !== 'unsupported') availability.value = 'unavailable'
        error.value = errorMessage(cause)
        throw cause
      } finally {
        if (expectedGeneration === generation) isLoading.value = false
      }
    })()
    let wrapped: Promise<void>
    wrapped = operation.finally(() => {
      if (rebuildPromise === wrapped) rebuildPromise = undefined
    })
    rebuildPromise = wrapped
    return wrapped
  }

  async function start(): Promise<void> {
    availability.value = 'checking'
    protocol.value = initialProtocol()
    const cached = await cache.get(scope(), 'snapshot')
    if (cached?.state.epoch) {
      protocol.value = cached.state
      selectedRoomId.value ??= cached.state.rooms[0]?.id
    }
    await rebuildSnapshot()
  }

  function stop(): void {
    generation += 1
    rebuildPromise = undefined
    socket.close()
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    connectionState.value = 'disconnected'
  }

  watch(() => auth.status, status => {
    if (status !== 'authenticated') {
      stop()
      protocol.value = initialProtocol()
      selectedRoomId.value = undefined
      capabilities.value = undefined
      hasOlderByRoom.value = {}
    }
  })

  async function loadRoomSnapshot(
    roomId: string,
    expectedGeneration = generation,
    expectedSelection = selectionGeneration,
  ): Promise<void> {
    const startingCursor = protocol.value.cursor
    loadingRoomEvents.set(roomId, [])
    let detail: GroupRoomDetail
    let page: GroupMessagePage
    try {
      ;[detail, page] = await Promise.all([getGroupRoom(roomId), getGroupMessages(roomId, { limit: 100 })])
    } catch (cause) {
      loadingRoomEvents.delete(roomId)
      throw cause
    }
    if (expectedGeneration !== generation || expectedSelection !== selectionGeneration) {
      loadingRoomEvents.delete(roomId)
      return
    }
    selectedRoomId.value = roomId
    let merged = page.items.sort((a, b) => a.seq - b.seq)
    // Socket events can land while the REST baseline is in flight. Replay the
    // already-published live rows last so a stale snapshot never erases or
    // rolls back a streaming upsert.
    for (const live of protocol.value.messagesByRoom[roomId] ?? []) {
      merged = upsertGroupMessage(merged, live)
    }
    const liveDetail = protocol.value.cursor > startingCursor
      ? protocol.value.roomDetails[roomId]
      : undefined
    protocol.value = snapshotGroupRoom(protocol.value, liveDetail ?? detail, merged)
    for (const envelope of loadingRoomEvents.get(roomId) ?? []) {
      const durableCursor = protocol.value.cursor
      const replayBase = envelope.cursor == null
        ? protocol.value
        : { ...protocol.value, cursor: Math.max(0, envelope.cursor - 1) }
      const replayed = applyGroupEnvelope(replayBase, envelope)
      protocol.value = { ...replayed, cursor: Math.max(durableCursor, replayed.cursor) }
    }
    loadingRoomEvents.delete(roomId)
    hasOlderByRoom.value = { ...hasOlderByRoom.value, [roomId]: page.items.length >= 100 }
  }

  async function selectRoom(roomId: string): Promise<void> {
    const expectedSelection = ++selectionGeneration
    selectedRoomId.value = roomId
    if (!protocol.value.roomDetails[roomId]) {
      isLoading.value = true
      try { await loadRoomSnapshot(roomId, generation, expectedSelection) }
      catch (cause) { error.value = errorMessage(cause); throw cause }
      finally { isLoading.value = false }
    }
  }

  async function refresh(): Promise<void> { await rebuildSnapshot() }

  async function createRoom(input: { name: string; cwd?: string; agents: AgentSeed[]; maxReplyRounds?: number }): Promise<GroupRoomDetail> {
    const detail = await createApi(input)
    protocol.value = snapshotGroupRoom(protocol.value, detail, [])
    selectedRoomId.value = detail.id
    await saveCache()
    return detail
  }

  async function updateRoom(roomId: string, input: { name?: string; cwd?: string; maxReplyRounds?: number }): Promise<GroupRoomDetail> {
    const detail = await updateRoomApi(roomId, input)
    protocol.value = snapshotGroupRoom(protocol.value, detail, protocol.value.messagesByRoom[roomId] ?? [])
    await saveCache()
    return detail
  }

  async function archiveRoom(roomId: string): Promise<void> {
    const detail = await archiveApi(roomId)
    protocol.value = snapshotGroupRoom(protocol.value, detail, protocol.value.messagesByRoom[roomId] ?? [])
    if (selectedRoomId.value === roomId) selectedRoomId.value = protocol.value.rooms.find(room => !room.archived && room.id !== roomId)?.id
    await saveCache()
  }

  function publishAgent(roomId: string, agent: GroupAgent): void {
    const detail = protocol.value.roomDetails[roomId]
    if (!detail) return
    const index = detail.agents.findIndex(item => item.id === agent.id)
    const agents = [...detail.agents]
    if (index < 0) agents.push(agent)
    else agents[index] = agent
    protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, agents } },
    }
  }

  async function addAgent(roomId: string, input: AgentSeed): Promise<GroupAgent> {
    const agent = await addGroupAgent(roomId, input)
    publishAgent(roomId, agent)
    return agent
  }

  async function updateAgent(roomId: string, agentId: string, input: Partial<Omit<AgentSeed, 'profile'>> & { enabled?: boolean }): Promise<GroupAgent> {
    const agent = await updateAgentApi(roomId, agentId, input)
    publishAgent(roomId, agent)
    return agent
  }

  async function removeAgent(roomId: string, agentId: string): Promise<void> {
    await removeAgentApi(roomId, agentId)
    const detail = protocol.value.roomDetails[roomId]
    if (detail) protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, agents: detail.agents.filter(agent => agent.id !== agentId) } },
    }
  }

  async function sendMessage(content: string, mentionAgentIds: string[] = [], files: File[] = []): Promise<void> {
    const roomId = selectedRoomId.value
    if (!roomId) return
    const text = content.trim()
    let uploadIds: string[] = []
    let optimisticText = text
    if (files.length) {
      if (!auth.groupUploadsEnabled) throw new Error('当前上游不支持群聊附件')
      const uploaded = await uploadGroupFiles(roomId, files)
      uploadIds = uploaded.map(file => file.id)
      optimisticText = [text, ...uploaded.map(file => `📎 ${file.name}`)].filter(Boolean).join('\n\n')
    }
    if (!text && !uploadIds.length) return
    const clientMessageId = createUuid()
    const stableRequestId = createUuid()
    const now = Date.now() / 1000
    const optimistic: GroupMessage = {
      seq: Math.max(0, ...messages.value.map(message => message.seq)) + 1,
      id: clientMessageId,
      roomId,
      senderKind: 'human',
      senderId: auth.user?.id ?? 'me',
      senderName: auth.user?.displayName ?? auth.user?.username ?? '我',
      rootMessageId: clientMessageId,
      clientMessageId,
      content: optimisticText,
      reasoning: '',
      toolState: [],
      status: 'queued',
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    protocol.value = {
      ...protocol.value,
      messagesByRoom: {
        ...protocol.value.messagesByRoom,
        [roomId]: upsertGroupMessage(protocol.value.messagesByRoom[roomId] ?? [], optimistic),
      },
    }
    isSending.value = true
    try {
      const enabled = new Set((protocol.value.roomDetails[roomId]?.agents ?? []).filter(agent => agent.enabled).map(agent => agent.id))
      const resolvedMentions = mentionAgentIds.includes('all')
        ? [...enabled]
        : [...new Set(mentionAgentIds.filter(id => enabled.has(id)))]
      const response = await sendApi(roomId, text, resolvedMentions, clientMessageId, uploadIds, stableRequestId)
      protocol.value = {
        ...protocol.value,
        messagesByRoom: {
          ...protocol.value.messagesByRoom,
          [roomId]: upsertGroupMessage(protocol.value.messagesByRoom[roomId] ?? [], response.message),
        },
      }
    } catch (cause) {
      const explicitRejection = cause instanceof ApiError && cause.status >= 400 && cause.status < 500
      const failed = {
        ...optimistic,
        status: explicitRejection ? 'failed' as const : 'unknown' as const,
        error: explicitRejection ? errorMessage(cause) : '送达状态未知；刷新房间后再决定是否重试',
        updatedAt: Date.now() / 1000,
      }
      protocol.value = {
        ...protocol.value,
        messagesByRoom: { ...protocol.value.messagesByRoom, [roomId]: upsertGroupMessage(protocol.value.messagesByRoom[roomId] ?? [], failed) },
      }
      throw cause
    } finally { isSending.value = false }
  }

  async function loadOlder(): Promise<void> {
    const roomId = selectedRoomId.value
    const oldest = messages.value.find(message => message.seq > 0)?.seq
    if (!roomId || !oldest) return
    const page = await getGroupMessages(roomId, { beforeSeq: oldest, limit: 100 })
    let merged = protocol.value.messagesByRoom[roomId] ?? []
    for (const message of page.items) merged = upsertGroupMessage(merged, message)
    protocol.value = { ...protocol.value, messagesByRoom: { ...protocol.value.messagesByRoom, [roomId]: merged } }
    hasOlderByRoom.value = { ...hasOlderByRoom.value, [roomId]: page.items.length >= 100 }
  }

  async function interruptAgent(agentId: string, roomId = selectedRoomId.value): Promise<void> {
    if (!roomId) return
    await interruptApi(roomId, agentId)
  }

  async function approveInteraction(interactionId: string, choice: 'once' | 'session' | 'always' | 'deny', roomId = selectedRoomId.value): Promise<void> {
    if (!roomId) return
    await approveApi(roomId, interactionId, choice)
    const detail = protocol.value.roomDetails[roomId]
    if (detail) protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, pendingInteractions: detail.pendingInteractions.filter(item => item.id !== interactionId) } },
    }
  }

  async function clarifyInteraction(interactionId: string, response: string, roomId = selectedRoomId.value): Promise<void> {
    if (!roomId) return
    await clarifyApi(roomId, interactionId, response)
    const detail = protocol.value.roomDetails[roomId]
    if (detail) protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, pendingInteractions: detail.pendingInteractions.filter(item => item.id !== interactionId) } },
    }
  }

  return {
    availability, capabilities, rooms, selectedRoomId, selectedRoom, messages, agents, pendingInteractions,
    connectionState, isLoading, isSending, error, hasMoreBefore,
    start, stop, refresh, selectRoom, createRoom, updateRoom, archiveRoom, addAgent, updateAgent,
    removeAgent, sendMessage, loadOlder, interruptAgent, approveInteraction, clarifyInteraction,
  }
})

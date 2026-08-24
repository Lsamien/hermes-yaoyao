import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { isSupportedGroupProtocolVersion, SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '@shared/types'
import type {
  GroupAgent, GroupCapabilities, GroupMessage, GroupMessagePage, GroupRoomDetail, GroupRoomSummary, GroupRun, GroupSocketEnvelope, GroupTopicSummary, RealtimeConnectionState,
} from '@shared/types'
import {
  addGroupAgent, approveGroupInteraction as approveApi, archiveGroupRoom as archiveApi, archiveGroupTopic as archiveTopicApi,
  clarifyGroupInteraction as clarifyApi, createGroupRoom as createApi, getGroupCapabilities,
  getGroupMessages, getGroupRoom, getGroupRooms, getGroupTopics, getPinnedGroupTopics, interruptGroupAgent as interruptApi, markGroupTopicRead,
  removeGroupAgent as removeAgentApi, restoreGroupRoom as restoreRoomApi, restoreGroupTopic as restoreTopicApi, sendGroupMessage as sendApi, updateGroupAgent as updateAgentApi,
  updateGroupRoom as updateRoomApi, updateGroupTopic as updateTopicApi, uploadGroupFiles, type AgentSeed,
} from '@/api/groups'
import { GroupEventSocket } from '@/api/realtime'
import { ScopedCache } from '@/utils/cache'
import {
  applyGroupEnvelope, convergeGroupAgents, snapshotGroupRoom, upsertGroupMessage, upsertGroupTopic, type GroupProtocolState,
} from '@/utils/groupProtocol'
import { createUuid } from '@/utils/id'
import { ApiError } from '@/api/client'
import { useAuthStore } from './auth'

type GroupAvailability = 'checking' | 'available' | 'unsupported' | 'unavailable'

interface CachedGroups { state: GroupProtocolState; savedAt: number }
const cache = new ScopedCache<CachedGroups>('groups-v3')

function initialProtocol(): GroupProtocolState {
  return { epoch: '', cursor: 0, rooms: [], roomDetails: {}, messagesByRoom: {}, topicsByRoom: {}, messagesByTopic: {} }
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : '群聊请求失败' }

function topicTitle(content: string): string {
  return content.split(/\s+/).filter(Boolean).join(' ').slice(0, 100) || '新话题'
}

export const useGroupsStore = defineStore('groups', () => {
  const auth = useAuthStore()
  const availability = ref<GroupAvailability>('checking')
  const capabilities = ref<GroupCapabilities>()
  const protocol = shallowRef<GroupProtocolState>(initialProtocol())
  const selectedRoomId = ref<string>()
  const selectedTopicId = ref<string>()
  const pinnedTopics = ref<GroupTopicSummary[]>([])
  const connectionState = ref<RealtimeConnectionState>('idle')
  const isLoading = ref(false)
  const isSending = ref(false)
  const error = ref<string>()
  const hasOlderByConversation = ref<Record<string, boolean>>({})
  const socket = new GroupEventSocket()
  let generation = 0
  let rebuildPromise: Promise<void> | undefined
  let reconnectTimer: number | undefined
  let reconnectAttempt = 0
  let recoveryTimer: number | undefined
  let recoveryAttempt = 0
  let selectionGeneration = 0
  const loadingRoomEvents = new Map<string, GroupSocketEnvelope[]>()

  const rooms = computed(() => protocol.value.rooms)
  const selectedRoom = computed(() => selectedRoomId.value ? protocol.value.roomDetails[selectedRoomId.value] : undefined)
  const topicProtocol = computed(() => (capabilities.value?.protocolVersion ?? 0) >= 4)
  const hostProtocol = computed(() => (capabilities.value?.protocolVersion ?? 0) >= 5)
  const hostFlowProtocol = computed(() => capabilities.value?.features?.includes('hostFlow') ?? false)
  const roomInstructionsProtocol = computed(() => capabilities.value?.features?.includes('roomInstructions') ?? false)
  const activityProtocol = computed(() => (capabilities.value?.protocolVersion ?? 0) >= 8)
  const topics = computed(() => selectedRoomId.value ? protocol.value.topicsByRoom[selectedRoomId.value] ?? [] : [])
  const selectedTopic = computed(() => selectedTopicId.value ? topics.value.find(topic => topic.id === selectedTopicId.value) : undefined)
  const messages = computed(() => topicProtocol.value
    ? (selectedTopicId.value ? protocol.value.messagesByTopic[selectedTopicId.value] ?? [] : [])
    : (selectedRoomId.value ? protocol.value.messagesByRoom[selectedRoomId.value] ?? [] : []))
  const agents = computed(() => selectedRoom.value?.agents ?? [])
  const pendingInteractions = computed(() => (selectedRoom.value?.pendingInteractions ?? []).filter(interaction =>
    !topicProtocol.value || !interaction.topicId || interaction.topicId === selectedTopicId.value))
  const conversationKey = computed(() => topicProtocol.value ? selectedTopicId.value : selectedRoomId.value)
  const hasMoreBefore = computed(() => conversationKey.value ? hasOlderByConversation.value[conversationKey.value] ?? false : false)

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

  async function loadTopics(roomId: string, archived = false): Promise<GroupTopicSummary[]> {
    const loaded: GroupTopicSummary[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const key = cursor ?? '<first-page>'
      if (seen.has(key)) throw new Error('群聊话题分页返回了重复游标')
      seen.add(key)
      const page = await getGroupTopics(roomId, cursor, 50, archived)
      loaded.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor && loaded.length < 2_000)
    return loaded.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
  }

  function topicsForRoom(roomId: string): GroupTopicSummary[] {
    return (protocol.value.topicsByRoom[roomId] ?? []).filter(topic => !topic.archived)
  }

  function markTopicRead(roomId: string, topicId: string | undefined, messages: GroupMessage[]): void {
    if (!activityProtocol.value || !topicId) return
    const throughSeq = Math.max(0, ...messages.map(message => message.seq))
    if (!throughSeq) return
    void markGroupTopicRead(roomId, topicId, throughSeq).catch(() => undefined)
  }

  async function loadRoomTopics(roomId: string): Promise<void> {
    if (!topicProtocol.value || Object.prototype.hasOwnProperty.call(protocol.value.topicsByRoom, roomId)) return
    const expectedGeneration = generation
    const loaded = await loadTopics(roomId)
    if (expectedGeneration !== generation) return
    protocol.value = {
      ...protocol.value,
      topicsByRoom: { ...protocol.value.topicsByRoom, [roomId]: loaded },
    }
  }

  async function loadPinnedTopics(): Promise<void> {
    pinnedTopics.value = (await getPinnedGroupTopics()).items
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

  function scheduleSnapshotRecovery(expectedGeneration: number): void {
    if (recoveryTimer !== undefined || expectedGeneration !== generation || !auth.isAuthenticated) return
    connectionState.value = 'reconnecting'
    const delay = Math.min(15_000, 500 * 2 ** Math.min(recoveryAttempt, 5))
    recoveryAttempt += 1
    recoveryTimer = window.setTimeout(() => {
      recoveryTimer = undefined
      if (expectedGeneration !== generation || !auth.isAuthenticated) return
      void rebuildSnapshot().catch(() => undefined)
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
      if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer)
      recoveryTimer = undefined
      try {
        const anchor = await getGroupCapabilities()
        if (!isSupportedGroupProtocolVersion(anchor.protocolVersion)) {
          availability.value = 'unsupported'
          throw new Error(`群聊协议版本不兼容：支持 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL}，服务器返回 v${anchor.protocolVersion || 'unknown'}`)
        }
        const loadedRooms = await loadRooms()
        if (expectedGeneration !== generation) return
        await loadPinnedTopics()
        if (expectedGeneration !== generation) return
        capabilities.value = anchor
        protocol.value = {
          epoch: anchor.journalEpoch,
          cursor: anchor.latestCursor,
          rooms: loadedRooms,
          roomDetails: {},
          messagesByRoom: {},
          topicsByRoom: {},
          messagesByTopic: {},
        }
        const restoreId = selectedRoomId.value && loadedRooms.some(room => room.id === selectedRoomId.value)
          ? selectedRoomId.value
          : loadedRooms[0]?.id
        if (restoreId) {
          const restoreTopicId = restoreId === selectedRoomId.value ? selectedTopicId.value : undefined
          await loadRoomSnapshot(restoreId, expectedGeneration, selectionGeneration, restoreTopicId)
        }
        if (expectedGeneration !== generation) return
        availability.value = 'available'
        recoveryAttempt = 0
        await saveCache()
        await connectEvents(anchor, expectedGeneration)
      } catch (cause) {
        if (expectedGeneration !== generation) return
        if (availability.value !== 'unsupported') availability.value = 'unavailable'
        error.value = errorMessage(cause)
        if (availability.value !== 'unsupported') scheduleSnapshotRecovery(expectedGeneration)
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
    recoveryAttempt = 0
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
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer)
    recoveryTimer = undefined
    reconnectAttempt = 0
    recoveryAttempt = 0
    connectionState.value = 'disconnected'
  }

  watch(() => auth.status, status => {
    if (status !== 'authenticated') {
      stop()
      protocol.value = initialProtocol()
      selectedRoomId.value = undefined
      selectedTopicId.value = undefined
      capabilities.value = undefined
      hasOlderByConversation.value = {}
    }
  })

  async function loadRoomSnapshot(
    roomId: string,
    expectedGeneration = generation,
    expectedSelection = selectionGeneration,
    requestedTopicId?: string,
  ): Promise<void> {
    const startingCursor = protocol.value.cursor
    loadingRoomEvents.set(roomId, [])
    let detail: GroupRoomDetail
    let page: GroupMessagePage
    let loadedTopics: GroupTopicSummary[] | undefined
    let topicId: string | undefined
    try {
      if (topicProtocol.value) {
        ;[detail, loadedTopics] = await Promise.all([getGroupRoom(roomId), loadTopics(roomId)])
        topicId = requestedTopicId || loadedTopics[0]?.id || createUuid()
        page = loadedTopics.some(topic => topic.id === topicId)
          ? await getGroupMessages(roomId, { topicId, limit: 100 })
          : { items: [] }
      } else {
        ;[detail, page] = await Promise.all([getGroupRoom(roomId), getGroupMessages(roomId, { limit: 100 })])
      }
    } catch (cause) {
      loadingRoomEvents.delete(roomId)
      throw cause
    }
    if (expectedGeneration !== generation || expectedSelection !== selectionGeneration) {
      loadingRoomEvents.delete(roomId)
      return
    }
    selectedRoomId.value = roomId
    selectedTopicId.value = topicId
    let merged = page.items.sort((a, b) => a.seq - b.seq)
    // Socket events can land while the REST baseline is in flight. Replay the
    // already-published live rows last so a stale snapshot never erases or
    // rolls back a streaming upsert.
    const liveMessages = topicId
      ? protocol.value.messagesByTopic[topicId] ?? []
      : protocol.value.messagesByRoom[roomId] ?? []
    for (const live of liveMessages) {
      merged = upsertGroupMessage(merged, live)
    }
    const liveDetail = protocol.value.cursor > startingCursor
      ? protocol.value.roomDetails[roomId]
      : undefined
    protocol.value = snapshotGroupRoom(protocol.value, liveDetail ?? detail, merged, { topicId, topics: loadedTopics })
    for (const envelope of loadingRoomEvents.get(roomId) ?? []) {
      const durableCursor = protocol.value.cursor
      const replayBase = envelope.cursor == null
        ? protocol.value
        : { ...protocol.value, cursor: Math.max(0, envelope.cursor - 1) }
      const replayed = applyGroupEnvelope(replayBase, envelope)
      protocol.value = { ...replayed, cursor: Math.max(durableCursor, replayed.cursor) }
    }
    loadingRoomEvents.delete(roomId)
    const key = topicId || roomId
    hasOlderByConversation.value = { ...hasOlderByConversation.value, [key]: page.items.length >= 100 }
    markTopicRead(roomId, topicId, merged)
  }

  async function loadTopicSnapshot(
    roomId: string,
    topicId: string,
    expectedGeneration = generation,
    expectedSelection = selectionGeneration,
  ): Promise<void> {
    selectedTopicId.value = topicId
    const persisted = (protocol.value.topicsByRoom[roomId] ?? []).some(topic => topic.id === topicId)
    if (!persisted) {
      protocol.value = {
        ...protocol.value,
        messagesByTopic: { ...protocol.value.messagesByTopic, [topicId]: protocol.value.messagesByTopic[topicId] ?? [] },
      }
      hasOlderByConversation.value = { ...hasOlderByConversation.value, [topicId]: false }
      return
    }
    const page = await getGroupMessages(roomId, { topicId, limit: 100 })
    if (expectedGeneration !== generation || expectedSelection !== selectionGeneration) return
    let merged = page.items.sort((a, b) => a.seq - b.seq)
    for (const live of protocol.value.messagesByTopic[topicId] ?? []) merged = upsertGroupMessage(merged, live)
    protocol.value = {
      ...protocol.value,
      messagesByTopic: { ...protocol.value.messagesByTopic, [topicId]: merged },
    }
    hasOlderByConversation.value = { ...hasOlderByConversation.value, [topicId]: page.items.length >= 100 }
    markTopicRead(roomId, topicId, merged)
  }

  async function selectRoom(roomId: string, requestedTopicId?: string): Promise<void> {
    const expectedSelection = ++selectionGeneration
    const previousRoomId = selectedRoomId.value
    const previousTopicId = selectedTopicId.value
    const sameRoom = selectedRoomId.value === roomId
    selectedRoomId.value = roomId
    const rollback = () => {
      if (expectedSelection !== selectionGeneration) return
      selectedRoomId.value = previousRoomId
      selectedTopicId.value = previousTopicId
    }
    const topicsLoaded = Object.prototype.hasOwnProperty.call(protocol.value.topicsByRoom, roomId)
    if (!protocol.value.roomDetails[roomId] || (topicProtocol.value && !topicsLoaded)) {
      isLoading.value = true
      const desiredTopicId = requestedTopicId || (sameRoom ? selectedTopicId.value : undefined)
      try { await loadRoomSnapshot(roomId, generation, expectedSelection, desiredTopicId) }
      catch (cause) { rollback(); error.value = errorMessage(cause); throw cause }
      finally { isLoading.value = false }
      return
    }
    if (!topicProtocol.value) {
      selectedTopicId.value = undefined
      return
    }
    const topicId = requestedTopicId || (sameRoom ? selectedTopicId.value : undefined)
      || protocol.value.topicsByRoom[roomId]?.[0]?.id || createUuid()
    isLoading.value = true
    try { await loadTopicSnapshot(roomId, topicId, generation, expectedSelection) }
    catch (cause) { rollback(); error.value = errorMessage(cause); throw cause }
    finally { isLoading.value = false }
  }

  async function selectTopic(topicId: string): Promise<void> {
    const roomId = selectedRoomId.value
    if (!roomId || !topicProtocol.value || topicId === selectedTopicId.value) return
    const expectedSelection = ++selectionGeneration
    const previousTopicId = selectedTopicId.value
    isLoading.value = true
    try { await loadTopicSnapshot(roomId, topicId, generation, expectedSelection) }
    catch (cause) {
      if (expectedSelection === selectionGeneration) selectedTopicId.value = previousTopicId
      error.value = errorMessage(cause)
      throw cause
    }
    finally { isLoading.value = false }
  }

  async function startNewTopic(): Promise<string | undefined> {
    if (!selectedRoomId.value || !topicProtocol.value) return undefined
    const topicId = createUuid()
    await selectTopic(topicId)
    return topicId
  }

  async function refresh(): Promise<void> { await rebuildSnapshot() }

  async function createRoom(input: { name: string; cwd?: string; instructions?: string; agents: AgentSeed[]; maxReplyRounds?: number; orchestrationMode?: 'free' | 'host' }): Promise<GroupRoomDetail> {
    const detail = await createApi(input)
    protocol.value = snapshotGroupRoom(protocol.value, detail, [], topicProtocol.value ? { topics: [] } : {})
    selectedRoomId.value = detail.id
    selectedTopicId.value = undefined
    if (topicProtocol.value) await startNewTopic()
    await saveCache()
    return detail
  }

  async function updateRoom(roomId: string, input: { name?: string; cwd?: string; instructions?: string; maxReplyRounds?: number; orchestrationMode?: 'free' | 'host' }): Promise<GroupRoomDetail> {
    const detail = await updateRoomApi(roomId, input)
    const topicId = topicProtocol.value && selectedRoomId.value === roomId ? selectedTopicId.value : undefined
    const roomMessages = topicId ? protocol.value.messagesByTopic[topicId] ?? [] : protocol.value.messagesByRoom[roomId] ?? []
    protocol.value = snapshotGroupRoom(protocol.value, detail, roomMessages, { topicId })
    await saveCache()
    return detail
  }

  async function archiveRoom(roomId: string): Promise<void> {
    const detail = await archiveApi(roomId)
    const topicId = topicProtocol.value && selectedRoomId.value === roomId ? selectedTopicId.value : undefined
    const roomMessages = topicId ? protocol.value.messagesByTopic[topicId] ?? [] : protocol.value.messagesByRoom[roomId] ?? []
    protocol.value = snapshotGroupRoom(protocol.value, detail, roomMessages, { topicId })
    if (selectedRoomId.value === roomId) {
      selectedRoomId.value = protocol.value.rooms.find(room => !room.archived && room.id !== roomId)?.id
      selectedTopicId.value = undefined
    }
    await saveCache()
  }

  async function restoreRoom(roomId: string): Promise<GroupRoomDetail> {
    const detail = await restoreRoomApi(roomId)
    protocol.value = snapshotGroupRoom(protocol.value, detail, [], topicProtocol.value ? { topics: [] } : {})
    await saveCache()
    return detail
  }

  async function archiveTopic(roomId: string, topicId: string): Promise<void> {
    const topic = await archiveTopicApi(roomId, topicId)
    const current = protocol.value.topicsByRoom[roomId] ?? []
    protocol.value = { ...protocol.value, topicsByRoom: { ...protocol.value.topicsByRoom, [roomId]: current.map(item => item.id === topic.id ? topic : item) } }
    pinnedTopics.value = pinnedTopics.value.filter(item => item.id !== topic.id)
    if (selectedRoomId.value === roomId && selectedTopicId.value === topicId) {
      selectedTopicId.value = current.find(item => item.id !== topicId && !item.archived)?.id
    }
    await saveCache()
  }

  async function setTopicPinned(roomId: string, topicId: string, pinned: boolean): Promise<GroupTopicSummary> {
    const topic = await updateTopicApi(roomId, topicId, { pinned })
    const current = protocol.value.topicsByRoom[roomId] ?? []
    protocol.value = { ...protocol.value, topicsByRoom: { ...protocol.value.topicsByRoom, [roomId]: upsertGroupTopic(current, topic) } }
    pinnedTopics.value = pinned
      ? upsertGroupTopic(pinnedTopics.value, topic)
      : pinnedTopics.value.filter(item => item.id !== topic.id)
    await saveCache()
    return topic
  }

  async function renameTopic(roomId: string, topicId: string, title: string): Promise<GroupTopicSummary> {
    const topic = await updateTopicApi(roomId, topicId, { title })
    const current = protocol.value.topicsByRoom[roomId] ?? []
    protocol.value = { ...protocol.value, topicsByRoom: { ...protocol.value.topicsByRoom, [roomId]: upsertGroupTopic(current, topic) } }
    if (topic.pinned) pinnedTopics.value = upsertGroupTopic(pinnedTopics.value, topic)
    await saveCache()
    return topic
  }

  async function restoreTopic(roomId: string, topicId: string): Promise<GroupTopicSummary> {
    const topic = await restoreTopicApi(roomId, topicId)
    const current = protocol.value.topicsByRoom[roomId] ?? []
    protocol.value = { ...protocol.value, topicsByRoom: { ...protocol.value.topicsByRoom, [roomId]: upsertGroupTopic(current, topic) } }
    await saveCache()
    return topic
  }

  async function archivedRooms(): Promise<GroupRoomSummary[]> {
    const loaded: GroupRoomSummary[] = []
    let cursor: string | undefined
    do {
      const page = await getGroupRooms(cursor, 50, true)
      loaded.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor && loaded.length < 2_000)
    return loaded.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function archivedTopics(roomId: string): Promise<GroupTopicSummary[]> {
    return loadTopics(roomId, true)
  }

  function publishAgent(roomId: string, agent: GroupAgent): void {
    const detail = protocol.value.roomDetails[roomId]
    if (!detail) return
    protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, agents: convergeGroupAgents(detail.agents, agent) } },
    }
  }

  function publishRuns(roomId: string, incoming: GroupRun[]): void {
    const detail = protocol.value.roomDetails[roomId]
    if (!detail || !incoming.length) return
    const runs = [...detail.runs]
    for (const run of incoming) {
      const index = runs.findIndex(item => item.id === run.id)
      if (index < 0) runs.push(run)
      else if (runs[index]!.updatedAt <= run.updatedAt) runs[index] = { ...runs[index]!, ...run }
    }
    protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, runs } },
    }
  }

  async function addAgent(roomId: string, input: AgentSeed): Promise<GroupAgent> {
    const agent = await addGroupAgent(roomId, input)
    publishAgent(roomId, agent)
    return agent
  }

  async function updateAgent(roomId: string, agentId: string, input: Partial<Omit<AgentSeed, 'profile'>> & { enabled?: boolean }): Promise<GroupAgent> {
    const disabledHost = input.enabled === false
      && protocol.value.roomDetails[roomId]?.agents.some(agent => agent.id === agentId && agent.isHost) === true
    const agent = await updateAgentApi(roomId, agentId, input)
    publishAgent(roomId, agent)
    if (disabledHost && selectedRoomId.value === roomId) {
      await loadRoomSnapshot(roomId, generation, selectionGeneration, selectedTopicId.value)
      await saveCache()
    }
    return agent
  }

  async function removeAgent(roomId: string, agentId: string): Promise<void> {
    const removedHost = protocol.value.roomDetails[roomId]?.agents.some(agent => agent.id === agentId && agent.isHost) === true
    await removeAgentApi(roomId, agentId)
    const detail = protocol.value.roomDetails[roomId]
    if (detail) protocol.value = {
      ...protocol.value,
      roomDetails: { ...protocol.value.roomDetails, [roomId]: { ...detail, agents: detail.agents.filter(agent => agent.id !== agentId) } },
    }
    if (removedHost && selectedRoomId.value === roomId) {
      await loadRoomSnapshot(roomId, generation, selectionGeneration, selectedTopicId.value)
      await saveCache()
    }
  }

  async function sendMessage(content: string, mentionAgentIds: string[] = [], files: File[] = []): Promise<void> {
    const roomId = selectedRoomId.value
    if (!roomId) return
    let topicId = topicProtocol.value ? selectedTopicId.value : undefined
    if (topicProtocol.value && !topicId) {
      topicId = createUuid()
      selectedTopicId.value = topicId
    }
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
    const wasNewTopic = Boolean(topicId && !(protocol.value.topicsByRoom[roomId] ?? []).some(topic => topic.id === topicId))
    const optimistic: GroupMessage = {
      seq: Math.max(0, ...messages.value.map(message => message.seq)) + 1,
      id: clientMessageId,
      roomId,
      topicId: topicId || null,
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
    if (topicId) {
      const existing = (protocol.value.topicsByRoom[roomId] ?? []).find(topic => topic.id === topicId)
      const optimisticTopic: GroupTopicSummary = {
        id: topicId,
        roomId,
        title: existing?.title || topicTitle(text || optimisticText),
        preview: optimisticText,
        messageCount: (existing?.messageCount ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      protocol.value = {
        ...protocol.value,
        topicsByRoom: {
          ...protocol.value.topicsByRoom,
          [roomId]: upsertGroupTopic(protocol.value.topicsByRoom[roomId] ?? [], optimisticTopic),
        },
        messagesByTopic: {
          ...protocol.value.messagesByTopic,
          [topicId]: upsertGroupMessage(protocol.value.messagesByTopic[topicId] ?? [], optimistic),
        },
      }
    } else {
      protocol.value = {
        ...protocol.value,
        messagesByRoom: {
          ...protocol.value.messagesByRoom,
          [roomId]: upsertGroupMessage(protocol.value.messagesByRoom[roomId] ?? [], optimistic),
        },
      }
    }
    isSending.value = true
    try {
      const enabled = new Set((protocol.value.roomDetails[roomId]?.agents ?? []).filter(agent => agent.enabled).map(agent => agent.id))
      const resolvedMentions = mentionAgentIds.includes('all')
        ? [...enabled]
        : [...new Set(mentionAgentIds.filter(id => enabled.has(id)))]
      const response = await sendApi(roomId, text, resolvedMentions, clientMessageId, topicId, uploadIds, stableRequestId)
      publishRuns(roomId, response.runs)
      const responseTopicId = response.message.topicId || topicId
      protocol.value = responseTopicId ? {
        ...protocol.value,
        messagesByTopic: {
          ...protocol.value.messagesByTopic,
          [responseTopicId]: upsertGroupMessage(protocol.value.messagesByTopic[responseTopicId] ?? [], response.message),
        },
      } : {
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
      protocol.value = topicId ? {
        ...protocol.value,
        topicsByRoom: explicitRejection && wasNewTopic ? {
          ...protocol.value.topicsByRoom,
          [roomId]: (protocol.value.topicsByRoom[roomId] ?? []).filter(topic => topic.id !== topicId),
        } : protocol.value.topicsByRoom,
        messagesByTopic: { ...protocol.value.messagesByTopic, [topicId]: upsertGroupMessage(protocol.value.messagesByTopic[topicId] ?? [], failed) },
      } : {
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
    const topicId = topicProtocol.value ? selectedTopicId.value : undefined
    const page = await getGroupMessages(roomId, { topicId, beforeSeq: oldest, limit: 100 })
    let merged = topicId ? protocol.value.messagesByTopic[topicId] ?? [] : protocol.value.messagesByRoom[roomId] ?? []
    for (const message of page.items) merged = upsertGroupMessage(merged, message)
    protocol.value = topicId
      ? { ...protocol.value, messagesByTopic: { ...protocol.value.messagesByTopic, [topicId]: merged } }
      : { ...protocol.value, messagesByRoom: { ...protocol.value.messagesByRoom, [roomId]: merged } }
    const key = topicId || roomId
    hasOlderByConversation.value = { ...hasOlderByConversation.value, [key]: page.items.length >= 100 }
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
    availability, capabilities, topicProtocol, hostProtocol, hostFlowProtocol, roomInstructionsProtocol, activityProtocol, rooms, selectedRoomId, selectedRoom, topics, topicsForRoom, loadRoomTopics, selectedTopicId, selectedTopic,
    messages, agents, pendingInteractions,
    connectionState, isLoading, isSending, error, hasMoreBefore,
    pinnedTopics, start, stop, refresh, selectRoom, selectTopic, startNewTopic, createRoom, updateRoom, archiveRoom, restoreRoom, archiveTopic, restoreTopic, setTopicPinned, renameTopic, loadPinnedTopics, archivedRooms, archivedTopics, addAgent, updateAgent,
    removeAgent, sendMessage, loadOlder, interruptAgent, approveInteraction, clarifyInteraction,
  }
})

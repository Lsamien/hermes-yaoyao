<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '@shared/types'
import type { GroupAgent, GroupRoomSummary, GroupTopicSummary, ModelOption } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import type { ComposerOption, ComposerReference, ComposerSubmit } from '@/components/composer/types'
import CreateGroupDialog from '@/components/groups/CreateGroupDialog.vue'
import GroupManager from '@/components/groups/GroupManager.vue'
import type { GroupProfileOption } from '@/components/groups/types'
import PreviewModal from '@/components/library/PreviewModal.vue'
import ImagePreviewLightbox from '@/components/library/ImagePreviewLightbox.vue'
import type { PreviewMedia } from '@/components/library/ImagePreviewLightbox.vue'
import type { UiLibraryItem } from '@/components/library/types'
import { mediaItemsFromMessages, mediaUrlIdentity, previewItemFromUrl } from '@/components/library/mediaSequence'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import FloatingResourceSearch from '@/components/app/FloatingResourceSearch.vue'
import type { SidebarItem } from '@/components/app/types'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { loadComposerFile } from '@/components/workspace/pendingComposer'
import { readAgentShowThinking, writeAgentShowThinking } from '@/utils/sessionPreferences'
import { agentToUi, groupInteraction, groupMessageToUi, roomSidebarItem, roomToUi } from '@/components/workspace/viewModels'
import { getModels } from '@/api/profiles'
import { useAuthStore } from '@/stores/auth'
import { useGroupsStore } from '@/stores/groups'

const auth = useAuthStore()
const groups = useGroupsStore()
const route = useRoute()
const router = useRouter()
const createOpen = ref(false)
const managerOpen = ref(false)
const showThinking = ref(true)
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const mediaPreviewIndex = ref<number | null>(null)
const composer = ref<InstanceType<typeof ComposerShell> | null>(null)
const modelOptionsByProfile = ref<Record<string, ModelOption[]>>({})
const modelOptionsLoading = ref<Record<string, boolean>>({})
const modelOptionsError = ref<Record<string, string>>({})
const agentUpdateBusy = ref<Record<string, boolean>>({})
const agentUpdateError = ref<Record<string, string>>({})
const managerError = ref('')
const roomActionMenu = ref<{ roomId: string; topicId?: string; x: number; y: number } | null>(null)
const topicActionRenaming = ref(false)
const topicActionRenameValue = ref('')
const topicListRoomId = ref<string | null>(null)
const archivedOverlayOpen = ref(false)
const archivedRoomList = ref<GroupRoomSummary[]>([])
const archivedTopicList = ref<GroupTopicSummary[]>([])

const activeRooms = computed(() => groups.rooms.filter(room => !room.archived))
const roomSidebarItems = computed(() => activeRooms.value.map(room => {
  const currentMembers = room.id === groups.selectedRoomId && displayAgents.value.length
    ? displayAgents.value.slice(0, 4).map(agent => ({
      profile: agent.profile,
      nodeId: agent.nodeId,
      displayName: agent.displayName,
    }))
    : room.avatarMembers
  return roomSidebarItem({ ...room, avatarMembers: currentMembers }, agentAvatars.value, agentAvatarsByName.value)
}))
const pinnedTopics = computed(() => groups.pinnedTopics.filter(topic => !topic.archived).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)))
const topicListRoom = computed(() => topicListRoomId.value ? activeRooms.value.find(room => room.id === topicListRoomId.value) : undefined)
const sidebarSubtitle = computed(() => topicListRoom.value
  ? `${topicListRoom.value.agentCount} 个 Agent`
  : groups.availability === 'available' ? `${activeRooms.value.length} 个活跃团队` : `9119 团队 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL}`)
const GROUP_LIST_BACK_ID = 'group-list'
const NEW_TOPIC_ID = 'new-topic'
function topicSidebarItemId(roomId: string, topicId: string): string { return `topic:${roomId}:${topicId}` }
function topicFromSidebarItemId(id: string): { roomId: string; topicId: string } | undefined {
  const match = /^topic:([^:]+):([^:]+)$/.exec(id)
  return match ? { roomId: match[1]!, topicId: match[2]! } : undefined
}
function topicTimeSection(updatedAt: number): string {
  const timestamp = updatedAt < 10_000_000_000 ? updatedAt * 1000 : updatedAt
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (timestamp >= today.getTime()) return '今天'
  if (timestamp >= yesterday.getTime()) return '昨天'
  return '更早'
}
const sidebarItems = computed<SidebarItem[]>(() => {
  const room = topicListRoom.value
  if (!room) return roomSidebarItems.value.map(item => ({ ...item, section: undefined }))
  const items: SidebarItem[] = [{
    id: GROUP_LIST_BACK_ID,
    title: '返回团队列表',
    icon: 'chevron-left',
    showMore: false,
  }, {
    id: NEW_TOPIC_ID,
    title: '新建话题',
    icon: 'plus',
    showMore: false,
  }]
  const roomTopics = groups.topicsForRoom(room.id)
  items.push(...roomTopics.filter(topic => topic.pinned).map(topic => ({
    id: topicSidebarItemId(room.id, topic.id),
    title: topic.title,
    subtitle: topic.preview || `${topic.messageCount} 条消息`,
    meta: topic.unreadCount ? `${topic.unreadCount} 未读` : `${topic.messageCount} 条`,
    unread: topic.unreadCount,
    pinned: true,
    section: '话题置顶',
    icon: 'topic' as const,
    topic: true,
    showMore: false,
    active: topic.id === groups.selectedTopicId,
  })))
  items.push(...roomTopics.filter(topic => !topic.pinned).map(topic => ({
    id: topicSidebarItemId(room.id, topic.id),
    title: topic.title,
    subtitle: topic.preview || `${topic.messageCount} 条消息`,
    meta: topic.unreadCount ? `${topic.unreadCount} 未读` : `${topic.messageCount} 条`,
    unread: topic.unreadCount,
    section: topicTimeSection(topic.updatedAt),
    icon: 'topic' as const,
    topic: true,
    showMore: false,
    active: topic.id === groups.selectedTopicId,
  })))
  if (room.id === groups.selectedRoomId && groups.selectedTopicId && !groups.selectedTopic) {
    items.push({
      id: topicSidebarItemId(room.id, groups.selectedTopicId),
      title: '新话题',
      subtitle: '发送第一条消息以创建',
      section: '今天',
      icon: 'topic',
      topic: true,
      showMore: false,
      active: true,
    })
  }
  return items
})
const localAgentIdentities = computed(() => new Map(auth.profiles.map(profile => [profile.name, {
  name: profile.agentName || profile.displayName || profile.name,
}])))
const displayAgents = computed(() => groups.agents.map(agent => {
  const identity = agent.nodeId === 'local' ? localAgentIdentities.value.get(agent.profile) : undefined
  return identity ? { ...agent, displayName: identity.name } : agent
}))
const messages = computed(() => groups.messages.map(message => groupMessageToUi(message, displayAgents.value)))
const conversationMediaItems = computed(() => mediaItemsFromMessages(messages.value))
const lightboxMedia = computed(() => conversationMediaItems.value.map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const agents = computed(() => displayAgents.value.map(agentToUi))
const agentAvatars = computed(() => Object.fromEntries(auth.profiles.flatMap(profile =>
  profile.agentAvatar ? [[profile.name, profile.agentAvatar] as const] : []
)))
const agentAvatarsByName = computed(() => Object.fromEntries(auth.profiles.flatMap(profile =>
  profile.agentAvatar ? [[profile.agentName || profile.displayName || profile.name, profile.agentAvatar] as const] : []
)))
function serverAddress(value: string): string {
  try { return new URL(value).host }
  catch { return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') }
}
const remoteServerAddresses = computed(() => Object.fromEntries(groups.nodes
  .filter(node => node.nodeId && node.serverUrl)
  .map(node => [node.nodeId, serverAddress(node.serverUrl)])))
const hostAgent = computed(() => groups.hostProtocol ? displayAgents.value.find(agent => agent.isHost) : undefined)
const connected = computed(() => ['connected', 'ready'].includes(groups.connectionState))
const synced = computed(() => groups.connectionState === 'ready' && !groups.isLoading)
const activeInteraction = computed(() => groupInteraction(groups.pendingInteractions[0]))
const room = computed(() => groups.selectedRoom ? roomToUi(groups.selectedRoom) : null)
const profiles = computed<GroupProfileOption[]>(() => [
  ...auth.profiles.map(profile => ({
    id: `local|${profile.name}`,
    profile: profile.name,
    displayName: profile.agentName || profile.displayName || profile.name,
    nodeId: 'local',
    nodeLabel: '当前 Hermes',
    avatar: profile.agentAvatar,
  })),
  ...groups.nodes.flatMap(node => node.profiles.map(profile => ({
    id: `${node.nodeId}|${profile.name}`,
    profile: profile.name,
    displayName: profile.displayName || profile.name,
    nodeId: node.nodeId,
    nodeLabel: node.name,
  }))),
])
const availableProfiles = computed(() => profiles.value.filter(profile => !groups.agents.some(agent =>
  agent.profile === profile.profile && agent.nodeId === profile.nodeId)))
const uploadsEnabled = computed(() => auth.groupUploadsEnabled)
const managerBusy = computed(() => groups.isLoading || Object.values(agentUpdateBusy.value).some(Boolean))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, author: quoted.value.author, content: quoted.value.content } : null)
const mentionNames = computed(() => ['所有人', ...displayAgents.value.map(agent => agent.displayName || agent.profile)])
const mentionOptions = computed<ComposerOption[]>(() => [
  { id: 'all', label: '所有人', detail: '通知团队内全部 Agent' },
  ...displayAgents.value.map(agent => ({
    id: agent.id,
    label: agent.displayName || agent.profile,
    detail: groups.hostProtocol && agent.isHost ? `主持人 · ${agent.profile}` : agent.profile,
    disabled: !agent.enabled,
  })),
])
const roomSubtitle = computed(() => {
  if (!groups.selectedRoom) return '选择或新建一个团队'
  const host = hostAgent.value ? `主持人 ${hostAgent.value.displayName || hostAgent.value.profile} · ` : ''
  const mode = groups.selectedRoom.orchestrationMode === 'host' ? '主持流程 · ' : ''
  return `${groups.selectedRoom.name} · ${mode}${host}${groups.agents.length} 个 Agent · 最多 ${groups.selectedRoom.maxReplyRounds} 轮回复`
})
const activeAgentIds = computed(() => {
  if (!groups.topicProtocol) {
    return new Set(groups.agents.filter(agent => ['queued', 'running'].includes(agent.status)).map(agent => agent.id))
  }
  return new Set((groups.selectedRoom?.runs ?? [])
    .filter(run => run.topicId === groups.selectedTopicId && ['queued', 'running'].includes(run.status))
    .map(run => run.agentId))
})
const typingAgentIds = computed(() => {
  if (!groups.topicProtocol) return new Set(groups.agents.filter(agent => agent.status === 'running').map(agent => agent.id))
  return new Set((groups.selectedRoom?.runs ?? [])
    .filter(run => run.topicId === groups.selectedTopicId && run.status === 'running')
    .map(run => run.agentId))
})
const typingAgentNames = computed(() => [...new Set(groups.agents
  .filter(agent => typingAgentIds.value.has(agent.id))
  .map(agent => displayAgents.value.find(candidate => candidate.id === agent.id)?.displayName || agent.profile))])
const typingActivity = computed(() => {
  if (!connected.value) return ''
  const names = typingAgentNames.value
  if (!names.length) return ''
  if (names.length <= 3) return `${names.join('、')}正在输入…`
  return `${names.slice(0, 2).join('、')}等 ${names.length} 个 Agent 正在输入…`
})

function groupRoute(roomId = groups.selectedRoomId, topicId = groups.selectedTopicId): string {
  if (!roomId) return '/groups'
  const roomPath = `/groups/${encodeURIComponent(roomId)}`
  return groups.topicProtocol && topicId ? `${roomPath}/${encodeURIComponent(topicId)}` : roomPath
}

const roomActionMenuStyle = computed(() => roomActionMenu.value
  ? { left: `${roomActionMenu.value.x}px`, top: `${roomActionMenu.value.y}px` }
  : {})
const actionTopic = computed(() => {
  const action = roomActionMenu.value
  if (!action?.topicId) return undefined
  return groups.topicsForRoom(action.roomId).find(item => item.id === action.topicId)
    || groups.pinnedTopics.find(item => item.id === action.topicId)
})

function restoreShowThinking(profile = auth.activeProfile?.name || 'default') {
  showThinking.value = readAgentShowThinking(auth.user?.id ?? 'local', profile)
}

function toggleShowThinking() {
  showThinking.value = !showThinking.value
  writeAgentShowThinking(auth.user?.id ?? 'local', auth.activeProfile?.name || 'default', showThinking.value)
}

function stopActiveTopic() {
  for (const agentId of activeAgentIds.value) void groups.interruptAgent(agentId).catch(() => undefined)
}

async function selectRoom(id: string) {
  try { await groups.selectRoom(id) }
  catch { return }
  topicListRoomId.value = id
  await router.push(groupRoute())
  quoted.value = null
}

async function selectTopic(id: string) {
  if (!id || id === groups.selectedTopicId) return
  try { await groups.selectTopic(id) }
  catch { return }
  await router.push(groupRoute())
  quoted.value = null
}

async function selectSidebarItem(id: string) {
  if (id === GROUP_LIST_BACK_ID) {
    topicListRoomId.value = null
    return
  }
  if (id === NEW_TOPIC_ID && topicListRoom.value) {
    await startTopic(topicListRoom.value.id)
    return
  }
  const topic = topicFromSidebarItemId(id)
  if (topic) {
    if (topic.roomId !== groups.selectedRoomId) {
      try { await groups.selectRoom(topic.roomId, topic.topicId) }
      catch { return }
      topicListRoomId.value = topic.roomId
      await router.push(groupRoute())
      quoted.value = null
      return
    }
    await selectTopic(topic.topicId)
    return
  }
  await selectRoom(id)
}

async function openRoomManager(id: string) {
  if (topicFromSidebarItemId(id)) return
  await selectRoom(id)
  managerOpen.value = true
  try { await groups.refreshNodes() }
  catch { /* Keep the current node list when refreshing is unavailable. */ }
}

async function openSelectedRoomManager() {
  managerOpen.value = true
  try { await groups.refreshNodes() }
  catch { /* Keep the current node list when refreshing is unavailable. */ }
}

async function openCreateGroup() {
  try { await groups.refreshNodes() }
  catch { /* A node refresh must not prevent creating a local-only group. */ }
  createOpen.value = true
}

function openRoomActions(roomId: string, event: MouseEvent) {
  const topic = topicFromSidebarItemId(roomId)
  const width = 174
  const height = topic ? 80 : 80
  const inset = 8
  if (topic) {
    topicActionRenaming.value = false
    topicActionRenameValue.value = groups.topicsForRoom(topic.roomId).find(item => item.id === topic.topicId)?.title
      || groups.pinnedTopics.find(item => item.id === topic.topicId)?.title
      || ''
    roomActionMenu.value = {
      roomId: topic.roomId,
      topicId: topic.topicId,
      x: Math.max(inset, Math.min(event.clientX, window.innerWidth - width - inset)),
      y: Math.max(inset, Math.min(event.clientY, window.innerHeight - height - inset)),
    }
    return
  }
  if (!groups.topicProtocol || !activeRooms.value.some(room => room.id === roomId)) return
  roomActionMenu.value = {
    roomId,
    x: Math.max(inset, Math.min(event.clientX, window.innerWidth - width - inset)),
    y: Math.max(inset, Math.min(event.clientY, window.innerHeight - height - inset)),
  }
}

function openTopicActions(roomId: string, topicId: string, event: MouseEvent) {
  openRoomActions(topicSidebarItemId(roomId, topicId), event)
}

function closeRoomActions() {
  roomActionMenu.value = null
  topicActionRenaming.value = false
  topicActionRenameValue.value = ''
}

function handleRoomActionPointer(event: PointerEvent) {
  if (!roomActionMenu.value || (event.target as HTMLElement).closest('.group-room-actions')) return
  closeRoomActions()
}

function handleRoomActionKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && roomActionMenu.value) closeRoomActions()
}

async function startTopicFromRoomAction() {
  const roomId = roomActionMenu.value?.roomId
  if (roomActionMenu.value?.topicId) return
  closeRoomActions()
  if (!roomId) return
  await startTopic(roomId)
}

async function startTopic(roomId: string) {
  try {
    await groups.selectRoom(roomId)
    topicListRoomId.value = roomId
    const topicId = await groups.startNewTopic()
    if (!topicId) return
    await router.push(groupRoute(roomId, topicId))
    quoted.value = null
    await nextTick()
    composer.value?.focus()
  } catch { /* store publishes the error */ }
}

async function createRoom(payload: { name: string; avatar?: string; members: Array<GroupProfileOption & { description?: string }>; autoReply: boolean; replyRounds: number; instructions?: string; hostProfile?: string; orchestrationMode?: 'free' | 'host' }) {
  const hostProfile = payload.hostProfile || payload.members[0]?.id
  const detail = await groups.createRoom({
    name: payload.name,
    ...(groups.roomAvatarProtocol ? { avatar: payload.avatar ?? '' } : {}),
    ...(groups.roomInstructionsProtocol ? { instructions: payload.instructions ?? '' } : {}),
    agents: payload.members.map(member => ({
      profile: member.profile,
      nodeId: member.nodeId,
      nodeLabel: member.nodeLabel,
      displayName: member.displayName,
      description: member.description,
      replyWithoutMention: payload.autoReply,
      ...(groups.hostProtocol ? { isHost: member.id === hostProfile } : {}),
    })),
    maxReplyRounds: payload.replyRounds,
    ...(groups.hostFlowProtocol ? { orchestrationMode: payload.orchestrationMode ?? 'free' } : {}),
  })
  createOpen.value = false
  await router.push(groupRoute(detail.id, groups.selectedTopicId))
}

async function send(payload: ComposerSubmit) {
  const prefix = quoted.value ? `> ${quoted.value.content.replace(/\n/g, '\n> ')}\n\n` : ''
  try {
    await groups.sendMessage(`${prefix}${payload.text}`, payload.mentionIds, payload.files)
    quoted.value = null
    composer.value?.clearAfterSend()
  } catch { /* store publishes the error */ }
}

async function updateRoom(patch: { name?: string; instructions?: string; avatar?: string; replyRounds?: number; orchestrationMode?: 'free' | 'host' }) {
  if (!groups.selectedRoom) return
  await groups.updateRoom(groups.selectedRoom.id, {
    name: patch.name,
    ...(groups.roomInstructionsProtocol ? { instructions: patch.instructions } : {}),
    ...(groups.roomAvatarProtocol ? { avatar: patch.avatar } : {}),
    maxReplyRounds: patch.replyRounds,
    ...(groups.hostFlowProtocol ? { orchestrationMode: patch.orchestrationMode } : {}),
  })
}

async function addAgent(profileID: string) {
  if (!groups.selectedRoom) return
  const member = profiles.value.find(profile => profile.id === profileID)
  if (!member) return
  await groups.addAgent(groups.selectedRoom.id, {
    profile: member.profile,
    nodeId: member.nodeId,
    nodeLabel: member.nodeLabel,
    displayName: member.displayName,
    replyWithoutMention: true,
    ...(groups.hostProtocol ? { isHost: false } : {}),
  })
}

type AgentSettingsPatch = Partial<Pick<GroupAgent,
  'displayName' | 'description' | 'enabled' | 'replyWithoutMention' | 'isHost' | 'model' | 'provider' | 'reasoningEffort' | 'fastMode'>>

async function loadAgentModels(profile: string) {
  if (modelOptionsLoading.value[profile] || Object.prototype.hasOwnProperty.call(modelOptionsByProfile.value, profile)) return
  modelOptionsLoading.value = { ...modelOptionsLoading.value, [profile]: true }
  modelOptionsError.value = { ...modelOptionsError.value, [profile]: '' }
  try {
    modelOptionsByProfile.value = { ...modelOptionsByProfile.value, [profile]: await getModels(profile) }
  } catch (cause) {
    modelOptionsError.value = { ...modelOptionsError.value, [profile]: cause instanceof Error ? cause.message : '模型选项加载失败' }
  } finally {
    modelOptionsLoading.value = { ...modelOptionsLoading.value, [profile]: false }
  }
}

async function updateAgent(id: string, patch: AgentSettingsPatch) {
  if (!groups.selectedRoom) return
  managerError.value = ''
  agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: true }
  agentUpdateError.value = { ...agentUpdateError.value, [id]: '' }
  try { await groups.updateAgent(groups.selectedRoom.id, id, patch) }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Agent 设置保存失败'
    agentUpdateError.value = { ...agentUpdateError.value, [id]: message }
    managerError.value = message
  }
  finally { agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: false } }
}

async function removeAgent(id: string) {
  if (!groups.selectedRoom) return
  managerError.value = ''
  agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: true }
  try { await groups.removeAgent(groups.selectedRoom.id, id) }
  catch (cause) { managerError.value = cause instanceof Error ? cause.message : '移除 Agent 失败' }
  finally { agentUpdateBusy.value = { ...agentUpdateBusy.value, [id]: false } }
}

function clearAgentError(id: string) {
  if (!agentUpdateError.value[id]) return
  agentUpdateError.value = { ...agentUpdateError.value, [id]: '' }
  managerError.value = ''
}

async function archiveRoom() {
  if (!groups.selectedRoom) return
  await groups.archiveRoom(groups.selectedRoom.id)
  managerOpen.value = false
  await router.replace(groupRoute())
}

async function openArchivedOverlay() {
  archivedOverlayOpen.value = true
  archivedRoomList.value = await groups.archivedRooms()
  archivedTopicList.value = groups.selectedRoomId
    ? await groups.archivedTopics(groups.selectedRoomId)
    : []
}

async function restoreArchivedRoom(roomId: string) {
  await groups.restoreRoom(roomId)
  archivedRoomList.value = await groups.archivedRooms()
}

async function archiveTopicFromAction() {
  const action = roomActionMenu.value
  closeRoomActions()
  if (!action?.topicId) return
  await groups.archiveTopic(action.roomId, action.topicId)
}

async function toggleTopicPinnedFromAction() {
  const action = roomActionMenu.value
  const topic = actionTopic.value
  closeRoomActions()
  if (!action?.topicId) return
  await groups.setTopicPinned(action.roomId, action.topicId, !topic?.pinned)
}

async function renameTopicFromAction() {
  const action = roomActionMenu.value
  const title = topicActionRenameValue.value.trim()
  if (!action?.topicId || !title) return
  await groups.renameTopic(action.roomId, action.topicId, title)
  closeRoomActions()
}

async function archiveRoomFromAction() {
  const action = roomActionMenu.value
  closeRoomActions()
  if (!action || action.topicId) return
  await groups.archiveRoom(action.roomId)
  if (route.params.roomId === action.roomId) await router.replace(groupRoute())
}

async function restoreArchivedTopic(topicId: string) {
  const roomId = groups.selectedRoomId
  if (!roomId) return
  await groups.restoreTopic(roomId, topicId)
  archivedTopicList.value = await groups.archivedTopics(roomId)
}

function openLocalFile({ name, url }: { name: string; url: string }) {
  const item = previewItemFromUrl(name, url)
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else preview.value = item
}

function openMedia(item: UiLibraryItem) {
  const target = mediaUrlIdentity(item.previewUrl || item.downloadUrl || '')
  const index = lightboxMedia.value.findIndex(media => mediaUrlIdentity(media.url) === target)
  mediaPreviewIndex.value = index >= 0 ? index : null
}

function openAttachment(attachment: NonNullable<UiMessage['attachments']>[number]) {
  const item = previewItemFromUrl(attachment.name, attachment.url || '', attachment.id, attachment.kind)
  item.size = attachment.size
  if (item.kind === 'image' || item.kind === 'video') openMedia(item)
  else preview.value = item
}

async function addPreviewToComposer(item: UiLibraryItem) {
  if (!uploadsEnabled.value) return
  const file = await loadComposerFile(item)
  if (!file || !composer.value) return
  composer.value.attachFiles([file])
  preview.value = null
  mediaPreviewIndex.value = null
  await nextTick()
  composer.value?.focus()
}

async function addMediaToComposer(media: PreviewMedia) {
  await addPreviewToComposer(previewItemFromUrl(media.name, media.url, `preview:${media.url}`, media.type))
}

onMounted(async () => {
  document.addEventListener('pointerdown', handleRoomActionPointer)
  document.addEventListener('keydown', handleRoomActionKey)
  restoreShowThinking()
  try {
    await groups.start()
    const requested = typeof route.params.roomId === 'string' ? route.params.roomId : ''
    const requestedTopic = typeof route.params.topicId === 'string' ? route.params.topicId : undefined
    if (requested) {
      try { await groups.selectRoom(requested, requestedTopic) }
      catch {
        if (groups.selectedRoomId) await router.replace(groupRoute())
        return
      }
    }
    if (groups.selectedRoomId) {
      if (route.fullPath !== groupRoute()) await router.replace(groupRoute())
    }
  } catch { /* availability state renders the error */ }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleRoomActionPointer)
  document.removeEventListener('keydown', handleRoomActionKey)
  groups.stop()
})

watch(() => [route.params.roomId, route.params.topicId] as const, async ([roomValue, topicValue]) => {
  const roomId = typeof roomValue === 'string' ? roomValue : ''
  const topicId = typeof topicValue === 'string' ? topicValue : undefined
  if (roomId && (roomId !== groups.selectedRoomId || (groups.topicProtocol && topicId && topicId !== groups.selectedTopicId))) {
    try { await groups.selectRoom(roomId, topicId) }
    catch { if (groups.selectedRoomId && route.fullPath !== groupRoute()) await router.replace(groupRoute()) }
  }
})
watch(() => groups.selectedRoomId, () => {
  managerError.value = ''
  agentUpdateError.value = {}
})
watch(() => auth.activeProfile?.name, profile => { if (profile) restoreShowThinking(profile) })
</script>

<template>
  <WorkspaceView sidebar-title="团队" :sidebar-context-title="topicListRoom?.name" :sidebar-subtitle="sidebarSubtitle" :sidebar-focus-mode="!!topicListRoom" :inspector-open="managerOpen && !!room" inspector-close-label="关闭团队管理" @close-inspector="managerOpen = false">
    <template #sidebar-action>
      <button class="sidebar-primary-action" type="button" :disabled="groups.availability !== 'available'" title="新建团队" aria-label="新建团队" @click="openCreateGroup">
        <YaoYaoSidebarIcon name="add" />
        <span>新建团队</span>
      </button>
      <button class="sidebar-primary-action" type="button" :disabled="groups.availability !== 'available'" @click="openArchivedOverlay">
        <AppIcon name="archive" :size="15" />
        <span>已归档</span>
      </button>
    </template>
    <template #sidebar-before-heading>
      <section v-if="pinnedTopics.length && !topicListRoom" class="pinned-topic-list" aria-label="话题置顶">
        <header class="pinned-topic-list__heading"><strong>话题置顶</strong><span>{{ pinnedTopics.length }} 个置顶话题</span></header>
        <button v-for="topic in pinnedTopics" :key="topic.id" class="pinned-topic-list__item" type="button" :class="{ active: topic.id === groups.selectedTopicId }" @click="selectSidebarItem(topicSidebarItemId(topic.roomId, topic.id))" @contextmenu.prevent.stop="openTopicActions(topic.roomId, topic.id, $event)">
          <AppIcon name="topic" :size="14" />
          <span>{{ topic.title }}</span>
          <small>{{ activeRooms.find(room => room.id === topic.roomId)?.name || topic.preview }}</small>
        </button>
      </section>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :class="{ 'group-topic-focus-sidebar': !!topicListRoom }"
        :items="sidebarItems"
        :active-id="groups.selectedRoomId"
        :loading="groups.isLoading"
        external-search
        search-placeholder="搜索团队"
        empty-title="还没有团队"
        empty-description="新建团队，邀请 1–8 个 Agent 一起协作。"
        @select="selectSidebarItem"
        @more="openRoomManager"
        @context-menu="openRoomActions"
      />
    </template>

    <div v-if="groups.availability === 'unsupported' || groups.availability === 'unavailable'" class="groups-unavailable">
      <EmptyState icon="alert" :title="groups.availability === 'unsupported' ? '团队协议版本不兼容' : '团队服务暂不可用'" :description="groups.error || `请确认 9119 已安装 YaoYao 团队协议 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL} 插件。`" action-label="重新检查" @action="groups.refresh" />
    </div>
    <div v-else class="groups-workspace">
      <MessageTimeline
        :messages="messages"
        :title="groups.topicProtocol ? (groups.selectedTopic?.title || '新话题') : (groups.selectedRoom?.name || '团队')"
        :subtitle="roomSubtitle"
        :loading="groups.isLoading"
        :has-older="groups.hasMoreBefore"
        :connected="connected"
        :synced="synced"
        :show-tools="showThinking"
        :interaction="activeInteraction"
        :mention-names="mentionNames"
        :agent-avatars="agentAvatars"
        :empty-title="groups.topicProtocol ? '开始一个新话题' : '让多个 Agent 一起工作'"
        :empty-description="groups.topicProtocol ? '第一条消息会创建独立话题，各话题分别保留 Agent 上下文。' : '使用 @ 提及指定 Agent，或直接发送消息触发已启用自动回复的成员。'"
        @load-older="groups.loadOlder"
        @quote="quoted = $event"
        @preview="openAttachment"
        @preview-file="openLocalFile"
        @approve="activeInteraction && groups.approveInteraction(activeInteraction.id, $event ? 'once' : 'deny')"
        @clarify="activeInteraction && groups.clarifyInteraction(activeInteraction.id, $event)"
      >
        <template #header-actions>
          <div class="group-header-actions">
            <span v-if="hostAgent" class="group-host-chip" :title="`用户未明确 @ 时由 ${hostAgent.displayName || hostAgent.profile} 负责回应`">主持人 {{ hostAgent.displayName || hostAgent.profile }}</span>
            <div class="group-avatars" aria-label="团队成员"><AgentAvatar v-for="agent in agents.slice(0, 4)" :key="agent.id" :name="agent.name" :avatar="agent.nodeId === 'local' ? agentAvatars[agent.profile || ''] || '' : ''" :size="24" :title="agent.isHost ? `${agent.name} · 主持人` : agent.name" /><em v-if="agents.length > 4">+{{ agents.length - 4 }}</em></div>
            <button class="icon-button" type="button" title="管理团队" aria-label="管理团队" :disabled="!groups.selectedRoom" @click="openSelectedRoomManager"><AppIcon name="dots" /></button>
          </div>
        </template>
      </MessageTimeline>
      <p v-if="groups.error" class="group-error" role="alert"><AppIcon name="alert" :size="13" />{{ groups.error }}</p>
      <ComposerShell
        ref="composer"
        mode="group"
        :draft-key="`${auth.user?.id || 'local'}:${groups.selectedRoomId || 'new'}:${groups.selectedTopicId || 'legacy'}`"
        :disabled="!groups.selectedRoom || groups.availability !== 'available'"
        :streaming="activeAgentIds.size > 0"
        :sending="groups.isSending"
        :activity-text="typingActivity"
        :tool-trace-visible="showThinking"
        :reference="reference"
        :mention-options="mentionOptions"
        :attachments-enabled="uploadsEnabled"
        placeholder="发消息给团队，输入 @ 提及 Agent"
        @send="send"
        @stop="stopActiveTopic"
        @tool-trace-toggle="toggleShowThinking"
        @clear-reference="quoted = null"
      />
    </div>

    <template #inspector>
      <GroupManager
        v-if="room && groups.selectedRoom"
        :room="room"
        :agents="displayAgents"
        :host-enabled="groups.hostProtocol"
        :host-flow-enabled="groups.hostFlowProtocol"
        :room-instructions-enabled="groups.roomInstructionsProtocol"
        :avatar-enabled="groups.roomAvatarProtocol"
        :available-profiles="availableProfiles"
        :busy="managerBusy"
        :model-options-by-profile="modelOptionsByProfile"
        :model-options-loading="modelOptionsLoading"
        :model-options-error="modelOptionsError"
        :remote-server-addresses="remoteServerAddresses"
        :agent-update-error="agentUpdateError"
        :agent-avatars="agentAvatars"
        :manager-error="managerError"
        @update-room="updateRoom"
        @add-agent="addAgent"
        @load-models="loadAgentModels"
        @clear-agent-error="clearAgentError"
        @update-agent="updateAgent"
        @remove-agent="removeAgent"
        @interrupt-agent="groups.interruptAgent($event, groups.selectedRoom.id)"
        @archive-room="archiveRoom"
      />
    </template>
  </WorkspaceView>

  <FloatingResourceSearch section="groups" label="搜索团队" :items="roomSidebarItems" @select="selectRoom" />
  <CreateGroupDialog :open="createOpen" :profiles="profiles" :avatar-enabled="groups.roomAvatarProtocol" :host-enabled="groups.hostProtocol" :host-flow-enabled="groups.hostFlowProtocol" :room-instructions-enabled="groups.roomInstructionsProtocol" :busy="groups.isLoading" @close="createOpen = false" @create="createRoom" />
  <PreviewModal v-if="preview" :item="preview" :items="conversationMediaItems" @close="preview = null" @add-to-composer="addPreviewToComposer" @source="preview = null" />
  <ImagePreviewLightbox v-model="mediaPreviewIndex" :images="lightboxMedia" :can-add="uploadsEnabled" @add="addMediaToComposer" />

  <Teleport to="body">
    <Transition name="group-menu">
      <section v-if="roomActionMenu" class="group-room-actions" :style="roomActionMenuStyle" role="menu" aria-label="团队操作" @contextmenu.prevent>
        <template v-if="roomActionMenu.topicId">
          <template v-if="topicActionRenaming">
            <label class="group-topic-rename">话题名称<input v-model="topicActionRenameValue" maxlength="120" autofocus @keydown.enter="renameTopicFromAction" /></label>
            <div class="group-topic-rename__actions"><button class="quiet-button" type="button" @click="topicActionRenaming = false">取消</button><button class="solid-button" type="button" @click="renameTopicFromAction">保存</button></div>
          </template>
          <template v-else>
            <button class="group-action-row" role="menuitem" type="button" @click="toggleTopicPinnedFromAction"><AppIcon :name="actionTopic?.pinned ? 'pin-off' : 'pin'" :size="14" />{{ actionTopic?.pinned ? '取消置顶' : '置顶话题' }}</button>
            <button class="group-action-row" role="menuitem" type="button" @click="topicActionRenaming = true"><AppIcon name="edit" :size="14" />重命名</button>
            <button class="group-action-row danger" role="menuitem" type="button" @click="archiveTopicFromAction"><AppIcon name="archive" :size="14" />归档话题</button>
          </template>
        </template>
        <template v-else>
          <button class="group-action-row" role="menuitem" type="button" @click="startTopicFromRoomAction"><AppIcon name="plus" :size="14" />新建话题</button>
          <button class="group-action-row danger" role="menuitem" type="button" @click="archiveRoomFromAction"><AppIcon name="archive" :size="14" />归档团队</button>
        </template>
      </section>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="group-menu">
      <div v-if="archivedOverlayOpen" class="archived-overlay-backdrop" role="presentation" @click.self="archivedOverlayOpen = false">
        <section class="archived-overlay" role="dialog" aria-modal="true" aria-label="已归档团队和话题">
          <header><div><small>团队归档</small><strong>已归档内容</strong></div><button type="button" aria-label="关闭" @click="archivedOverlayOpen = false"><AppIcon name="close" :size="16" /></button></header>
          <section class="archived-section"><h3>团队</h3><p v-if="!archivedRoomList.length">没有已归档团队</p><article v-for="archived in archivedRoomList" :key="archived.id"><span>{{ archived.name }}</span><button type="button" @click="restoreArchivedRoom(archived.id)">恢复</button></article></section>
          <section class="archived-section"><h3>当前团队的话题</h3><p v-if="!groups.selectedRoom">请先打开一个团队查看其已归档话题</p><p v-else-if="!archivedTopicList.length">没有已归档话题</p><article v-for="topic in archivedTopicList" :key="topic.id"><span>{{ topic.title }}</span><button type="button" @click="restoreArchivedTopic(topic.id)">恢复</button></article></section>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.groups-workspace, .groups-unavailable { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; background: var(--conversation-canvas); }.groups-unavailable { overflow: auto; }
.group-room-actions { position: fixed; z-index: 205; width: 174px; box-sizing: border-box; padding: 6px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-raised); box-shadow: 0 12px 34px rgba(0,0,0,.16); }
.group-action-row { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; text-align: left; }.group-action-row:hover, .group-action-row:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }
.group-action-row.danger:hover, .group-action-row.danger:focus-visible { color: var(--danger); }
.group-topic-rename { display: grid; gap: 6px; padding: 6px 8px; color: var(--text-secondary); font-size: 10px; }.group-topic-rename input { width: 100%; min-height: 30px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font: inherit; }.group-topic-rename input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.group-topic-rename__actions { display: flex; justify-content: flex-end; gap: 6px; padding: 2px 8px 5px; }.group-topic-rename__actions button { min-height: 28px; padding: 0 8px; font-size: 10px; }
.group-menu-enter-active, .group-menu-leave-active { transition: opacity 100ms ease, transform 120ms var(--ease-out); transform-origin: top right; }.group-menu-enter-from, .group-menu-leave-to { opacity: 0; transform: translateY(-3px) scale(.98); }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action:disabled { cursor: not-allowed; opacity: .35; }
.pinned-topic-list { max-height: 154px; overflow: auto; padding: 0 10px 4px; border-bottom: 1px solid var(--line); }
.pinned-topic-list__heading { display: flex; min-height: 35px; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 11px 5px; }
.pinned-topic-list__heading strong { font-size: 12px; font-weight: 680; }.pinned-topic-list__heading span { overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.pinned-topic-list__item { display: flex; width: 100%; min-height: 32px; align-items: center; gap: 7px; padding: 1px 9px; border: 0; border-radius: 8px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.pinned-topic-list__item:hover, .pinned-topic-list__item.active { background: var(--surface-hover); }.pinned-topic-list__item :deep(.app-icon) { flex: 0 0 auto; color: var(--text-muted); }.pinned-topic-list__item > span { min-width: 0; overflow: hidden; font-size: 10.5px; font-weight: 450; text-overflow: ellipsis; white-space: nowrap; }.pinned-topic-list__item small { margin-left: auto; overflow: hidden; color: var(--text-muted); font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }
.group-topic-focus-sidebar :deep(.sidebar-list) { padding: 0 0 14px; }
.group-topic-focus-sidebar :deep(.sidebar-section-label) { margin-inline: 10px; }
.group-topic-focus-sidebar :deep(.sidebar-item:not([data-sidebar-id="group-list"])) { width: calc(100% - 20px); margin-inline: 10px; }
.group-topic-focus-sidebar :deep([data-sidebar-id="group-list"]) { position: sticky; z-index: 3; top: 0; min-height: 58px; padding-inline: 17px; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--surface); }
.group-topic-focus-sidebar :deep([data-sidebar-id="group-list"]:hover), .group-topic-focus-sidebar :deep([data-sidebar-id="group-list"]:focus-visible) { background: var(--surface-hover); }
.archived-overlay-backdrop { position: fixed; z-index: 220; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.36); }.archived-overlay { width: min(460px, 100%); max-height: min(620px, calc(100vh - 40px)); overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: 0 24px 70px rgba(0,0,0,.28); }.archived-overlay header { display: flex; align-items: center; justify-content: space-between; padding: 18px 18px 14px; border-bottom: 1px solid var(--line); }.archived-overlay header small { display: block; color: var(--text-secondary); font-size: 10px; }.archived-overlay header strong { font-size: 15px; }.archived-overlay header button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }.archived-section { display: grid; gap: 8px; padding: 16px 18px; }.archived-section + .archived-section { border-top: 1px solid var(--line); }.archived-section h3 { margin: 0; font-size: 12px; }.archived-section p { margin: 0; color: var(--text-secondary); font-size: 12px; }.archived-section article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; }.archived-section article span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.archived-section article button { border: 0; border-radius: 7px; background: var(--surface-hover); color: var(--text-primary); cursor: pointer; padding: 5px 9px; }
.group-header-actions { display: flex; align-items: center; gap: 8px; }.group-host-chip { max-width: 150px; overflow: hidden; padding: 4px 7px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); font-size: 9px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.group-avatars { display: flex; align-items: center; }.group-avatars span, .group-avatars em { display: grid; width: 24px; height: 24px; margin-left: -5px; place-items: center; border: 2px solid var(--canvas); border-radius: 8px; font-size: 8px; font-style: normal; font-weight: 650; }.group-avatars span { background: transparent; color: var(--text-secondary); }.group-avatars span:first-child { margin-left: 0; }.group-avatars em { background: var(--surface-hover); color: var(--text-secondary); }
.group-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
@media (max-width: 480px) { .group-avatars, .group-host-chip { display: none; } }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action, .group-menu-enter-active, .group-menu-leave-active { transition: none; } }
</style>

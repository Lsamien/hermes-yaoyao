<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '@shared/types'
import type { GroupAgent, ModelOption } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import type { ComposerOption, ComposerReference, ComposerSubmit } from '@/components/composer/types'
import CreateGroupDialog from '@/components/groups/CreateGroupDialog.vue'
import GroupManager from '@/components/groups/GroupManager.vue'
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
const roomActionMenu = ref<{ roomId: string; x: number; y: number } | null>(null)
const expandedRoomIds = ref(new Set<string>())

const activeRooms = computed(() => groups.rooms.filter(room => !room.archived))
const roomSidebarItems = computed(() => activeRooms.value.map(roomSidebarItem))
function topicSidebarItemId(roomId: string, topicId: string): string { return `topic:${roomId}:${topicId}` }
function topicFromSidebarItemId(id: string): { roomId: string; topicId: string } | undefined {
  const match = /^topic:([^:]+):([^:]+)$/.exec(id)
  return match ? { roomId: match[1]!, topicId: match[2]! } : undefined
}
const sidebarItems = computed<SidebarItem[]>(() => activeRooms.value.flatMap(room => {
  const roomItem = roomSidebarItem(room)
  const expanded = groups.topicProtocol && expandedRoomIds.value.has(room.id)
  roomItem.expandable = groups.topicProtocol
  roomItem.expanded = expanded
  const items: SidebarItem[] = [roomItem]
  if (!expanded) return items
  items.push(...groups.topicsForRoom(room.id).map(topic => ({
    id: topicSidebarItemId(room.id, topic.id),
    title: topic.title,
    subtitle: topic.preview || `${topic.messageCount} 条消息`,
    meta: topic.unreadCount ? `${topic.unreadCount} 未读` : `${topic.messageCount} 条`,
    unread: topic.unreadCount,
    section: roomItem.section,
    icon: 'branch' as const,
    nested: true,
    showMore: false,
    active: topic.id === groups.selectedTopicId,
  })))
  if (room.id === groups.selectedRoomId && groups.selectedTopicId && !groups.selectedTopic) {
    items.push({
      id: topicSidebarItemId(room.id, groups.selectedTopicId),
      title: '新话题',
      subtitle: '发送第一条消息以创建',
      section: roomItem.section,
      icon: 'branch',
      nested: true,
      showMore: false,
      active: true,
    })
  }
  return items
}))
const messages = computed(() => groups.messages.map(groupMessageToUi))
const conversationMediaItems = computed(() => mediaItemsFromMessages(messages.value))
const lightboxMedia = computed(() => conversationMediaItems.value.map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const agents = computed(() => groups.agents.map(agentToUi))
const hostAgent = computed(() => groups.hostProtocol ? groups.agents.find(agent => agent.isHost) : undefined)
const connected = computed(() => ['connected', 'ready'].includes(groups.connectionState))
const activeInteraction = computed(() => groupInteraction(groups.pendingInteractions[0]))
const room = computed(() => groups.selectedRoom ? roomToUi(groups.selectedRoom) : null)
const profiles = computed(() => auth.profiles.map(profile => profile.name))
const availableProfiles = computed(() => profiles.value.filter(profile => !groups.agents.some(agent => agent.profile === profile)))
const uploadsEnabled = computed(() => auth.groupUploadsEnabled)
const managerBusy = computed(() => groups.isLoading || Object.values(agentUpdateBusy.value).some(Boolean))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, author: quoted.value.author, content: quoted.value.content } : null)
const mentionNames = computed(() => ['所有人', ...groups.agents.map(agent => agent.displayName || agent.profile)])
const mentionOptions = computed<ComposerOption[]>(() => [
  { id: 'all', label: '所有人', detail: '通知房间内全部 Agent' },
  ...groups.agents.map(agent => ({
    id: agent.id,
    label: agent.displayName || agent.profile,
    detail: groups.hostProtocol && agent.isHost ? `主持人 · ${agent.profile}` : agent.profile,
    disabled: !agent.enabled,
  })),
])
const roomSubtitle = computed(() => {
  if (!groups.selectedRoom) return '选择或新建一个群聊'
  const host = hostAgent.value ? `主持人 ${hostAgent.value.displayName || hostAgent.value.profile} · ` : ''
  return `${groups.selectedRoom.name} · ${host}${groups.agents.length} 个 Agent · 最多 ${groups.selectedRoom.maxReplyRounds} 轮回复`
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
  .map(agent => agent.displayName || agent.profile))])
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
  expandRoom(id)
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
  const topic = topicFromSidebarItemId(id)
  if (topic) {
    if (topic.roomId !== groups.selectedRoomId) {
      try { await groups.selectRoom(topic.roomId, topic.topicId) }
      catch { return }
      expandRoom(topic.roomId)
      await router.push(groupRoute())
      quoted.value = null
      return
    }
    await selectTopic(topic.topicId)
    return
  }
  await selectRoom(id)
}

function expandRoom(roomId: string) {
  if (!groups.topicProtocol || expandedRoomIds.value.has(roomId)) return
  expandedRoomIds.value = new Set([...expandedRoomIds.value, roomId])
}

async function toggleRoomTopics(roomId: string) {
  if (!groups.topicProtocol) return
  if (expandedRoomIds.value.has(roomId)) {
    const next = new Set(expandedRoomIds.value)
    next.delete(roomId)
    expandedRoomIds.value = next
    return
  }
  expandRoom(roomId)
  try { await groups.loadRoomTopics(roomId) }
  catch { /* store-level request errors are surfaced when the room is opened */ }
}

async function openRoomManager(id: string) {
  if (topicFromSidebarItemId(id)) return
  await selectRoom(id)
  managerOpen.value = true
}

function openRoomActions(roomId: string, event: MouseEvent) {
  if (!groups.topicProtocol || topicFromSidebarItemId(roomId) || !activeRooms.value.some(room => room.id === roomId)) return
  const width = 174
  const height = 46
  const inset = 8
  roomActionMenu.value = {
    roomId,
    x: Math.max(inset, Math.min(event.clientX, window.innerWidth - width - inset)),
    y: Math.max(inset, Math.min(event.clientY, window.innerHeight - height - inset)),
  }
}

function closeRoomActions() { roomActionMenu.value = null }

function handleRoomActionPointer(event: PointerEvent) {
  if (!roomActionMenu.value || (event.target as HTMLElement).closest('.group-room-actions')) return
  closeRoomActions()
}

function handleRoomActionKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && roomActionMenu.value) closeRoomActions()
}

async function startTopicFromRoomAction() {
  const roomId = roomActionMenu.value?.roomId
  closeRoomActions()
  if (!roomId) return
  try {
    await groups.selectRoom(roomId)
    expandRoom(roomId)
    const topicId = await groups.startNewTopic()
    if (!topicId) return
    await router.push(groupRoute(roomId, topicId))
    quoted.value = null
    await nextTick()
    composer.value?.focus()
  } catch { /* store publishes the error */ }
}

async function createRoom(payload: { name: string; profiles: string[]; autoReply: boolean; replyRounds: number; hostProfile?: string }) {
  const hostProfile = payload.hostProfile || payload.profiles[0]
  const detail = await groups.createRoom({
    name: payload.name,
    agents: payload.profiles.map(profile => ({
      profile,
      displayName: auth.profiles.find(item => item.name === profile)?.agentName || auth.profiles.find(item => item.name === profile)?.displayName || profile,
      replyWithoutMention: payload.autoReply,
      ...(groups.hostProtocol ? { isHost: profile === hostProfile } : {}),
    })),
    maxReplyRounds: payload.replyRounds,
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

async function updateRoom(patch: { name?: string; replyRounds?: number }) {
  if (!groups.selectedRoom) return
  await groups.updateRoom(groups.selectedRoom.id, { name: patch.name, maxReplyRounds: patch.replyRounds })
}

async function addAgent(profile: string) {
  if (!groups.selectedRoom) return
  await groups.addAgent(groups.selectedRoom.id, {
    profile,
    displayName: auth.profiles.find(item => item.name === profile)?.agentName || auth.profiles.find(item => item.name === profile)?.displayName || profile,
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
      expandRoom(groups.selectedRoomId)
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
watch(() => groups.selectedRoomId, roomId => {
  if (roomId) expandRoom(roomId)
  managerError.value = ''
  agentUpdateError.value = {}
})
watch(() => groups.topicProtocol, supported => { if (supported && groups.selectedRoomId) expandRoom(groups.selectedRoomId) })
watch(() => auth.activeProfile?.name, profile => { if (profile) restoreShowThinking(profile) })
</script>

<template>
  <WorkspaceView sidebar-title="群聊" :sidebar-subtitle="groups.availability === 'available' ? `${activeRooms.length} 个活跃房间` : `9119 群聊 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL}`" :inspector-open="managerOpen && !!room" inspector-close-label="关闭群聊管理" @close-inspector="managerOpen = false">
    <template #sidebar-action>
      <button class="sidebar-primary-action" type="button" :disabled="groups.availability !== 'available'" title="新建群聊" aria-label="新建群聊" @click="createOpen = true">
        <YaoYaoSidebarIcon name="add" />
        <span>新建群聊</span>
      </button>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :items="sidebarItems"
        :active-id="groups.selectedRoomId"
        :loading="groups.isLoading"
        external-search
        search-placeholder="搜索群聊"
        empty-title="还没有群聊"
        empty-description="新建群聊，邀请 1–8 个 Agent 一起协作。"
        @select="selectSidebarItem"
        @more="openRoomManager"
        @context-menu="openRoomActions"
        @toggle="toggleRoomTopics"
      />
    </template>

    <div v-if="groups.availability === 'unsupported' || groups.availability === 'unavailable'" class="groups-unavailable">
      <EmptyState icon="alert" :title="groups.availability === 'unsupported' ? '群聊协议版本不兼容' : '群聊服务暂不可用'" :description="groups.error || `请确认 9119 已安装 YaoYao 群聊 protocol ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL} 插件。`" action-label="重新检查" @action="groups.refresh" />
    </div>
    <div v-else class="groups-workspace">
      <MessageTimeline
        :messages="messages"
        :title="groups.topicProtocol ? (groups.selectedTopic?.title || '新话题') : (groups.selectedRoom?.name || '群聊')"
        :subtitle="roomSubtitle"
        :loading="groups.isLoading"
        :has-older="groups.hasMoreBefore"
        :connected="connected"
        :synced="!!groups.selectedRoom"
        :show-tools="showThinking"
        :interaction="activeInteraction"
        :mention-names="mentionNames"
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
            <div class="group-avatars" aria-label="群聊成员"><span v-for="agent in agents.slice(0, 4)" :key="agent.id" :title="agent.isHost ? `${agent.name} · 主持人` : agent.name" :class="{ host: agent.isHost }">{{ agent.name.slice(0, 1).toUpperCase() }}</span><em v-if="agents.length > 4">+{{ agents.length - 4 }}</em></div>
            <button class="icon-button" type="button" title="管理群聊" aria-label="管理群聊" :disabled="!groups.selectedRoom" @click="managerOpen = true"><AppIcon name="dots" /></button>
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
        placeholder="发消息给群聊，输入 @ 提及 Agent"
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
        :agents="groups.agents"
        :host-enabled="groups.hostProtocol"
        :available-profiles="availableProfiles"
        :busy="managerBusy"
        :model-options-by-profile="modelOptionsByProfile"
        :model-options-loading="modelOptionsLoading"
        :model-options-error="modelOptionsError"
        :agent-update-error="agentUpdateError"
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

  <FloatingResourceSearch section="groups" label="搜索群聊" :items="roomSidebarItems" @select="selectRoom" />
  <CreateGroupDialog :open="createOpen" :profiles="profiles" :host-enabled="groups.hostProtocol" :busy="groups.isLoading" @close="createOpen = false" @create="createRoom" />
  <PreviewModal v-if="preview" :item="preview" :items="conversationMediaItems" @close="preview = null" @add-to-composer="addPreviewToComposer" @source="preview = null" />
  <ImagePreviewLightbox v-model="mediaPreviewIndex" :images="lightboxMedia" :can-add="uploadsEnabled" @add="addMediaToComposer" />

  <Teleport to="body">
    <Transition name="group-menu">
      <section v-if="roomActionMenu" class="group-room-actions" :style="roomActionMenuStyle" role="menu" aria-label="群聊房间操作" @contextmenu.prevent>
        <button class="group-action-row" role="menuitem" type="button" @click="startTopicFromRoomAction"><AppIcon name="plus" :size="14" />新建话题</button>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.groups-workspace, .groups-unavailable { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; background: var(--conversation-canvas); }.groups-unavailable { overflow: auto; }
.group-room-actions { position: fixed; z-index: 205; width: 174px; box-sizing: border-box; padding: 6px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-raised); box-shadow: 0 12px 34px rgba(0,0,0,.16); }
.group-action-row { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; text-align: left; }.group-action-row:hover, .group-action-row:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }
.group-menu-enter-active, .group-menu-leave-active { transition: opacity 100ms ease, transform 120ms var(--ease-out); transform-origin: top right; }.group-menu-enter-from, .group-menu-leave-to { opacity: 0; transform: translateY(-3px) scale(.98); }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action:disabled { cursor: not-allowed; opacity: .35; }
.group-header-actions { display: flex; align-items: center; gap: 8px; }.group-host-chip { max-width: 150px; overflow: hidden; padding: 4px 7px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); font-size: 9px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.group-avatars { display: flex; align-items: center; }.group-avatars span, .group-avatars em { display: grid; width: 24px; height: 24px; margin-left: -5px; place-items: center; border: 2px solid var(--canvas); border-radius: 8px; background: var(--accent); color: var(--text-on-solid); font-size: 8px; font-style: normal; font-weight: 650; }.group-avatars span.host { box-shadow: 0 0 0 1px var(--accent); }.group-avatars span:first-child { margin-left: 0; }.group-avatars em { background: var(--surface-hover); color: var(--text-secondary); }
.group-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
@media (max-width: 480px) { .group-avatars, .group-host-chip { display: none; } }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action, .group-menu-enter-active, .group-menu-leave-active { transition: none; } }
</style>

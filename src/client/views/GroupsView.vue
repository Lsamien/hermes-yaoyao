<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL } from '@shared/types'
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
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { loadComposerFile } from '@/components/workspace/pendingComposer'
import { readAgentShowThinking, writeAgentShowThinking } from '@/utils/sessionPreferences'
import { agentToUi, groupInteraction, groupMessageToUi, roomSidebarItem, roomToUi } from '@/components/workspace/viewModels'
import { useAuthStore } from '@/stores/auth'
import { useGroupsStore } from '@/stores/groups'

const auth = useAuthStore()
const groups = useGroupsStore()
const route = useRoute()
const router = useRouter()
const search = ref('')
const createOpen = ref(false)
const managerOpen = ref(false)
const showThinking = ref(true)
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const mediaPreviewIndex = ref<number | null>(null)
const composer = ref<InstanceType<typeof ComposerShell> | null>(null)

const filteredRooms = computed(() => groups.rooms
  .filter(room => !room.archived)
  .filter(room => !search.value.trim() || `${room.name} ${room.lastMessage?.content || ''}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
const sidebarItems = computed(() => filteredRooms.value.map(roomSidebarItem))
const messages = computed(() => groups.messages.map(groupMessageToUi))
const conversationMediaItems = computed(() => mediaItemsFromMessages(messages.value))
const lightboxMedia = computed(() => conversationMediaItems.value.map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const agents = computed(() => groups.agents.map(agentToUi))
const connected = computed(() => ['connected', 'ready'].includes(groups.connectionState))
const activeInteraction = computed(() => groupInteraction(groups.pendingInteractions[0]))
const room = computed(() => groups.selectedRoom ? roomToUi(groups.selectedRoom) : null)
const profiles = computed(() => auth.profiles.map(profile => profile.name))
const availableProfiles = computed(() => profiles.value.filter(profile => !groups.agents.some(agent => agent.profile === profile)))
const uploadsEnabled = computed(() => auth.groupUploadsEnabled)
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, author: quoted.value.author, content: quoted.value.content } : null)
const mentionNames = computed(() => ['所有人', ...groups.agents.map(agent => agent.displayName || agent.profile)])
const mentionOptions = computed<ComposerOption[]>(() => [
  { id: 'all', label: '所有人', detail: '通知房间内全部 Agent' },
  ...groups.agents.map(agent => ({ id: agent.id, label: agent.displayName || agent.profile, detail: agent.profile, disabled: !agent.enabled })),
])

function restoreShowThinking(profile = auth.activeProfile?.name || 'default') {
  showThinking.value = readAgentShowThinking(auth.user?.id ?? 'local', profile)
}

function toggleShowThinking() {
  showThinking.value = !showThinking.value
  writeAgentShowThinking(auth.user?.id ?? 'local', auth.activeProfile?.name || 'default', showThinking.value)
}

async function selectRoom(id: string) {
  await router.push(`/groups/${encodeURIComponent(id)}`)
  await groups.selectRoom(id)
  quoted.value = null
}

async function createRoom(payload: { name: string; profiles: string[]; autoReply: boolean; replyRounds: number }) {
  const detail = await groups.createRoom({
    name: payload.name,
    agents: payload.profiles.map(profile => ({ profile, displayName: auth.profiles.find(item => item.name === profile)?.agentName || auth.profiles.find(item => item.name === profile)?.displayName || profile, replyWithoutMention: payload.autoReply })),
    maxReplyRounds: payload.replyRounds,
  })
  createOpen.value = false
  await router.push(`/groups/${encodeURIComponent(detail.id)}`)
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
  await groups.addAgent(groups.selectedRoom.id, { profile, displayName: auth.profiles.find(item => item.name === profile)?.agentName || auth.profiles.find(item => item.name === profile)?.displayName || profile, replyWithoutMention: true })
}

async function updateAgent(id: string, patch: { enabled?: boolean; autoReply?: boolean }) {
  if (!groups.selectedRoom) return
  await groups.updateAgent(groups.selectedRoom.id, id, { enabled: patch.enabled, replyWithoutMention: patch.autoReply })
}

async function archiveRoom() {
  if (!groups.selectedRoom) return
  await groups.archiveRoom(groups.selectedRoom.id)
  managerOpen.value = false
  await router.replace(groups.selectedRoomId ? `/groups/${encodeURIComponent(groups.selectedRoomId)}` : '/groups')
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
  restoreShowThinking()
  try {
    await groups.start()
    const requested = typeof route.params.roomId === 'string' ? route.params.roomId : ''
    if (requested && requested !== groups.selectedRoomId) await groups.selectRoom(requested)
    else if (groups.selectedRoomId) await router.replace(`/groups/${encodeURIComponent(groups.selectedRoomId)}`)
  } catch { /* availability state renders the error */ }
})

onBeforeUnmount(() => groups.stop())

watch(() => route.params.roomId, async roomId => {
  if (typeof roomId === 'string' && roomId && roomId !== groups.selectedRoomId) await groups.selectRoom(roomId)
})
watch(() => auth.activeProfile?.name, profile => { if (profile) restoreShowThinking(profile) })
</script>

<template>
  <WorkspaceView sidebar-title="群聊" :sidebar-subtitle="groups.availability === 'available' ? `${filteredRooms.length} 个活跃房间` : `9119 群聊 ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL}`" :inspector-open="managerOpen && !!room" @close-inspector="managerOpen = false">
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
        :search="search"
        search-placeholder="搜索群聊"
        empty-title="还没有群聊"
        empty-description="新建群聊，邀请 1–8 个 Agent 一起协作。"
        @search="search = $event"
        @select="selectRoom"
        @more="id => { selectRoom(id); managerOpen = true }"
      />
    </template>

    <div v-if="groups.availability === 'unsupported' || groups.availability === 'unavailable'" class="groups-unavailable">
      <EmptyState icon="alert" :title="groups.availability === 'unsupported' ? '群聊协议版本不兼容' : '群聊服务暂不可用'" :description="groups.error || `请确认 9119 已安装 YaoYao 群聊 protocol ${SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL} 插件。`" action-label="重新检查" @action="groups.refresh" />
    </div>
    <div v-else class="groups-workspace">
      <MessageTimeline
        :messages="messages"
        :title="groups.selectedRoom?.name || '群聊'"
        :subtitle="groups.selectedRoom ? `${groups.agents.length} 个 Agent · 最多 ${groups.selectedRoom.maxReplyRounds} 轮回复` : '选择或新建一个群聊'"
        :loading="groups.isLoading"
        :has-older="groups.hasMoreBefore"
        :connected="connected"
        :synced="!!groups.selectedRoom"
        :show-tools="showThinking"
        :thinking="groups.isSending || groups.agents.some(agent => ['queued', 'running'].includes(agent.status))"
        :interaction="activeInteraction"
        :mention-names="mentionNames"
        empty-title="让多个 Agent 一起工作"
        empty-description="使用 @ 提及指定 Agent，或直接发送消息触发已启用自动回复的成员。"
        @load-older="groups.loadOlder"
        @quote="quoted = $event"
        @preview="openAttachment"
        @preview-file="openLocalFile"
        @approve="activeInteraction && groups.approveInteraction(activeInteraction.id, $event ? 'once' : 'deny')"
        @clarify="activeInteraction && groups.clarifyInteraction(activeInteraction.id, $event)"
      >
        <template #header-actions>
          <div class="group-header-actions">
            <div class="group-avatars" aria-label="群聊成员"><span v-for="agent in agents.slice(0, 4)" :key="agent.id" :title="agent.name">{{ agent.name.slice(0, 1).toUpperCase() }}</span><em v-if="agents.length > 4">+{{ agents.length - 4 }}</em></div>
            <button class="icon-button" type="button" title="管理群聊" aria-label="管理群聊" :disabled="!groups.selectedRoom" @click="managerOpen = true"><AppIcon name="dots" /></button>
          </div>
        </template>
      </MessageTimeline>
      <p v-if="groups.error" class="group-error" role="alert"><AppIcon name="alert" :size="13" />{{ groups.error }}</p>
      <ComposerShell
        ref="composer"
        mode="group"
        :draft-key="`${auth.user?.id || 'local'}:${groups.selectedRoomId || 'new'}`"
        :disabled="!groups.selectedRoom || groups.availability !== 'available'"
        :streaming="groups.agents.some(agent => ['queued', 'running'].includes(agent.status))"
        :sending="groups.isSending"
        :tool-trace-visible="showThinking"
        :reference="reference"
        :mention-options="mentionOptions"
        :attachments-enabled="uploadsEnabled"
        placeholder="发消息给群聊，输入 @ 提及 Agent"
        @send="send"
        @stop="groups.agents.filter(agent => ['queued', 'running'].includes(agent.status)).forEach(agent => groups.interruptAgent(agent.id))"
        @tool-trace-toggle="toggleShowThinking"
        @clear-reference="quoted = null"
      />
    </div>

    <template #inspector>
      <GroupManager
        v-if="room && groups.selectedRoom"
        :room="room"
        :agents="agents"
        :available-profiles="availableProfiles"
        :busy="groups.isLoading"
        @close="managerOpen = false"
        @update-room="updateRoom"
        @add-agent="addAgent"
        @update-agent="updateAgent"
        @remove-agent="groups.removeAgent(groups.selectedRoom.id, $event)"
        @interrupt-agent="groups.interruptAgent($event, groups.selectedRoom.id)"
        @archive-room="archiveRoom"
      />
    </template>
  </WorkspaceView>

  <CreateGroupDialog :open="createOpen" :profiles="profiles" :busy="groups.isLoading" @close="createOpen = false" @create="createRoom" />
  <PreviewModal v-if="preview" :item="preview" :items="conversationMediaItems" @close="preview = null" @add-to-composer="addPreviewToComposer" @source="preview = null" />
  <ImagePreviewLightbox v-model="mediaPreviewIndex" :images="lightboxMedia" :can-add="uploadsEnabled" @add="addMediaToComposer" />
</template>

<style scoped>
.groups-workspace, .groups-unavailable { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; background: var(--conversation-canvas); }.groups-unavailable { overflow: auto; }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action:disabled { cursor: not-allowed; opacity: .35; }
.group-header-actions { display: flex; align-items: center; gap: 8px; }.group-avatars { display: flex; align-items: center; }.group-avatars span, .group-avatars em { display: grid; width: 24px; height: 24px; margin-left: -5px; place-items: center; border: 2px solid var(--canvas); border-radius: 8px; background: var(--accent); color: var(--text-on-solid); font-size: 8px; font-style: normal; font-weight: 650; }.group-avatars span:first-child { margin-left: 0; }.group-avatars em { background: var(--surface-hover); color: var(--text-secondary); }
.group-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
@media (max-width: 480px) { .group-avatars { display: none; } }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action { transition: none; } }
</style>

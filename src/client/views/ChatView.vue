<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import ChoiceDialog from '@/components/common/ChoiceDialog.vue'
import type { ChoiceOption } from '@/components/common/types'
import ComposerShell from '@/components/composer/ComposerShell.vue'
import type { ComposerOption, ComposerReference, ComposerSubmit } from '@/components/composer/types'
import PreviewInspector from '@/components/library/PreviewInspector.vue'
import PreviewModal from '@/components/library/PreviewModal.vue'
import type { UiLibraryItem } from '@/components/library/types'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { chatInteraction, chatMessagesToUi, sessionSidebarItem } from '@/components/workspace/viewModels'
import { consumeLibraryItemForComposer } from '@/components/workspace/pendingComposer'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { getSession } from '@/api/sessions'

const auth = useAuthStore()
const chat = useChatStore()
const route = useRoute()
const router = useRouter()
const search = ref('')
const quoted = ref<UiMessage | null>(null)
const preview = ref<UiLibraryItem | null>(null)
const filePreview = ref<UiLibraryItem | null>(null)
const modelDialog = ref(false)
const showTools = ref(true)
const queueMode = ref(false)
const actionSessionId = ref('')
const renaming = ref(false)
const renameValue = ref('')
const composer = ref<InstanceType<typeof ComposerShell> | null>(null)
const timeline = ref<InstanceType<typeof MessageTimeline> | null>(null)
const restoringRouteProfile = ref('')

const sessions = computed(() => [...chat.sessions]
  .filter(session => !['cron', 'ios_group'].includes(session.source))
  .filter(session => !search.value.trim() || `${session.title} ${session.preview || ''}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
const agentNames = computed(() => new Map(auth.profiles.map(profile => [
  profile.name,
  profile.agentName || profile.displayName || profile.name,
])))
const sidebarItems = computed(() => sessions.value.map(session => sessionSidebarItem(
  session,
  chat.unreadCounts[session.id] ?? 0,
  agentNames.value.get(session.profile || auth.activeProfile?.name || ''),
)))
const messages = computed(() => chatMessagesToUi(chat.messages, profile => profile ? agentNames.value.get(profile) : undefined))
const activeSession = computed(() => chat.activeSession)
const connected = computed(() => ['connected', 'ready'].includes(chat.connectionState))
const interaction = computed(() => chatInteraction(chat.pendingApproval, chat.pendingClarification))
const reference = computed<ComposerReference | null>(() => quoted.value ? { id: quoted.value.id, content: quoted.value.content, author: quoted.value.author } : null)
const forkSourceTitle = computed(() => {
  const parentId = activeSession.value?.parentSessionId
  if (!parentId) return ''
  return chat.sessions.find(session => session.id === parentId && session.profile === activeSession.value?.profile)?.title || parentId
})
const modelOptions = computed<ChoiceOption[]>(() => chat.models.map(model => ({ id: `${model.provider}:${model.id}`, label: model.name || model.id, description: model.provider })))
const selectedModelId = computed(() => chat.selectedModel ? `${chat.selectedModel.provider}:${chat.selectedModel.id}` : '')
const reasoningOptions: ChoiceOption[] = [
  { id: '', label: '默认', description: '使用模型或 Profile 的默认强度' },
  { id: 'none', label: '关闭', description: '不使用额外推理' },
  { id: 'low', label: '低', description: '更快的轻量推理' },
  { id: 'medium', label: '中', description: '速度与深度平衡' },
  { id: 'high', label: '高', description: '更深入地分析复杂问题' },
  { id: 'xhigh', label: '极高', description: '适用于最复杂的任务' },
]
const reasoningComposerOptions = computed<ComposerOption[]>(() => reasoningOptions.map(option => ({
  id: option.id,
  label: option.label,
  detail: option.description,
})))
const reasoningLabel = computed(() => reasoningOptions.find(option => option.id === (chat.reasoningEffort || ''))?.label || '默认')

function routeProfile(): string {
  const value = typeof route.query.profile === 'string' ? route.query.profile : ''
  return auth.profiles.some(profile => profile.name === value) ? value : ''
}

function sessionLocation(id: string, profile: string) {
  return { path: `/chat/${encodeURIComponent(id)}`, query: { profile } }
}

async function findLegacySessionProfile(sessionId: string): Promise<string> {
  for (const profile of auth.profiles) {
    try {
      const session = await getSession(sessionId, profile.name)
      if (session.id === sessionId) return profile.name
    } catch { /* Try the next profile: 9119 returns 404 for a foreign session. */ }
  }
  return auth.activeProfile?.name || ''
}

async function ensureRouteProfile(profile: string): Promise<void> {
  if (!profile || auth.activeProfile?.name === profile) return
  chat.switchProfile(profile)
  restoringRouteProfile.value = profile
  auth.selectProfile(profile)
  await nextTick()
}

async function refreshSessions() {
  const requestedId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  const profile = routeProfile() || (requestedId ? await findLegacySessionProfile(requestedId) : auth.activeProfile?.name || '')
  if (profile && auth.activeProfile?.name !== profile) {
    if (requestedId) await router.replace(sessionLocation(requestedId, profile))
    await ensureRouteProfile(profile)
  }
  // The session route is the authoritative navigation target. A secondary
  // unread-count request must never prevent its history from being restored.
  await chat.loadSessions(profile)
  if (requestedId && chat.activeSessionId !== requestedId) await chat.selectSession(requestedId, profile)
  if (requestedId && profile && routeProfile() !== profile) await router.replace(sessionLocation(requestedId, profile))
  void chat.loadUnread(profile).catch(() => undefined)
}

async function chooseSession(id: string) {
  const session = chat.sessions.find(item => item.id === id)
  const profile = session?.profile || auth.activeProfile?.name || 'default'
  await router.push(sessionLocation(id, profile))
  await ensureRouteProfile(profile)
  if (chat.activeProfileName !== profile) await chat.loadSessions(profile)
  await chat.selectSession(id, profile)
  await chat.markRead(id, profile)
  quoted.value = null
}

async function createSession() {
  const id = chat.createSession(auth.activeProfile?.name)
  await router.push(sessionLocation(id, auth.activeProfile?.name || 'default'))
}

async function send(payload: ComposerSubmit) {
  try {
    await chat.send(payload.text, payload.files, queueMode.value ? 'queue' : chat.isStreaming ? 'steer' : 'submit')
    composer.value?.clearAfterSend()
  } catch { /* store exposes the error and the composer keeps its draft */ }
}

function openAttachment(attachment: NonNullable<UiMessage['attachments']>[number]) {
  preview.value = { id: attachment.id, name: attachment.name, kind: attachment.kind || 'file', size: attachment.size, previewUrl: attachment.url, downloadUrl: attachment.url }
}

function openLocalFile({ name, url }: { name: string; url: string }) {
  const extension = name.split('.').at(-1)?.toLowerCase() || ''
  const kind: UiLibraryItem['kind'] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'avif'].includes(extension) ? 'image'
    : ['mp4', 'mov', 'webm', 'mkv'].includes(extension) ? 'video'
      : ['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(extension) ? 'audio'
        : extension === 'pdf' ? 'pdf'
          : ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'js', 'ts', 'py', 'sh'].includes(extension) ? 'text' : 'file'
  filePreview.value = { id: `local:${url}`, name, kind, previewUrl: url, downloadUrl: url }
}

async function selectModel(id: string) {
  const [provider, ...rest] = id.split(':')
  const model = chat.models.find(item => item.provider === provider && item.id === rest.join(':'))
  if (model) await chat.setModel(model)
  modelDialog.value = false
}

function selectReasoning(id: string) {
  chat.reasoningEffort = id || undefined
}

function openSessionActions(id: string) {
  actionSessionId.value = id
  const session = chat.sessions.find(item => item.id === id)
  renameValue.value = session?.title || ''
  renaming.value = false
}

async function saveRename() {
  const session = chat.sessions.find(item => item.id === actionSessionId.value)
  if (!session || !renameValue.value.trim()) return
  await chat.renameSession(session.id, renameValue.value.trim(), session.profile)
  actionSessionId.value = ''
}

async function deleteSession() {
  const session = chat.sessions.find(item => item.id === actionSessionId.value)
  if (!session) return
  await chat.removeSession(session.id, session.profile)
  actionSessionId.value = ''
  if (route.params.sessionId === session.id) await router.replace('/chat')
}

async function branch() {
  const id = await chat.branchSession()
  if (id) await router.push(sessionLocation(id, chat.activeProfileName || auth.activeProfile?.name || 'default'))
}

async function revealSourceMessage() {
  const messageId = typeof route.query.message === 'string' ? route.query.message : ''
  if (!messageId) return
  await nextTick()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (timeline.value?.scrollToMessage(messageId)) return
    if (!chat.hasMoreBefore) return
    await chat.loadOlder()
    await nextTick()
  }
}

onMounted(async () => {
  await refreshSessions()
  await Promise.allSettled([chat.loadModels(auth.activeProfile?.name), chat.connect()])
  await revealSourceMessage()
  const pendingFile = await consumeLibraryItemForComposer()
  if (pendingFile) composer.value?.attachFiles([pendingFile])
})

onBeforeUnmount(() => chat.disconnect())

watch(() => auth.activeProfile?.name, async (profile, previous) => {
  if (!profile || profile === previous) return
  if (restoringRouteProfile.value === profile) {
    restoringRouteProfile.value = ''
    return
  }
  chat.switchProfile(profile)
  const requestedId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  if (requestedId && routeProfile() === profile) {
    await Promise.allSettled([chat.loadSessions(profile), chat.loadModels(profile), chat.loadUnread(profile), chat.connect()])
    await chat.selectSession(requestedId, profile)
    return
  }
  await router.replace({ path: '/chat', query: { profile } })
  await Promise.allSettled([chat.loadSessions(profile), chat.loadModels(profile), chat.loadUnread(profile), chat.connect()])
})

watch(() => chat.activeSessionId, async id => {
  const profile = chat.activeProfileName || auth.activeProfile?.name || ''
  if (!id || (route.params.sessionId === id && routeProfile() === profile)) return
  await router.replace(sessionLocation(id, profile))
})
</script>

<template>
  <WorkspaceView sidebar-title="对话" :sidebar-subtitle="`${sessions.length} 个会话`" :inspector-open="!!preview" @close-inspector="preview = null">
    <template #sidebar-action>
      <button class="sidebar-primary-action" type="button" title="新建聊天" aria-label="新建聊天" @click="createSession">
        <AppIcon name="edit" :size="17" />
        <span>新建聊天</span>
      </button>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :items="sidebarItems"
        :active-id="chat.activeSessionId"
        :loading="chat.isLoading"
        :search="search"
        single-line
        :has-more="chat.hasMoreSessions"
        :loading-more="chat.isLoadingMoreSessions"
        search-placeholder="搜索会话"
        empty-title="还没有会话"
        empty-description="新建会话后，从输入框开始聊天。"
        @search="search = $event"
        @load-more="chat.loadMoreSessions(auth.activeProfile?.name)"
        @select="chooseSession"
        @more="openSessionActions"
      />
    </template>

    <div class="chat-workspace">
      <MessageTimeline
        ref="timeline"
        :messages="messages"
        :title="activeSession?.title || '新会话'"
        :subtitle="activeSession ? `${activeSession.profile || auth.activeProfile?.name || ''} · ${activeSession.model || chat.selectedModel?.name || '默认模型'}` : '选择会话或直接开始输入'"
        :loading="chat.activeRouteState?.isLoadingHistory || chat.isLoading"
        :loading-older="chat.activeRouteState?.isLoadingHistory"
        :has-older="chat.hasMoreBefore"
        :connected="connected"
        :synced="chat.historySynced"
        :show-tools="showTools"
        :show-assistant-identity="false"
        :interaction="interaction"
        empty-logo
        transparent-header
        :fork-source-title="forkSourceTitle"
        @load-older="chat.loadOlder"
        @quote="quoted = $event"
        @branch="branch"
        @preview="openAttachment"
        @preview-file="openLocalFile"
        @approve="interaction && chat.respondToApproval(interaction.id, $event)"
        @clarify="interaction && chat.respondToClarification(interaction.id, $event)"
      >
        <template #header-actions>
          <button v-if="activeSession" class="icon-button header-session-menu" type="button" title="会话操作" aria-label="会话操作" @click="openSessionActions(activeSession.id)"><AppIcon name="dots" :size="18" /></button>
        </template>
      </MessageTimeline>
      <p v-if="chat.error" class="chat-error" role="alert"><AppIcon name="alert" :size="13" />{{ chat.error }}</p>
      <ComposerShell
        ref="composer"
        mode="chat"
        :draft-key="`${auth.user?.id || 'local'}:${auth.activeProfile?.name || 'default'}:${chat.activeSessionId || 'new'}`"
        :disabled="chat.connectionState === 'failed'"
        :streaming="chat.isStreaming"
        :sending="chat.isSending"
        :model-label="chat.selectedModel?.name || '选择模型'"
        :reasoning-effort="reasoningLabel"
        :reasoning-value="chat.reasoningEffort || ''"
        :reasoning-options="reasoningComposerOptions"
        :context-used="chat.contextUsage?.contextTokens || chat.contextUsage?.totalTokens || 0"
        :context-limit="chat.contextUsage?.contextLimit || 262144"
        :queue-mode="queueMode || chat.isQueued"
        :tool-trace-visible="showTools"
        :reference="reference"
        :slash-commands="[
          { id: 'fork', label: 'fork', detail: '从当前会话创建分支' },
          { id: 'compact', label: 'compact', detail: '压缩当前会话上下文' },
          { id: 'model', label: 'model', detail: '切换模型' },
        ]"
        @send="send"
        @stop="chat.interrupt"
        @model-click="modelDialog = true"
        @reasoning-change="selectReasoning"
        @settings-click="showTools = !showTools"
        @queue-toggle="queueMode = !queueMode"
        @clear-reference="quoted = null"
      />
    </div>

    <template #inspector><PreviewInspector v-if="preview" :item="preview" @close="preview = null" @add-to-composer="preview = null" /></template>
  </WorkspaceView>

  <PreviewModal v-if="filePreview" :item="filePreview" @close="filePreview = null" @add-to-composer="filePreview = null" @source="filePreview = null" />

  <ChoiceDialog :open="modelDialog" title="选择模型" :options="modelOptions" :selected-id="selectedModelId" @close="modelDialog = false" @select="selectModel" />

  <Teleport to="body">
    <Transition name="choice-fade">
      <div v-if="actionSessionId" class="session-action-layer" @mousedown.self="actionSessionId = ''">
        <section class="session-actions" role="dialog" aria-modal="true" aria-label="会话操作">
          <header><strong>会话操作</strong><button class="icon-button" type="button" aria-label="关闭" @click="actionSessionId = ''"><AppIcon name="close" /></button></header>
          <template v-if="renaming">
            <label>会话名称<input v-model="renameValue" maxlength="120" autofocus @keydown.enter="saveRename" /></label>
            <div><button class="quiet-button" type="button" @click="renaming = false">取消</button><button class="solid-button" type="button" @click="saveRename">保存</button></div>
          </template>
          <template v-else>
            <button class="action-row" type="button" @click="renaming = true"><AppIcon name="edit" :size="15" />重命名</button>
            <button class="action-row danger" type="button" @click="deleteSession"><AppIcon name="trash" :size="15" />删除会话</button>
          </template>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.chat-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.sidebar-primary-action { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; font-size: 12px; font-weight: 610; text-align: left; transition: background-color 120ms ease; }
.sidebar-primary-action:hover, .sidebar-primary-action:focus-visible { background: var(--surface-hover); outline: 0; }
.sidebar-primary-action:focus-visible { box-shadow: inset 0 0 0 1px var(--line-strong); }
.header-session-menu { color: var(--text-muted); background: transparent; }.header-session-menu:hover { color: var(--text-primary); background: var(--surface-soft); }
.chat-error { display: flex; width: min(760px, calc(100% - 32px)); margin: 0 auto 4px; align-items: center; gap: 6px; color: var(--danger); font-size: 9px; }
.session-action-layer { position: fixed; z-index: 205; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(4px); }
.session-actions { width: min(340px, 100%); padding: 12px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface-raised); box-shadow: var(--shadow-float); }.session-actions header { display: flex; min-height: 40px; align-items: center; justify-content: space-between; padding: 0 2px 7px 7px; }.session-actions header strong { font-size: 13px; }.action-row { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 0 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }.action-row:hover { background: var(--surface-soft); color: var(--text-primary); }.action-row.danger { color: var(--danger); }.session-actions label { display: flex; flex-direction: column; gap: 6px; color: var(--text-muted); font-size: 10px; }.session-actions input { height: 38px; padding: 0 9px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-soft); color: var(--text-primary); }.session-actions input:focus { border-color: var(--line-strong); }.session-actions > div { display: flex; justify-content: flex-end; gap: 7px; margin-top: 13px; }
@media (max-width: 600px) { .session-action-layer { place-items: end center; padding: 0; }.session-actions { width: 100%; border-radius: 17px 17px 0 0; padding-bottom: max(12px, env(safe-area-inset-bottom)); } }
@media (prefers-reduced-motion: reduce) { .sidebar-primary-action { transition: none; } }
</style>

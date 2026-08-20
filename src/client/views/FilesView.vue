<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FileKind } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'
import LibraryGrid from '@/components/library/LibraryGrid.vue'
import PreviewModal from '@/components/library/PreviewModal.vue'
import ImagePreviewLightbox from '@/components/library/ImagePreviewLightbox.vue'
import type { PreviewMedia } from '@/components/library/ImagePreviewLightbox.vue'
import type { LibraryFilterOption, UiLibraryItem } from '@/components/library/types'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { queueLibraryItemForComposer } from '@/components/workspace/pendingComposer'
import { fileToUi, sessionSidebarItem } from '@/components/workspace/viewModels'
import { useFilesStore } from '@/stores/files'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

const files = useFilesStore()
const auth = useAuthStore()
const chat = useChatStore()
const router = useRouter()
const selected = ref<UiLibraryItem | null>(null)
const mediaIndex = ref<number | null>(null)
const historySearch = ref('')
let searchTimer: number | undefined

const items = computed(() => files.filteredItems.map(fileToUi))
const lightboxMedia = computed(() => items.value.filter(item => item.kind === 'image' || item.kind === 'video').map(item => ({ url: item.previewUrl || item.downloadUrl || '', name: item.name, type: item.kind as 'image' | 'video' })).filter(item => item.url))
const agentNames = computed(() => new Map(auth.profiles.map(profile => [profile.name, profile.agentName || profile.displayName || profile.name])))
const historyItems = computed(() => chat.sessions
  .filter(session => !['cron', 'ios_group'].includes(session.source))
  .filter(session => !historySearch.value.trim() || `${session.title} ${session.preview || ''}`.toLocaleLowerCase().includes(historySearch.value.trim().toLocaleLowerCase()))
  .map(session => sessionSidebarItem(session, chat.unreadCounts[session.id] ?? 0, agentNames.value.get(session.profile || auth.activeProfile?.name || ''))))
const options = computed<LibraryFilterOption[]>(() => {
  const count = (kind: string) => files.items.filter(item => item.kind === kind).length
  return [
    { id: 'all', label: '全部', count: files.items.length, icon: 'files' },
    { id: 'image', label: '图片', count: count('image'), icon: 'image' },
    { id: 'video', label: '视频', count: count('video'), icon: 'video' },
    { id: 'audio', label: '音频', count: count('audio'), icon: 'audio' },
    { id: 'document', label: '文档', count: count('document'), icon: 'file' },
    { id: 'other', label: '其他', count: count('other'), icon: 'file' },
  ]
})

function updateSearch(value: string) {
  files.query = value
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void files.load(true), 260)
}

function updateFilter(value: string) {
  files.kindFilter = value as FileKind | 'all'
  void files.load(true)
}

async function addToComposer(item: UiLibraryItem) {
  if (!queueLibraryItemForComposer(item)) return
  await router.push('/chat')
}

async function addMediaToComposer(media: PreviewMedia) {
  const item = items.value.find(candidate => (candidate.previewUrl || candidate.downloadUrl) === media.url)
  if (item) await addToComposer(item)
}

async function openSource(item: UiLibraryItem) {
  if (!item.sourceSessionId) return
  if (item.sourceProfile && auth.profiles.some(profile => profile.name === item.sourceProfile)) {
    auth.selectProfile(item.sourceProfile)
  }
  await router.push({
    path: `/chat/${encodeURIComponent(item.sourceSessionId)}`,
    query: {
      ...(item.sourceMessageId ? { message: item.sourceMessageId } : {}),
      ...(item.sourceProfile ? { profile: item.sourceProfile } : {}),
    },
  })
}

function selectFile(item: UiLibraryItem) {
  if (item.kind === 'image' || item.kind === 'video') {
    const index = lightboxMedia.value.findIndex(media => media.url === (item.previewUrl || item.downloadUrl))
    mediaIndex.value = index >= 0 ? index : null
    return
  }
  selected.value = item
}

async function selectSession(id: string) {
  const session = chat.sessions.find(item => item.id === id)
  const profile = session?.profile || auth.activeProfile?.name
  await router.push({ path: `/chat/${encodeURIComponent(id)}`, query: profile ? { profile } : {} })
}

async function createChat() {
  selected.value = null
  mediaIndex.value = null
  const profile = auth.activeProfile?.name || 'default'
  const id = chat.createSession(profile)
  await router.push({ path: `/chat/${encodeURIComponent(id)}`, query: { profile } })
}

onMounted(() => {
  void files.load(true)
  void chat.loadSessions(auth.activeProfile?.name)
  void chat.loadUnread(auth.activeProfile?.name)
})
onBeforeUnmount(() => window.clearTimeout(searchTimer))
watch(() => files.items, () => {
  if (selected.value && !files.items.some(item => item.id === selected.value?.id)) selected.value = null
})
watch(() => auth.activeProfile?.name, profile => {
  selected.value = null
  files.profile = profile
  void files.load(true)
  void chat.loadSessions(profile)
  void chat.loadUnread(profile)
})
</script>

<template>
  <WorkspaceView sidebar-title="历史记录" :sidebar-subtitle="`${chat.sessions.length} 个会话`">
    <template #sidebar-action>
      <button type="button" title="新建聊天" aria-label="新建聊天" @click="createChat">
        <YaoYaoSidebarIcon name="add" />
        <span>新建聊天</span>
      </button>
    </template>
    <template #sidebar>
      <ResourceSidebar
        :items="historyItems"
        :active-id="chat.activeSessionId"
        :loading="chat.isLoading"
        :search="historySearch"
        single-line
        search-placeholder="搜索会话"
        empty-title="还没有会话"
        empty-description="创建会话后会显示在这里。"
        @search="historySearch = $event"
        @select="selectSession"
      />
    </template>
    <section class="library-workspace">
      <header class="library-header">
        <div><h2>文件库</h2><span><AppIcon name="files" :size="15" />{{ items.length }}</span></div>
        <label class="file-search"><AppIcon name="search" :size="15" /><input :value="files.query" type="search" placeholder="搜索文件名、路径或会话" @input="updateSearch(($event.target as HTMLInputElement).value)" /></label>
      </header>
      <nav class="file-tabs" aria-label="文件类型筛选">
        <button v-for="option in options" :key="option.id" type="button" :class="{ active: option.id === files.kindFilter }" @click="updateFilter(option.id)">{{ option.label }}<small v-if="option.count !== undefined">{{ option.count }}</small></button>
        <div class="file-tabs__status"><span v-if="files.error" class="error"><AppIcon name="alert" :size="13" />{{ files.error }}</span><span v-else>{{ files.nextCursor ? '还有更多文件可加载' : items.length ? '已同步到最新' : '' }}</span><button class="icon-button" type="button" aria-label="刷新文件库" title="刷新文件库" :disabled="files.isLoading" @click="files.load(true)"><AppIcon name="refresh" :size="15" /></button></div>
      </nav>
      <LibraryGrid
        :items="items"
        :selected-id="selected?.id"
        :loading="files.isLoading"
        :has-more="files.hasMore"
        empty-title="文件库还是空的"
        empty-description="聊天中的图片、文档和附件会出现在这里。"
        @select="selectFile"
        @load-more="files.loadMore"
        @add-to-composer="addToComposer"
        @source="openSource"
      />
    </section>
  </WorkspaceView>
  <PreviewModal v-if="selected" :item="selected" :items="items" @close="selected = null" @add-to-composer="addToComposer" @source="openSource" />
  <ImagePreviewLightbox v-model="mediaIndex" :images="lightboxMedia" @add="addMediaToComposer" />
</template>

<style scoped>
.library-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.library-header { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 16px; padding: 0 22px; border-bottom: 1px solid var(--line); }.library-header > div { display: flex; align-items: center; gap: 10px; }.library-header h2 { margin: 0; font-size: 15px; letter-spacing: -.02em; }.library-header span { display: flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 10px; }.file-search { display: flex; width: min(280px, 38vw); min-height: 32px; align-items: center; gap: 7px; padding: 0 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text-muted); }.file-search:focus-within { border-color: var(--line-strong); }.file-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 11px; }
.file-tabs { display: flex; min-height: 46px; align-items: center; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--line); overflow-x: auto; }.file-tabs > button { min-height: 28px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; white-space: nowrap; }.file-tabs > button:hover, .file-tabs > button.active { background: var(--surface-soft); color: var(--text-primary); }.file-tabs > button.active { font-weight: 650; }.file-tabs > button small { margin-left: 4px; color: var(--text-muted); font-size: 8px; }.file-tabs__status { display: flex; min-width: 0; align-items: center; gap: 7px; margin-left: auto; color: var(--text-muted); font-size: 9px; white-space: nowrap; }.file-tabs__status > span { overflow: hidden; text-overflow: ellipsis; }.file-tabs__status .error { color: var(--danger); }.file-tabs__status .icon-button { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }.file-tabs__status .icon-button:hover { background: var(--surface-soft); color: var(--text-primary); }
@media (max-width: 600px) { .library-header { min-height: 52px; padding: 0 13px; }.library-header h2 { font-size: 14px; }.file-search { width: min(180px, 52vw); }.file-tabs { padding: 0 13px; }.file-tabs__status { display: none; } }
</style>

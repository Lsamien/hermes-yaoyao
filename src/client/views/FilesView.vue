<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FileKind } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import LibraryGrid from '@/components/library/LibraryGrid.vue'
import LibrarySidebar from '@/components/library/LibrarySidebar.vue'
import PreviewModal from '@/components/library/PreviewModal.vue'
import type { LibraryFilterOption, UiLibraryItem } from '@/components/library/types'
import WorkspaceView from '@/components/workspace/WorkspaceView.vue'
import { queueLibraryItemForComposer } from '@/components/workspace/pendingComposer'
import { fileToUi } from '@/components/workspace/viewModels'
import { useFilesStore } from '@/stores/files'
import { useAuthStore } from '@/stores/auth'

const files = useFilesStore()
const auth = useAuthStore()
const router = useRouter()
const selected = ref<UiLibraryItem | null>(null)
let searchTimer: number | undefined

const items = computed(() => files.filteredItems.map(fileToUi))
const options = computed<LibraryFilterOption[]>(() => {
  const count = (kind: string) => files.items.filter(item => item.kind === kind).length
  return [
    { id: 'all', label: '全部文件', count: files.items.length, icon: 'files' },
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

onMounted(() => files.load(true))
onBeforeUnmount(() => window.clearTimeout(searchTimer))
watch(() => files.items, () => {
  if (selected.value && !files.items.some(item => item.id === selected.value?.id)) selected.value = null
})
watch(() => auth.activeProfile?.name, profile => {
  selected.value = null
  files.profile = profile
  void files.load(true)
})
</script>

<template>
  <WorkspaceView sidebar-title="文件库" :sidebar-subtitle="`${files.items.length} 个文件`">
    <template #sidebar>
      <LibrarySidebar
        :search="files.query"
        :filter="files.kindFilter"
        :options="options"
        :loading="files.isLoading"
        :error="files.error"
        :progress="files.nextCursor ? '还有更多文件可加载' : files.items.length ? '已同步到最新' : ''"
        @search="updateSearch"
        @filter="updateFilter"
        @refresh="files.load(true)"
      />
    </template>
    <section class="library-workspace">
      <header class="library-header"><div><h2>文件库</h2><p>9119 保存的文件与附件</p></div><span><AppIcon name="files" :size="15" />{{ items.length }}</span></header>
      <LibraryGrid
        :items="items"
        :selected-id="selected?.id"
        :loading="files.isLoading"
        :has-more="files.hasMore"
        empty-title="文件库还是空的"
        empty-description="聊天中的图片、文档和附件会出现在这里。"
        @select="selected = $event"
        @load-more="files.loadMore"
        @add-to-composer="addToComposer"
        @source="openSource"
      />
    </section>
  </WorkspaceView>
  <PreviewModal v-if="selected" :item="selected" :items="items" @close="selected = null" @add-to-composer="addToComposer" @source="openSource" />
</template>

<style scoped>
.library-workspace { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; }
.library-header { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--line); }.library-header h2 { margin: 0; font-size: 14px; letter-spacing: -.02em; }.library-header p { margin: 3px 0 0; color: var(--text-muted); font-size: 9px; }.library-header > span { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 10px; }
@media (max-width: 600px) { .library-header { min-height: 54px; padding: 8px 13px; } }
</style>

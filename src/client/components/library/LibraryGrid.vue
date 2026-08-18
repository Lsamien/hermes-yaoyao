<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import type { UiLibraryItem } from './types'

withDefaults(defineProps<{
  items: UiLibraryItem[]
  selectedId?: string
  loading?: boolean
  hasMore?: boolean
  emptyTitle?: string
  emptyDescription?: string
  kind?: 'files' | 'artifacts'
}>(), {
  selectedId: '', loading: false, hasMore: false, emptyTitle: '暂无文件', emptyDescription: '这里会显示来自 Hermes 的文件。', kind: 'files',
})

const emit = defineEmits<{
  select: [item: UiLibraryItem]
  loadMore: []
  addToComposer: [item: UiLibraryItem]
  source: [item: UiLibraryItem]
}>()

function iconFor(item: UiLibraryItem) {
  if (item.kind === 'document' || item.kind === 'pdf' || item.kind === 'code' || item.kind === 'text') return 'file'
  return item.kind
}

function formatSize(size?: number) {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value?: string | number | Date) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}
</script>

<template>
  <div class="library-scroll">
    <div v-if="loading && !items.length" class="library-skeleton">
      <i v-for="n in 10" :key="n" :style="{ opacity: .95 - n * .04 }" />
    </div>
    <EmptyState v-else-if="!items.length" :icon="kind === 'files' ? 'files' : 'artifacts'" :title="emptyTitle" :description="emptyDescription" />
    <div v-else class="library-grid">
      <article
        v-for="item in items"
        :key="item.id"
        :class="{ selected: item.id === selectedId }"
        tabindex="0"
        @click="emit('select', item)"
        @keydown.enter="emit('select', item)"
      >
        <div class="library-thumb" :class="`library-thumb--${item.kind}`">
          <img v-if="item.kind === 'image' && item.previewUrl" :src="item.previewUrl" :alt="item.name" loading="lazy" />
          <video v-else-if="item.kind === 'video' && item.previewUrl" :src="item.previewUrl" muted preload="metadata" />
          <span v-else><AppIcon :name="iconFor(item)" :size="36" /><em>{{ item.name.split('.').at(-1)?.slice(0, 5).toUpperCase() }} · {{ item.kind }}</em></span>
          <div class="library-thumb__actions">
            <button type="button" title="加入输入框" aria-label="加入输入框" @click.stop="emit('addToComposer', item)"><AppIcon name="plus" :size="14" /></button>
            <button v-if="item.sourceSessionId" type="button" title="查看来源" aria-label="查看来源" @click.stop="emit('source', item)"><AppIcon name="external" :size="14" /></button>
          </div>
        </div>
        <div class="library-copy">
          <strong :title="item.name">{{ item.title || item.name }}</strong>
          <span><small>{{ item.sourceLabel || formatSize(item.size) || item.kind }}</small><time>{{ formatDate(item.updatedAt || item.createdAt) }}</time></span>
        </div>
      </article>
    </div>
    <button v-if="hasMore" class="load-more" type="button" :disabled="loading" @click="emit('loadMore')">{{ loading ? '加载中…' : '加载更多' }}</button>
  </div>
</template>

<style scoped>
.library-scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 20px clamp(18px, 3vw, 36px) 32px; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px 12px; }
article { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); cursor: pointer; outline: 0; transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease; } article:focus-visible, article.selected { border-color: var(--line-strong); box-shadow: 0 0 0 2px var(--focus-ring); } article:hover { border-color: var(--line-strong); box-shadow: 0 8px 22px rgba(0,0,0,.07); transform: translateY(-1px); }
.library-thumb { position: relative; display: grid; height: 154px; place-items: center; overflow: hidden; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--surface-soft); color: var(--text-muted); }
.library-thumb img, .library-thumb video { width: 100%; height: 100%; object-fit: cover; }
.library-thumb > span { display: flex; flex-direction: column; align-items: center; gap: 7px; }.library-thumb > span em { max-width: 150px; overflow: hidden; color: var(--text-muted); font-size: 11px; font-style: normal; letter-spacing: .02em; text-overflow: ellipsis; text-transform: capitalize; }
.library-thumb--code, .library-thumb--text { background: linear-gradient(135deg, var(--surface-soft), var(--surface-raised)); }.library-thumb--link { border-style: dashed; }
.library-thumb__actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0; transform: translateY(-3px); transition: opacity 120ms ease, transform 140ms var(--ease-out); }.library-thumb:hover .library-thumb__actions, article:focus-within .library-thumb__actions { opacity: 1; transform: translateY(0); }.library-thumb__actions button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid rgba(255,255,255,.32); border-radius: 8px; background: rgba(25,25,24,.72); color: #fff; cursor: pointer; backdrop-filter: blur(8px); }
.library-copy { padding: 10px 12px 9px; }.library-copy strong { display: block; overflow: hidden; font-size: 13px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }.library-copy > span { display: flex; margin-top: 5px; justify-content: space-between; gap: 8px; color: var(--text-muted); font-size: 11px; line-height: 1.4; }.library-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.library-copy time { flex: 0 0 auto; }
.load-more { display: block; margin: 28px auto 0; padding: 7px 12px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; }.load-more:hover { background: var(--surface-hover); }
.library-skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px 12px; }.library-skeleton i { height: 208px; border-radius: 11px; background: linear-gradient(90deg, var(--surface-soft), var(--surface-hover), var(--surface-soft)); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (max-width: 600px) { .library-scroll { padding: 16px 12px 30px; }.library-grid, .library-skeleton { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 9px; }.library-thumb { height: 122px; }.library-thumb__actions { opacity: 1; transform: none; }.library-copy { padding: 8px 9px; }.library-copy strong { font-size: 11px; }.library-copy > span { font-size: 9px; } }
</style>

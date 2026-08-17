import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { FileKind, FileLibraryItem } from '@shared/types'
import { getFiles } from '@/api/files'
import { useAuthStore } from './auth'

export const useFilesStore = defineStore('files', () => {
  const auth = useAuthStore()
  const items = shallowRef<FileLibraryItem[]>([])
  const nextCursor = ref<string>()
  const hasMore = ref(true)
  const isLoading = ref(false)
  const error = ref<string>()
  const query = ref('')
  const kindFilter = ref<FileKind | 'all'>('all')
  const profile = ref<string>()
  const visitedCursors = new Set<string>()
  let loadGeneration = 0

  const filteredItems = computed<FileLibraryItem[]>(() => items.value.filter(item => kindFilter.value === 'all' || item.kind === kindFilter.value))

  async function load(reset = true): Promise<void> {
    if (isLoading.value && !reset) return
    const generation = ++loadGeneration
    if (reset) {
      items.value = []
      nextCursor.value = undefined
      hasMore.value = true
      visitedCursors.clear()
    } else if (!hasMore.value) return
    isLoading.value = true
    error.value = undefined
    try {
      const existing = new Map(items.value.map(item => [item.id, item]))
      let cursor = reset ? undefined : nextCursor.value
      let pages = 0
      while (pages < 20) {
        const cursorKey = cursor ?? '<first-page>'
        if (visitedCursors.has(cursorKey)) {
          hasMore.value = false
          error.value = '文件分页返回了重复游标，已停止加载'
          break
        }
        visitedCursors.add(cursorKey)
        const page = await getFiles({
          search: query.value.trim() || undefined,
          kind: kindFilter.value,
          profile: profile.value ?? auth.activeProfile?.name,
          cursor,
          limit: 50,
        })
        if (generation !== loadGeneration) return
        for (const item of page.items) existing.set(item.id, item)
        pages += 1
        cursor = page.nextCursor ?? undefined
        nextCursor.value = cursor
        hasMore.value = Boolean(cursor)
        const matching = [...existing.values()].filter(item => kindFilter.value === 'all' || item.kind === kindFilter.value).length
        if (!cursor || kindFilter.value === 'all' || matching >= 50) break
      }
      items.value = [...existing.values()]
    } catch (cause) {
      if (generation === loadGeneration) error.value = cause instanceof Error ? cause.message : '文件库加载失败'
    } finally {
      if (generation === loadGeneration) isLoading.value = false
    }
  }

  const reset = () => load(true)
  const loadMore = () => load(false)
  return { items, filteredItems, nextCursor, hasMore, isLoading, error, query, kindFilter, profile, load, reset, loadMore }
})

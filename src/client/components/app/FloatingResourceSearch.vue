<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import type { SidebarItem, SidebarItemBase } from './types'

const SIDEBAR_SEARCH_EVENT = 'hermes-yaoyao:sidebar-search'
const SIDEBAR_SEARCH_CLOSE_EVENT = 'hermes-yaoyao:sidebar-search-close'

const props = withDefaults(defineProps<{
  section: 'chat' | 'groups'
  label: string
  items: SidebarItem[]
  split?: boolean
}>(), { split: false })

const emit = defineEmits<{ open: []; select: [id: string] }>()

const open = ref(false)
const query = ref('')
const input = ref<HTMLInputElement | null>(null)
type SearchResultItem = SidebarItemBase & { children?: SidebarItemBase[] }
const activeParentId = ref('')
const activeParent = computed(() => props.items.find(item => item.id === activeParentId.value))
const activeItems = computed<SearchResultItem[]>(() => activeParent.value?.children ?? props.items)
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const results = computed(() => {
  const needle = normalizedQuery.value
  if (!needle) return activeItems.value.slice(0, 50)
  return activeItems.value.filter(item => `${item.title} ${item.subtitle || ''} ${item.meta || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 50)
})
const resultRows = computed(() => results.value.map((item, index) => ({
  item,
  hasChildren: item.children !== undefined,
  showSection: Boolean(item.section && item.section !== results.value[index - 1]?.section),
})))
const navigationRows = computed(() => props.items.map((item, index) => ({
  item,
  showSection: Boolean(item.section && item.section !== props.items[index - 1]?.section),
})))

async function show(event: Event) {
  const detail = (event as CustomEvent<{ section?: unknown }>).detail
  if (detail?.section !== props.section) return
  query.value = ''
  activeParentId.value = props.split ? props.items[0]?.id || '' : ''
  open.value = true
  emit('open')
  await nextTick()
  input.value?.focus()
}

function close() {
  open.value = false
  query.value = ''
  activeParentId.value = ''
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
}

async function choose(item: SearchResultItem) {
  if (item.children !== undefined) {
    activeParentId.value = item.id
    query.value = ''
    await nextTick()
    input.value?.focus()
    return
  }
  emit('select', item.id)
  close()
}

async function back() {
  activeParentId.value = ''
  query.value = ''
  await nextTick()
  input.value?.focus()
}

onMounted(() => document.addEventListener(SIDEBAR_SEARCH_EVENT, show))
onBeforeUnmount(() => document.removeEventListener(SIDEBAR_SEARCH_EVENT, show))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="floating-resource-search__backdrop" @click.self="close">
      <section class="floating-resource-search" :class="{ 'floating-resource-search--split': split }" role="dialog" aria-modal="true" :aria-label="label">
        <header>
          <button v-if="activeParent && !split" class="floating-resource-search__back" type="button" aria-label="返回搜索结果" @click="back"><AppIcon name="chevron-left" :size="17" /></button>
          <label>
            <AppIcon name="search" :size="18" />
            <input ref="input" v-model="query" type="search" :placeholder="activeParent ? `搜索${activeParent.title}` : label" :aria-label="activeParent ? `搜索${activeParent.title}` : label" @keydown.esc.prevent="split ? close() : activeParent ? back() : close()" />
          </label>
          <button type="button" aria-label="关闭搜索" title="关闭搜索" @click="close"><AppIcon name="close" :size="17" /></button>
        </header>
        <div class="floating-resource-search__body" :class="{ 'floating-resource-search__body--split': split }">
          <nav v-if="split" class="floating-resource-search__navigation" aria-label="搜索范围">
            <template v-for="row in navigationRows" :key="row.item.id">
              <div v-if="row.showSection" class="floating-resource-search__navigation-heading">{{ row.item.section }}</div>
              <button type="button" :class="{ active: row.item.id === activeParentId }" @click="choose(row.item)">
                <AppIcon v-if="row.item.icon" :name="row.item.icon" :size="15" />
                <span>{{ row.item.title }}</span>
              </button>
            </template>
          </nav>
          <section class="floating-resource-search__result-pane">
            <div v-if="activeParent" class="floating-resource-search__context"><strong>{{ activeParent.title }}</strong><span>{{ activeParent.subtitle }}</span></div>
            <div class="floating-resource-search__results" role="listbox" aria-label="搜索结果">
              <template v-for="row in resultRows" :key="row.item.id">
                <div v-if="row.showSection" class="floating-resource-search__section">{{ row.item.section }}</div>
                <button type="button" role="option" :aria-haspopup="row.hasChildren ? 'listbox' : undefined" @click="choose(row.item)">
                  <span v-if="row.item.avatar !== undefined || row.item.avatarMembers?.length" class="floating-resource-search__icon">
                    <TeamAvatar :name="row.item.title" :avatar="row.item.avatar || ''" :members="row.item.avatarMembers || []" :fallback-key="row.item.avatarFallbackKey || row.item.id" :size="30" />
                  </span>
                  <span v-else-if="row.item.icon" class="floating-resource-search__icon"><AppIcon :name="row.item.icon" :size="16" /></span>
                  <span class="floating-resource-search__copy"><strong>{{ row.item.title }}</strong><small v-if="row.item.subtitle">{{ row.item.subtitle }}</small></span>
                  <small v-if="row.item.meta">{{ row.item.meta }}</small>
                </button>
              </template>
              <p v-if="!results.length">{{ activeParent?.emptyText || (activeParent ? `暂无${activeParent.title}内容` : '没有匹配结果') }}</p>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.floating-resource-search__backdrop { position: fixed; z-index: 70; inset: 0; display: grid; place-items: start center; padding: min(18vh, 150px) 20px 20px; background: color-mix(in srgb, var(--text-primary) 20%, transparent); backdrop-filter: blur(3px); }
.floating-resource-search { width: min(100%, 580px); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 20px 60px color-mix(in srgb, var(--text-primary) 22%, transparent); }.floating-resource-search--split { width: min(100%, 720px); }.floating-resource-search header { display: flex; align-items: center; gap: 7px; padding: 10px; border-bottom: 1px solid var(--line); }.floating-resource-search label { display: flex; min-width: 0; flex: 1; align-items: center; gap: 9px; min-height: 37px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; color: var(--text-muted); background: var(--surface-soft); }.floating-resource-search label:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.floating-resource-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: 13px var(--font-ui); }.floating-resource-search header button { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.floating-resource-search header button:hover, .floating-resource-search__results button:hover { background: var(--surface-hover); color: var(--text-primary); }.floating-resource-search__back { margin-right: -2px; }.floating-resource-search__body--split { display: grid; grid-template-columns: 184px minmax(0, 1fr); min-height: min(430px, 55vh); }.floating-resource-search__navigation { min-width: 0; padding: 7px; overflow-y: auto; border-right: 1px solid var(--line); }.floating-resource-search__navigation-heading { padding: 9px 9px 5px; color: var(--text-muted); font-size: 10px; font-weight: 650; }.floating-resource-search__navigation button { display: flex; width: 100%; min-height: 38px; align-items: center; gap: 8px; padding: 5px 9px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }.floating-resource-search__navigation button:hover, .floating-resource-search__navigation button.active { background: var(--surface-hover); color: var(--text-primary); }.floating-resource-search__navigation button.active { font-weight: 650; }.floating-resource-search__navigation button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.floating-resource-search__result-pane { min-width: 0; overflow: hidden; }.floating-resource-search__context { display: flex; align-items: baseline; gap: 8px; padding: 11px 16px 3px; }.floating-resource-search__context strong { font-size: 12px; }.floating-resource-search__context span { overflow: hidden; color: var(--text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.floating-resource-search__results { max-height: min(480px, 50vh); overflow: auto; padding: 7px; }.floating-resource-search__body--split .floating-resource-search__results { max-height: min(392px, 50vh); }.floating-resource-search__section { padding: 9px 9px 4px; color: var(--text-muted); font-size: 10px; font-weight: 650; }.floating-resource-search__results button { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.floating-resource-search__icon { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 8px; background: var(--surface-soft); color: var(--text-muted); }.floating-resource-search__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.floating-resource-search__copy strong, .floating-resource-search__copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.floating-resource-search__copy strong { font-size: 12px; }.floating-resource-search__copy small, .floating-resource-search__results > button > small { color: var(--text-muted); font-size: 10px; }.floating-resource-search__results > p { margin: 0; padding: 28px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
@media (max-width: 600px) { .floating-resource-search__backdrop { place-items: end center; padding: 0; }.floating-resource-search, .floating-resource-search--split { width: 100%; border-radius: 18px 18px 0 0; }.floating-resource-search header { padding: 12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left)); }.floating-resource-search label { min-height: 42px; }.floating-resource-search__body--split { grid-template-columns: 128px minmax(0, 1fr); min-height: min(520px, 65vh); }.floating-resource-search__navigation { padding-bottom: max(7px, env(safe-area-inset-bottom)); }.floating-resource-search__results { max-height: min(520px, 65vh); padding-bottom: max(7px, env(safe-area-inset-bottom)); } }
</style>

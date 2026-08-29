<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import type { SidebarItem } from './types'

const SIDEBAR_SEARCH_EVENT = 'hermes-yaoyao:sidebar-search'
const SIDEBAR_SEARCH_CLOSE_EVENT = 'hermes-yaoyao:sidebar-search-close'

const props = defineProps<{
  section: 'chat' | 'groups'
  label: string
  items: SidebarItem[]
}>()

const emit = defineEmits<{ select: [id: string] }>()

const open = ref(false)
const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const results = computed(() => {
  const needle = normalizedQuery.value
  if (!needle) return props.items.slice(0, 50)
  return props.items.filter(item => `${item.title} ${item.subtitle || ''} ${item.meta || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 50)
})
const resultRows = computed(() => results.value.map((item, index) => ({
  item,
  showSection: Boolean(item.section && item.section !== results.value[index - 1]?.section),
})))

async function show(event: Event) {
  const detail = (event as CustomEvent<{ section?: unknown }>).detail
  if (detail?.section !== props.section) return
  query.value = ''
  open.value = true
  await nextTick()
  input.value?.focus()
}

function close() {
  open.value = false
  query.value = ''
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
}

function choose(id: string) {
  emit('select', id)
  close()
}

onMounted(() => document.addEventListener(SIDEBAR_SEARCH_EVENT, show))
onBeforeUnmount(() => document.removeEventListener(SIDEBAR_SEARCH_EVENT, show))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="floating-resource-search__backdrop" @click.self="close">
      <section class="floating-resource-search" role="dialog" aria-modal="true" :aria-label="label">
        <header>
          <label>
            <AppIcon name="search" :size="18" />
            <input ref="input" v-model="query" type="search" :placeholder="label" :aria-label="label" @keydown.esc.prevent="close" />
          </label>
          <button type="button" aria-label="关闭搜索" title="关闭搜索" @click="close"><AppIcon name="close" :size="17" /></button>
        </header>
        <div class="floating-resource-search__results" role="listbox" aria-label="搜索结果">
          <template v-for="row in resultRows" :key="row.item.id">
            <div v-if="row.showSection" class="floating-resource-search__section">{{ row.item.section }}</div>
            <button type="button" role="option" @click="choose(row.item.id)">
              <span v-if="row.item.avatar !== undefined || row.item.avatarMembers?.length" class="floating-resource-search__icon">
                <TeamAvatar :name="row.item.title" :avatar="row.item.avatar || ''" :members="row.item.avatarMembers || []" :fallback-key="row.item.id" :size="30" />
              </span>
              <span v-else-if="row.item.icon" class="floating-resource-search__icon"><AppIcon :name="row.item.icon" :size="16" /></span>
              <span class="floating-resource-search__copy"><strong>{{ row.item.title }}</strong><small v-if="row.item.subtitle">{{ row.item.subtitle }}</small></span>
              <small v-if="row.item.meta">{{ row.item.meta }}</small>
            </button>
          </template>
          <p v-if="!results.length">没有匹配结果</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.floating-resource-search__backdrop { position: fixed; z-index: 70; inset: 0; display: grid; place-items: start center; padding: min(18vh, 150px) 20px 20px; background: color-mix(in srgb, var(--text-primary) 20%, transparent); backdrop-filter: blur(3px); }
.floating-resource-search { width: min(100%, 580px); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 20px 60px color-mix(in srgb, var(--text-primary) 22%, transparent); }.floating-resource-search header { display: flex; align-items: center; gap: 9px; padding: 10px; border-bottom: 1px solid var(--line); }.floating-resource-search label { display: flex; min-width: 0; flex: 1; align-items: center; gap: 9px; min-height: 37px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; color: var(--text-muted); background: var(--surface-soft); }.floating-resource-search label:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.floating-resource-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: 13px var(--font-ui); }.floating-resource-search header button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.floating-resource-search header button:hover, .floating-resource-search__results button:hover { background: var(--surface-hover); color: var(--text-primary); }.floating-resource-search__results { max-height: min(480px, 50vh); overflow: auto; padding: 7px; }.floating-resource-search__section { padding: 9px 9px 4px; color: var(--text-muted); font-size: 10px; font-weight: 650; }.floating-resource-search__results button { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.floating-resource-search__icon { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 8px; background: var(--surface-soft); color: var(--text-muted); }.floating-resource-search__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.floating-resource-search__copy strong, .floating-resource-search__copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.floating-resource-search__copy strong { font-size: 12px; }.floating-resource-search__copy small, .floating-resource-search__results > button > small { color: var(--text-muted); font-size: 10px; }.floating-resource-search__results > p { margin: 0; padding: 28px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
@media (max-width: 600px) { .floating-resource-search__backdrop { place-items: end center; padding: 0; }.floating-resource-search { width: 100%; border-radius: 18px 18px 0 0; }.floating-resource-search header { padding: 12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left)); }.floating-resource-search label { min-height: 42px; }.floating-resource-search__results { max-height: min(520px, 65vh); padding-bottom: max(7px, env(safe-area-inset-bottom)); } }
</style>

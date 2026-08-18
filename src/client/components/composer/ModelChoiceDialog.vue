<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ModelOption } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'

const props = withDefaults(defineProps<{
  open: boolean
  options: ModelOption[]
  selectedId?: string
  busy?: boolean
}>(), { selectedId: '', busy: false })

const emit = defineEmits<{ close: []; select: [id: string] }>()
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const collapsedProviders = ref<Record<string, boolean>>({})

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', google: 'Google', groq: 'Groq', minimax: 'MiniMax',
  mistral: 'Mistral', ollama: 'Ollama', openai: 'OpenAI', openrouter: 'OpenRouter', xai: 'xAI',
}

function modelId(option: ModelOption): string { return `${option.provider}:${option.id}` }

function providerLabel(provider: string): string {
  const key = provider.toLocaleLowerCase()
  return PROVIDER_LABELS[key] || provider.replace(/[-_]+/g, ' ').replace(/\b\w/g, value => value.toLocaleUpperCase())
}

const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const grouped = new Map<string, ModelOption[]>()
  for (const option of props.options) {
    const haystack = `${option.name} ${option.id} ${option.provider}`.toLocaleLowerCase()
    if (query && !haystack.includes(query)) continue
    const items = grouped.get(option.provider) ?? []
    items.push(option)
    grouped.set(option.provider, items)
  }
  return [...grouped].map(([provider, models]) => ({ provider, label: providerLabel(provider), models }))
})

function close(): void { if (!props.busy) emit('close') }

function toggleProvider(provider: string): void {
  if (props.busy) return
  collapsedProviders.value = { ...collapsedProviders.value, [provider]: !collapsedProviders.value[provider] }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') close()
}

watch(() => props.open, async open => {
  if (!open) return
  search.value = ''
  collapsedProviders.value = {}
  await nextTick()
  searchInput.value?.focus()
})

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="model-dialog-fade">
      <div v-if="open" class="model-dialog-layer" role="presentation" @mousedown.self="close">
        <section class="model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title" :aria-busy="busy">
          <header class="model-dialog__header">
            <h2 id="model-dialog-title">选择模型</h2>
            <button class="icon-button" type="button" aria-label="关闭模型选择" :disabled="busy" @click="close"><AppIcon name="close" :size="15" /></button>
          </header>

          <label class="model-dialog__search">
            <AppIcon name="search" :size="14" />
            <input ref="searchInput" v-model="search" type="search" placeholder="搜索模型名称或 ID" :disabled="busy" autocomplete="off" />
          </label>

          <div class="model-dialog__list">
            <section v-for="group in groups" :key="group.provider" class="model-dialog__group">
              <button class="model-dialog__group-header" type="button" :aria-expanded="!collapsedProviders[group.provider]" :disabled="busy" @click="toggleProvider(group.provider)">
                <AppIcon class="model-dialog__chevron" :class="{ collapsed: collapsedProviders[group.provider] }" name="chevron-down" :size="13" />
                <strong>{{ group.label }}</strong><span>{{ group.models.length }}</span>
              </button>
              <div v-show="!collapsedProviders[group.provider]" class="model-dialog__items">
                <button v-for="model in group.models" :key="modelId(model)" class="model-dialog__item" :class="{ 'model-dialog__item--active': modelId(model) === selectedId }" type="button" :disabled="busy" @click="emit('select', modelId(model))">
                  <span class="model-dialog__item-label">
                    <strong>{{ model.name || model.id }}</strong>
                    <small v-if="model.name && model.name !== model.id">{{ model.id }}</small>
                  </span>
                  <span v-if="model.isDefault" class="model-dialog__badge">默认</span>
                  <span v-if="model.supportsReasoning" class="model-dialog__badge model-dialog__badge--quiet">推理</span>
                  <AppIcon v-if="modelId(model) === selectedId" class="model-dialog__check" name="check" :size="15" />
                </button>
              </div>
            </section>
            <p v-if="!groups.length" class="model-dialog__empty">没有匹配的模型</p>
          </div>
          <p v-if="busy" class="model-dialog__status" role="status">正在切换模型…</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.model-dialog-layer { position: fixed; z-index: 230; inset: 0; display: grid; place-items: center; padding: 16px; background: var(--scrim); backdrop-filter: blur(4px); }
.model-dialog { display: flex; width: min(480px, calc(100vw - 32px)); max-height: min(650px, calc(100dvh - 32px)); padding: 12px; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: var(--shadow-float); flex-direction: column; }
.model-dialog__header { display: flex; min-height: 42px; align-items: center; justify-content: space-between; padding: 0 2px 7px 8px; }
.model-dialog__header h2 { margin: 0; color: var(--text-primary); font-size: 14px; font-weight: 650; letter-spacing: -.02em; }
.model-dialog__header .icon-button { display: grid; width: 32px; height: 32px; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }
.model-dialog__header .icon-button:hover { background: var(--surface-soft); color: var(--text-primary); }
.model-dialog__header .icon-button:disabled { cursor: wait; opacity: .45; }
.model-dialog__search { display: flex; min-height: 38px; align-items: center; gap: 8px; margin: 0 4px 10px; padding: 0 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--text-muted); transition: border-color 120ms ease, box-shadow 120ms ease; }
.model-dialog__search:focus-within { border-color: var(--input-border-focus-color); box-shadow: 0 0 0 3px var(--focus-ring); }
.model-dialog__search input { min-width: 0; flex: 1; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: 12px var(--font-ui); }
.model-dialog__search input::placeholder { color: var(--input-placeholder-color); }
.model-dialog__list { min-height: 148px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.model-dialog__group { margin-bottom: 4px; }
.model-dialog__group-header { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 6px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.model-dialog__group-header:hover { background: var(--surface-soft); }
.model-dialog__group-header:disabled { cursor: wait; }
.model-dialog__group-header strong { min-width: 0; flex: 1; font-size: 11px; font-weight: 650; }
.model-dialog__group-header span { color: var(--text-muted); font-size: 10px; font-weight: 450; }
.model-dialog__chevron { flex: 0 0 auto; transition: transform 120ms ease; }
.model-dialog__chevron.collapsed { transform: rotate(-90deg); }
.model-dialog__items { padding-left: 8px; }
.model-dialog__item { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 7px; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; transition: background-color 120ms ease, color 120ms ease; }
.model-dialog__item:hover { background: color-mix(in srgb, #1677ff 7%, transparent); color: var(--text-primary); }
.model-dialog__item:disabled { cursor: wait; opacity: .58; }
.model-dialog__item--active { color: #1677ff; font-weight: 550; }
.dark .model-dialog__item--active { color: #69a7ff; }
.model-dialog__item-label { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.model-dialog__item-label strong, .model-dialog__item-label small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-code); }
.model-dialog__item-label strong { font-size: 11px; font-weight: inherit; }
.model-dialog__item-label small { color: var(--text-muted); font-size: 9px; font-weight: 400; }
.model-dialog__badge { flex: 0 0 auto; padding: 2px 5px; border-radius: 4px; background: #1677ff; color: #fff; font-size: 8px; font-weight: 650; }
.model-dialog__badge--quiet { border: 1px solid var(--line); background: transparent; color: var(--text-muted); }
.model-dialog__check { flex: 0 0 auto; color: currentColor; }
.model-dialog__empty { margin: 0; padding: 32px 10px; color: var(--text-muted); font-size: 11px; text-align: center; }
.model-dialog__status { margin: 7px 8px 0; color: var(--text-muted); font-size: 9px; text-align: right; }
.model-dialog-fade-enter-active, .model-dialog-fade-leave-active { transition: opacity 130ms ease; }
.model-dialog-fade-enter-active .model-dialog, .model-dialog-fade-leave-active .model-dialog { transition: transform 160ms var(--ease-out); }
.model-dialog-fade-enter-from, .model-dialog-fade-leave-to { opacity: 0; }
.model-dialog-fade-enter-from .model-dialog, .model-dialog-fade-leave-to .model-dialog { transform: translateY(7px) scale(.99); }
@media (max-width: 600px) { .model-dialog-layer { padding: 12px; }.model-dialog { width: min(480px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); }.model-dialog__items { padding-left: 3px; } }
@media (prefers-reduced-motion: reduce) { .model-dialog-fade-enter-active, .model-dialog-fade-leave-active, .model-dialog-fade-enter-active .model-dialog, .model-dialog-fade-leave-active .model-dialog, .model-dialog__chevron { transition: none; } }
</style>

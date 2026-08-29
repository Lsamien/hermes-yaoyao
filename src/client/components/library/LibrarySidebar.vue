<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { LibraryFilterOption } from './types'

withDefaults(defineProps<{
  search: string
  filter: string
  options: LibraryFilterOption[]
  loading?: boolean
  error?: string
  progress?: string
}>(), { loading: false, error: '', progress: '' })

const emit = defineEmits<{ search: [value: string]; filter: [id: string]; refresh: [] }>()
</script>

<template>
  <div class="library-sidebar">
    <label class="library-search"><AppIcon name="search" :size="15" /><input :value="search" type="search" placeholder="搜索名称或来源" @input="emit('search', ($event.target as HTMLInputElement).value)" /></label>
    <section>
      <h3>类型</h3>
      <button v-for="option in options" :key="option.id" type="button" :class="{ active: option.id === filter }" @click="emit('filter', option.id)">
        <AppIcon :name="option.icon" :size="15" /><span>{{ option.label }}</span><small v-if="option.count !== undefined">{{ option.count }}</small>
      </button>
    </section>
    <div class="library-sync">
      <p v-if="error" class="error"><AppIcon name="alert" :size="13" />{{ error }}</p>
      <p v-else-if="progress">{{ progress }}</p>
      <button class="quiet-button" type="button" :disabled="loading" @click="emit('refresh')"><AppIcon name="refresh" :size="14" />{{ loading ? '同步中…' : '刷新' }}</button>
    </div>
  </div>
</template>

<style scoped>
.library-sidebar { display: flex; height: 100%; min-height: 0; flex-direction: column; padding: 0 11px 13px; }
.library-search { display: flex; min-height: 35px; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); color: var(--text-muted); }.library-search:focus-within { border-color: var(--line-strong); background: var(--surface-raised); box-shadow: 0 0 0 3px var(--focus-ring); }.library-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 13px; }
section { margin-top: 18px; } h3 { margin: 0 7px 7px; color: var(--text-muted); font-size: 10px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; } section button { display: flex; width: 100%; min-height: 39px; align-items: center; gap: 9px; padding: 0 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; } section button:hover, section button.active { background: var(--surface-hover); color: var(--text-primary); } section button.active { font-weight: 610; } section button span { flex: 1; font-size: 12px; } section button small { color: var(--text-muted); font-size: 10px; }
.library-sync { margin-top: auto; padding: 12px 4px 0; border-top: 1px solid var(--line); }.library-sync p { display: flex; align-items: flex-start; gap: 5px; margin: 0 0 8px; color: var(--text-muted); font-size: 10px; line-height: 1.5; }.library-sync p.error { color: var(--danger); }.library-sync .quiet-button { display: flex; width: 100%; gap: 6px; font-size: 11px; }
</style>

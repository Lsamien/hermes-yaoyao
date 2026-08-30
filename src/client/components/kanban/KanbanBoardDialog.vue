<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { CreateKanbanBoardInput } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'

const props = defineProps<{ open: boolean; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; create: [input: CreateKanbanBoardInput] }>()
const slugInput = ref<HTMLInputElement | null>(null)
const slug = ref('')
const name = ref('')
const description = ref('')

watch(() => props.open, open => {
  if (!open) return
  slug.value = ''
  name.value = ''
  description.value = ''
  void nextTick(() => slugInput.value?.focus())
})

function submit() {
  if (!slug.value.trim() || props.busy) return
  emit('create', {
    slug: slug.value.trim().toLowerCase(),
    ...(name.value.trim() ? { name: name.value.trim() } : {}),
    ...(description.value.trim() ? { description: description.value.trim() } : {}),
  })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="kanban-dialog-fade">
      <div v-if="open" class="kanban-dialog-layer" role="presentation" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
        <form class="kanban-board-dialog" role="dialog" aria-modal="true" aria-labelledby="kanban-board-create-title" @submit.prevent="submit">
          <header><div><small>多项目看板</small><h2 id="kanban-board-create-title">新建看板</h2></div><button type="button" aria-label="关闭新建看板" @click="emit('close')"><AppIcon name="close" /></button></header>
          <div class="kanban-board-dialog__body">
            <label><span>标识</span><input ref="slugInput" v-model="slug" required maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" placeholder="例如 mobile-release" /><small>创建后不可更改，仅支持字母、数字、连字符和下划线。</small></label>
            <label><span>名称</span><input v-model="name" maxlength="120" placeholder="例如 移动端发布" /></label>
            <label><span>说明</span><textarea v-model="description" rows="3" placeholder="这个看板负责什么？" /></label>
          </div>
          <p v-if="error" class="kanban-dialog-error" role="alert">{{ error }}</p>
          <footer><button type="button" class="quiet-button" @click="emit('close')">取消</button><button type="submit" class="primary-button" :disabled="!slug.trim() || busy">{{ busy ? '正在创建…' : '创建看板' }}</button></footer>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kanban-dialog-layer { position: fixed; z-index: 100; display: grid; inset: 0; place-items: center; padding: 20px; background: var(--scrim); backdrop-filter: blur(3px); }.kanban-board-dialog { display: flex; width: min(470px, 94vw); flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 17px; background: var(--surface-raised); box-shadow: var(--shadow-float); }.kanban-board-dialog > header { display: flex; align-items: center; justify-content: space-between; padding: 17px 19px 13px; border-bottom: 1px solid var(--line); }.kanban-board-dialog > header small { color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; }.kanban-board-dialog h2 { margin: 2px 0 0; font-size: 17px; }.kanban-board-dialog > header button { display: grid; width: 34px; height: 34px; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.kanban-board-dialog__body { display: flex; flex-direction: column; gap: 13px; padding: 17px 19px; }.kanban-board-dialog label { display: flex; flex-direction: column; gap: 6px; }.kanban-board-dialog label > span { color: var(--text-secondary); font-size: 10px; font-weight: 700; }.kanban-board-dialog label > small { color: var(--text-muted); font-size: 9px; line-height: 1.5; }.kanban-board-dialog input, .kanban-board-dialog textarea { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface); color: var(--text-primary); font: inherit; font-size: 12px; }.kanban-board-dialog textarea { resize: vertical; line-height: 1.5; }.kanban-board-dialog input:focus, .kanban-board-dialog textarea:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.kanban-dialog-error { margin: 0 19px; color: var(--danger); font-size: 11px; }.kanban-board-dialog > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 19px 17px; }.kanban-board-dialog > footer button { min-height: 38px; padding: 0 16px; border-radius: 9px; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; }.quiet-button { border: 1px solid var(--line); background: transparent; color: var(--text-secondary); }.primary-button { border: 1px solid var(--accent); background: var(--accent); color: white; }.primary-button:disabled { cursor: not-allowed; opacity: .45; }
.kanban-dialog-fade-enter-active, .kanban-dialog-fade-leave-active { transition: opacity 150ms ease; }.kanban-dialog-fade-enter-from, .kanban-dialog-fade-leave-to { opacity: 0; }
@media (max-width: 600px) { .kanban-dialog-layer { align-items: end; padding: 0; }.kanban-board-dialog { width: 100%; border-width: 1px 0 0; border-radius: 17px 17px 0 0; }.kanban-board-dialog input, .kanban-board-dialog textarea { min-height: 44px; font-size: 16px; }.kanban-board-dialog > footer { padding-bottom: max(14px, env(safe-area-inset-bottom)); }.kanban-board-dialog > footer button { min-height: 44px; flex: 1; } }
</style>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CreateKanbanTaskInput, KanbanProfile } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'
import { LOCKED_KANBAN_TARGETS, statusMeta } from './presentation'

const props = defineProps<{
  open: boolean
  targetStatus: string
  columns: string[]
  profiles: KanbanProfile[]
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  create: [input: CreateKanbanTaskInput, targetStatus: string]
}>()

const titleInput = ref<HTMLInputElement | null>(null)
const title = ref('')
const body = ref('')
const status = ref('ready')
const assignee = ref('')
const tenant = ref('')
const priority = ref(0)
const workspaceKind = ref<'scratch' | 'worktree' | 'dir'>('scratch')
const workspacePath = ref('')

const statuses = computed(() => props.columns.filter(value => !LOCKED_KANBAN_TARGETS.has(value) && value !== 'archived'))

watch(() => props.open, open => {
  if (!open) return
  title.value = ''
  body.value = ''
  status.value = statuses.value.includes(props.targetStatus) ? props.targetStatus : 'ready'
  assignee.value = ''
  tenant.value = ''
  priority.value = 0
  workspaceKind.value = 'scratch'
  workspacePath.value = ''
  void nextTick(() => titleInput.value?.focus())
})

function submit(): void {
  if (!title.value.trim() || props.busy) return
  emit('create', {
    title: title.value.trim(),
    ...(body.value.trim() ? { body: body.value.trim() } : {}),
    ...(assignee.value ? { assignee: assignee.value } : {}),
    ...(tenant.value.trim() ? { tenant: tenant.value.trim() } : {}),
    priority: Number(priority.value) || 0,
    workspace_kind: workspaceKind.value,
    ...(workspaceKind.value !== 'scratch' && workspacePath.value.trim() ? { workspace_path: workspacePath.value.trim() } : {}),
  }, status.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="kanban-dialog-fade">
      <div v-if="open" class="kanban-dialog-layer" role="presentation" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
        <form class="kanban-task-dialog" role="dialog" aria-modal="true" aria-labelledby="kanban-task-create-title" @submit.prevent="submit">
          <header>
            <div><small>{{ statusMeta(status).label }}</small><h2 id="kanban-task-create-title">新建任务</h2></div>
            <button type="button" aria-label="关闭新建任务" @click="emit('close')"><AppIcon name="close" /></button>
          </header>
          <div class="kanban-task-dialog__body">
            <label class="kanban-field kanban-field--wide"><span>标题</span><input ref="titleInput" v-model="title" maxlength="500" required placeholder="要完成什么？" /></label>
            <label class="kanban-field kanban-field--wide"><span>描述</span><textarea v-model="body" rows="4" placeholder="补充目标、边界和验收要求" /></label>
            <label class="kanban-field"><span>状态</span><select v-model="status"><option v-for="value in statuses" :key="value" :value="value">{{ statusMeta(value).label }}</option></select></label>
            <label class="kanban-field"><span>分配给</span><select v-model="assignee"><option value="">暂不分配</option><option v-for="profile in profiles" :key="profile.name" :value="profile.name">{{ profile.name }}</option></select></label>
            <label class="kanban-field"><span>租户</span><input v-model="tenant" maxlength="120" placeholder="可选命名空间" /></label>
            <label class="kanban-field"><span>优先级</span><input v-model.number="priority" type="number" min="-1000" max="1000" /></label>
            <label class="kanban-field"><span>工作区</span><select v-model="workspaceKind"><option value="scratch">临时目录</option><option value="worktree">Git worktree</option><option value="dir">已有目录</option></select></label>
            <label v-if="workspaceKind !== 'scratch'" class="kanban-field"><span>工作区路径</span><input v-model="workspacePath" placeholder="留空则继承看板设置" /></label>
          </div>
          <p v-if="error" class="kanban-dialog-error" role="alert">{{ error }}</p>
          <footer><button type="button" class="quiet-button" @click="emit('close')">取消</button><button type="submit" class="primary-button" :disabled="!title.trim() || busy">{{ busy ? '正在创建…' : '创建任务' }}</button></footer>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kanban-dialog-layer { position: fixed; z-index: 100; display: grid; inset: 0; place-items: center; padding: 20px; background: var(--scrim); backdrop-filter: blur(3px); }.kanban-task-dialog { display: flex; width: min(660px, 96vw); max-height: min(760px, 92vh); flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 17px; background: var(--surface-raised); box-shadow: var(--shadow-float); }.kanban-task-dialog > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; padding: 17px 19px 13px; border-bottom: 1px solid var(--line); }.kanban-task-dialog > header small { color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; }.kanban-task-dialog h2 { margin: 2px 0 0; font-size: 17px; }.kanban-task-dialog > header button { display: grid; width: 34px; height: 34px; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.kanban-task-dialog > header button:hover { background: var(--surface-soft); color: var(--text-primary); }
.kanban-task-dialog__body { display: grid; min-height: 0; grid-template-columns: 1fr 1fr; gap: 13px; padding: 17px 19px; overflow-y: auto; }.kanban-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }.kanban-field--wide { grid-column: 1 / -1; }.kanban-field > span { color: var(--text-secondary); font-size: 10px; font-weight: 700; }.kanban-field input, .kanban-field textarea, .kanban-field select { width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface); color: var(--text-primary); font: inherit; font-size: 12px; }.kanban-field textarea { min-height: 96px; resize: vertical; line-height: 1.5; }.kanban-field input:focus, .kanban-field textarea:focus, .kanban-field select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.kanban-dialog-error { margin: 0 19px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); font-size: 11px; }.kanban-task-dialog > footer { display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 8px; padding: 13px 19px 17px; }.kanban-task-dialog > footer button { min-height: 38px; padding: 0 16px; border-radius: 9px; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; }.quiet-button { border: 1px solid var(--line); background: transparent; color: var(--text-secondary); }.primary-button { border: 1px solid var(--accent); background: var(--accent); color: white; }.primary-button:disabled { cursor: not-allowed; opacity: .45; }
.kanban-dialog-fade-enter-active, .kanban-dialog-fade-leave-active { transition: opacity 150ms ease; }.kanban-dialog-fade-enter-from, .kanban-dialog-fade-leave-to { opacity: 0; }
@media (max-width: 600px) { .kanban-dialog-layer { align-items: end; padding: 0; }.kanban-task-dialog { width: 100%; max-height: calc(100dvh - 52px); border-width: 1px 0 0; border-radius: 17px 17px 0 0; }.kanban-task-dialog__body { grid-template-columns: 1fr; padding: 15px; }.kanban-field--wide { grid-column: auto; }.kanban-field input, .kanban-field textarea, .kanban-field select { min-height: 44px; font-size: 16px; }.kanban-task-dialog > footer { padding: 12px 15px max(14px, env(safe-area-inset-bottom)); }.kanban-task-dialog > footer button { min-height: 44px; flex: 1; } }
</style>

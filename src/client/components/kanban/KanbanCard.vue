<script setup lang="ts">
import { computed } from 'vue'
import type { KanbanTask } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'
import { formatKanbanTime, movableStatuses, statusMeta } from './presentation'

const props = defineProps<{
  task: KanbanTask
  columns: string[]
  canEdit: boolean
}>()

const emit = defineEmits<{
  open: [task: KanbanTask]
  move: [task: KanbanTask, status: string]
}>()

const meta = computed(() => statusMeta(props.task.status))
const targets = computed(() => movableStatuses(props.columns, props.task.status))
const summary = computed(() => props.task.latest_summary || props.task.body || '')

function startDrag(event: DragEvent): void {
  if (!props.canEdit || !event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', props.task.id)
  event.dataTransfer.setData('application/x-hermes-kanban-status', props.task.status)
}

function changeStatus(event: Event): void {
  const status = (event.target as HTMLSelectElement).value
  if (status && status !== props.task.status) emit('move', props.task, status)
}
</script>

<template>
  <article
    class="kanban-card"
    :class="{ 'kanban-card--running': task.status === 'running' }"
    :style="{ '--kanban-card-tone': meta.color }"
    :draggable="canEdit"
    :aria-label="`${task.title}，${meta.label}`"
    tabindex="0"
    @click="emit('open', task)"
    @keydown.enter="emit('open', task)"
    @dragstart="startDrag"
  >
    <header>
      <strong>{{ task.title || task.id }}</strong>
      <span v-if="task.priority" class="kanban-card__priority" :title="`优先级 ${task.priority}`">P{{ task.priority }}</span>
    </header>
    <p v-if="summary">{{ summary }}</p>
    <div v-if="task.progress" class="kanban-card__progress" :aria-label="`子任务进度 ${task.progress.done}/${task.progress.total}`">
      <span :style="{ width: `${task.progress.total ? task.progress.done / task.progress.total * 100 : 0}%` }" />
    </div>
    <footer>
      <span v-if="task.assignee" class="kanban-card__assignee"><i>{{ task.assignee.slice(0, 1).toUpperCase() }}</i>{{ task.assignee }}</span>
      <span v-if="task.tenant" class="kanban-card__tenant">{{ task.tenant }}</span>
      <span v-if="task.comment_count" class="kanban-card__comments"><AppIcon name="chat" :size="11" />{{ task.comment_count }}</span>
      <time v-if="task.created_at">{{ formatKanbanTime(task.created_at) }}</time>
    </footer>
    <label class="kanban-card__mobile-status" @click.stop>
      <span class="sr-only">移动任务状态</span>
      <select :value="task.status" :disabled="!canEdit" @change="changeStatus">
        <option v-for="status in targets" :key="status" :value="status">{{ statusMeta(status).label }}</option>
      </select>
    </label>
  </article>
</template>

<style scoped>
.kanban-card { position: relative; display: flex; flex-direction: column; gap: 8px; min-height: 106px; padding: 11px 11px 10px; border: 1px solid var(--line); border-left: 3px solid var(--kanban-card-tone); border-radius: 10px; background: var(--surface-raised); box-shadow: 0 1px 1px rgb(0 0 0 / .025); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease; }
.kanban-card:hover { border-color: var(--line-strong); background: var(--surface); transform: translateY(-1px); }.kanban-card:focus-visible { outline: 0; box-shadow: 0 0 0 3px var(--focus-ring); }.kanban-card[draggable="true"] { cursor: grab; }.kanban-card[draggable="true"]:active { cursor: grabbing; }
.kanban-card--running::after { position: absolute; top: 9px; right: 9px; width: 7px; height: 7px; border-radius: 50%; background: var(--kanban-card-tone); content: ''; animation: kanban-pulse 1.8s ease-in-out infinite; }
.kanban-card header { display: flex; min-width: 0; align-items: flex-start; gap: 8px; padding-right: 7px; }.kanban-card header strong { min-width: 0; flex: 1; color: var(--text-primary); font-size: 13px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }.kanban-card__priority { flex: 0 0 auto; padding: 2px 5px; border-radius: 5px; background: var(--surface-soft); color: var(--text-muted); font-size: 8px; font-weight: 750; }
.kanban-card > p { display: -webkit-box; margin: 0; overflow: hidden; color: var(--text-secondary); font-size: 10.5px; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.kanban-card__progress { height: 3px; overflow: hidden; border-radius: 999px; background: var(--surface-soft); }.kanban-card__progress span { display: block; height: 100%; border-radius: inherit; background: var(--kanban-card-tone); }
.kanban-card footer { display: flex; min-width: 0; align-items: center; gap: 7px; margin-top: auto; color: var(--text-muted); font-size: 8.5px; }.kanban-card__assignee { display: flex; min-width: 0; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.kanban-card__assignee i { display: grid; width: 17px; height: 17px; flex: 0 0 17px; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--kanban-card-tone) 14%, var(--surface)); color: var(--kanban-card-tone); font-size: 8px; font-style: normal; font-weight: 750; }.kanban-card__tenant { max-width: 75px; overflow: hidden; padding: 2px 5px; border-radius: 5px; background: var(--surface-soft); text-overflow: ellipsis; white-space: nowrap; }.kanban-card__comments { display: flex; align-items: center; gap: 2px; }.kanban-card time { margin-left: auto; white-space: nowrap; }
.kanban-card__mobile-status { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes kanban-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.12); } }
@media (max-width: 600px) { .kanban-card { min-height: 118px; padding: 13px; }.kanban-card header strong { font-size: 14px; }.kanban-card > p { font-size: 11.5px; -webkit-line-clamp: 3; }.kanban-card footer { font-size: 9.5px; }.kanban-card__mobile-status { display: block; }.kanban-card__mobile-status select { width: 100%; min-height: 34px; padding: 0 28px 0 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text-secondary); font: inherit; font-size: 11px; } }
@media (prefers-reduced-motion: reduce) { .kanban-card, .kanban-card--running::after { animation: none; transition: none; } }
</style>

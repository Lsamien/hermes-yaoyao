<script setup lang="ts">
import { computed, ref } from 'vue'
import type { KanbanColumn, KanbanTask } from '@/api/kanban'
import AppIcon from '@/components/common/AppIcon.vue'
import KanbanCard from './KanbanCard.vue'
import { LOCKED_KANBAN_TARGETS, statusMeta } from './presentation'

const props = defineProps<{
  column: KanbanColumn
  columns: string[]
  canEdit: boolean
}>()

const emit = defineEmits<{
  add: [status: string]
  open: [task: KanbanTask]
  move: [task: KanbanTask, status: string]
  dropTask: [taskId: string, status: string]
}>()

const over = ref(false)
const meta = computed(() => statusMeta(props.column.name))
const locked = computed(() => LOCKED_KANBAN_TARGETS.has(props.column.name))
const canCreate = computed(() => props.canEdit && !locked.value && props.column.name !== 'archived')

function dragOver(event: DragEvent): void {
  if (!props.canEdit || locked.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  over.value = true
}

function drop(event: DragEvent): void {
  over.value = false
  if (!props.canEdit || locked.value) return
  event.preventDefault()
  const id = event.dataTransfer?.getData('text/plain') || ''
  if (id) emit('dropTask', id, props.column.name)
}
</script>

<template>
  <section
    class="kanban-column"
    :class="{ 'kanban-column--over': over, 'kanban-column--locked': locked }"
    :style="{ '--kanban-column-tone': meta.color }"
    :aria-label="`${meta.label}，${column.tasks.length} 项任务`"
    @dragover="dragOver"
    @dragleave.self="over = false"
    @drop="drop"
  >
    <header>
      <i />
      <strong :title="meta.description">{{ meta.label }}</strong>
      <span>{{ column.tasks.length }}</span>
      <button v-if="canCreate" type="button" :aria-label="`在${meta.label}中新建任务`" @click="emit('add', column.name)">
        <AppIcon name="plus" :size="14" />
      </button>
    </header>
    <div class="kanban-column__cards">
      <KanbanCard
        v-for="task in column.tasks"
        :key="task.id"
        :task="task"
        :columns="columns"
        :can-edit="canEdit"
        @open="emit('open', $event)"
        @move="(item, status) => emit('move', item, status)"
      />
      <button v-if="canCreate" class="kanban-column__add" type="button" @click="emit('add', column.name)">
        <AppIcon name="plus" :size="13" />新建任务
      </button>
      <p v-if="column.tasks.length === 0" class="kanban-column__empty">暂无任务</p>
    </div>
  </section>
</template>

<style scoped>
.kanban-column { display: flex; width: 278px; min-width: 278px; min-height: 0; flex-direction: column; border: 1px solid transparent; border-radius: 12px; background: color-mix(in srgb, var(--surface-soft) 68%, transparent); transition: background-color 120ms ease, border-color 120ms ease; scroll-snap-align: start; }.kanban-column--over { border-color: color-mix(in srgb, var(--kanban-column-tone) 54%, var(--line)); background: color-mix(in srgb, var(--kanban-column-tone) 7%, var(--surface-soft)); }.kanban-column--locked { background: color-mix(in srgb, var(--surface-soft) 46%, transparent); }
.kanban-column > header { display: flex; min-height: 42px; flex: 0 0 auto; align-items: center; gap: 7px; padding: 7px 9px; }.kanban-column > header > i { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--kanban-column-tone); }.kanban-column > header strong { color: var(--text-secondary); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }.kanban-column > header span { color: var(--text-muted); font-size: 9px; font-variant-numeric: tabular-nums; }.kanban-column > header button { display: grid; width: 28px; height: 28px; margin-left: auto; place-items: center; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }.kanban-column > header button:hover { background: var(--surface-hover); color: var(--text-primary); }
.kanban-column__cards { position: relative; display: flex; min-height: 120px; flex: 1; flex-direction: column; gap: 8px; padding: 0 7px 8px; overflow-y: auto; }.kanban-column__add { display: flex; min-height: 34px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 5px; border: 1px dashed var(--line-strong); border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; opacity: .45; }.kanban-column:hover .kanban-column__add, .kanban-column__add:focus-visible { opacity: 1; }.kanban-column__add:hover { background: var(--surface-hover); color: var(--text-secondary); }.kanban-column__empty { position: absolute; inset: 42px 0 auto; margin: 0; color: var(--text-muted); font-size: 10px; text-align: center; pointer-events: none; }
@media (max-width: 600px) { .kanban-column { width: calc(100vw - 30px); min-width: calc(100vw - 30px); max-height: 100%; }.kanban-column > header { min-height: 46px; padding-inline: 12px; }.kanban-column > header strong { font-size: 11px; }.kanban-column__cards { padding: 0 9px 10px; }.kanban-column__add { min-height: 40px; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .kanban-column { transition: none; } }
</style>

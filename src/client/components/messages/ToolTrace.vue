<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiToolCall } from './types'

const props = defineProps<{ tool: UiToolCall }>()
const open = ref(props.tool.status === 'error')
const statusLabel = computed(() => ({ running: '运行中', success: '完成', error: '失败', pending: '等待' })[props.tool.status])
const detail = computed(() => {
  const value = props.tool.output ?? props.tool.input
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value ?? '') }
})
</script>

<template>
  <div class="tool-trace" :class="`tool-trace--${tool.status}`">
    <button type="button" @click="open = !open">
      <span class="tool-trace__icon"><AppIcon name="tools" :size="14" /></span>
      <span class="tool-trace__copy"><strong>{{ tool.name }}</strong><small>{{ statusLabel }}<template v-if="tool.durationMs"> · {{ tool.durationMs }} ms</template></small></span>
      <span v-if="tool.status === 'running'" class="tool-trace__pulse" />
      <AppIcon name="chevron-down" :size="13" :class="{ rotated: open }" />
    </button>
    <pre v-if="open && detail">{{ detail }}</pre>
  </div>
</template>

<style scoped>
.tool-trace { margin: 7px 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; }
.tool-trace > button { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 6px 9px; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.tool-trace > button:hover { background: var(--surface-soft); }
.tool-trace__icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--surface-soft); }
.tool-trace__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }.tool-trace__copy strong { color: var(--text-primary); font-size: 10px; font-weight: 580; }.tool-trace__copy small { margin-top: 2px; color: var(--text-muted); font-size: 9px; }
.tool-trace__pulse { width: 5px; height: 5px; border-radius: 50%; background: var(--warning); animation: pulse 1s ease infinite; }
.rotated { transform: rotate(180deg); }.app-icon { transition: transform 140ms ease; }
pre { max-height: 260px; margin: 0; padding: 10px 12px; overflow: auto; border-top: 1px solid var(--line); background: var(--surface-soft); color: var(--text-secondary); font: 10px/1.55 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-trace--error { border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); }
@keyframes pulse { 50% { opacity: .3; } }
</style>

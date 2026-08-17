<script setup lang="ts">
import { computed, ref } from 'vue'
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
      <span class="tool-trace__caret" :class="{ open }">›</span>
      <strong>{{ tool.name }}</strong>
      <small v-if="tool.status === 'error'">{{ statusLabel }}</small>
    </button>
    <pre v-if="open && detail">{{ detail }}</pre>
  </div>
</template>

<style scoped>
.tool-trace { margin: 7px 0; color: var(--text-muted); }
.tool-trace > button { display: inline-flex; min-height: 22px; align-items: center; gap: 7px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: 10px/1.5 var(--font-code); text-align: left; }
.tool-trace > button:hover { color: var(--text-secondary); }
.tool-trace > button strong { font: inherit; font-weight: 400; letter-spacing: .01em; }
.tool-trace > button small { color: var(--danger); font: inherit; }
.tool-trace__caret { display: inline-block; width: 9px; color: var(--text-muted); font-size: 13px; line-height: 1; transition: transform 120ms ease; }.tool-trace__caret.open { transform: rotate(90deg); }
pre { max-width: min(680px, 100%); max-height: 260px; margin: 4px 0 2px 16px; padding: 8px 10px; overflow: auto; border-left: 1px dashed var(--line-strong); background: transparent; color: var(--text-secondary); font: 10px/1.55 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-trace--error { color: var(--danger); }
</style>

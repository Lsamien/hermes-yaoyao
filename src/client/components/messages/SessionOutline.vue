<script setup lang="ts">
import { computed } from 'vue'
import type { UiMessage } from './types'
import { buildSessionOutline, type SessionOutlineItem } from '@/utils/sessionOutline'

const props = defineProps<{ messages: UiMessage[]; hasOlder?: boolean }>()
const emit = defineEmits<{ navigate: [target: { messageId: string; anchorId: string }] }>()

const items = computed(() => buildSessionOutline(props.messages))

function formatTime(value?: UiMessage['createdAt']) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function navigate(item: SessionOutlineItem) {
  emit('navigate', { messageId: item.messageId, anchorId: item.anchorId })
}
</script>

<template>
  <nav class="session-outline" aria-label="会话大纲">
    <header>
      <div><strong>会话大纲</strong><span>{{ items.length }} 项</span></div>
      <p>按问题与回答标题快速定位</p>
    </header>
    <div class="session-outline__content">
      <template v-if="items.length">
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="outline-item"
          :class="[`outline-item--${item.type}`, `outline-item--level-${item.level}`]"
          :aria-label="`跳转到 ${item.content}`"
          @click="navigate(item)"
        >
          <template v-if="item.type === 'user'">
            <b>Q</b><span>{{ item.content }}</span><time v-if="formatTime(item.createdAt)">{{ formatTime(item.createdAt) }}</time>
          </template>
          <template v-else>
            <i aria-hidden="true" /><span>{{ item.content }}</span>
          </template>
        </button>
      </template>
      <div v-else class="session-outline__empty">
        <strong>还没有大纲</strong>
        <p>发送问题，或让回答使用 Markdown 标题后会显示在这里。</p>
      </div>
    </div>
    <footer v-if="hasOlder">当前大纲基于已加载的消息</footer>
  </nav>
</template>

<style scoped>
.session-outline { display: flex; height: 100%; min-height: 0; flex-direction: column; background: var(--surface); }
.session-outline > header { flex: 0 0 auto; min-height: 60px; padding: 13px 48px 10px 15px; border-bottom: 1px solid var(--line); }.session-outline > header > div { display: flex; align-items: baseline; gap: 8px; }.session-outline > header strong { font-size: 13px; font-weight: 620; }.session-outline > header span { color: var(--text-muted); font-size: 9px; }.session-outline > header p { margin: 4px 0 0; color: var(--text-muted); font-size: 9px; }
.session-outline__content { min-height: 0; flex: 1; padding: 10px; overflow-y: auto; }
.outline-item { display: flex; width: 100%; min-width: 0; align-items: flex-start; gap: 7px; margin: 0 0 3px; padding: 6px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; text-align: left; transition: background-color 100ms ease, color 100ms ease; }.outline-item:hover, .outline-item:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }.outline-item span { min-width: 0; overflow: hidden; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }.outline-item time { flex: 0 0 auto; margin-left: auto; color: var(--text-muted); font-size: 8px; font-variant-numeric: tabular-nums; }
.outline-item--user { margin: 6px 0; padding: 8px 9px; border-radius: 9px; background: var(--surface-soft); color: var(--text-primary); }.outline-item--user:first-child { margin-top: 0; }.outline-item--user b { display: grid; width: 19px; height: 19px; flex: 0 0 19px; place-items: center; border-radius: 6px; background: var(--surface-raised); color: var(--text-secondary); font-size: 9px; font-weight: 650; }.outline-item--user span { font-size: 11.5px; font-weight: 520; }
.outline-item--heading i { width: 4px; height: 4px; flex: 0 0 4px; margin-top: 6px; border-radius: 50%; background: currentColor; opacity: .45; }.outline-item--level-1 { padding-left: 10px; color: var(--text-primary); }.outline-item--level-1 span { font-weight: 560; }.outline-item--level-2 { padding-left: 22px; }.outline-item--level-3 { padding-left: 34px; color: var(--text-muted); }.outline-item--level-3 span { font-size: 10.5px; }
.session-outline__empty { display: flex; min-height: 220px; align-items: center; justify-content: center; padding: 24px; flex-direction: column; color: var(--text-muted); text-align: center; }.session-outline__empty strong { color: var(--text-secondary); font-size: 12px; }.session-outline__empty p { max-width: 220px; margin: 6px 0 0; font-size: 10px; line-height: 1.55; }
.session-outline > footer { flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--text-muted); font-size: 8px; text-align: center; }
@media (prefers-reduced-motion: reduce) { .outline-item { transition: none; } }
</style>

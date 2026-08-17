<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiInteraction } from './types'

defineProps<{ interaction: UiInteraction; busy?: boolean }>()
const emit = defineEmits<{ approve: [approved: boolean]; clarify: [text: string] }>()
const answer = ref('')
</script>

<template>
  <section class="interaction-card" aria-live="polite">
    <div class="interaction-card__heading">
      <span><AppIcon :name="interaction.kind === 'approval' ? 'check' : 'chat'" :size="16" /></span>
      <div><small>{{ interaction.kind === 'approval' ? '需要审批' : '需要补充信息' }}</small><strong>{{ interaction.title || interaction.prompt }}</strong></div>
    </div>
    <p v-if="interaction.title">{{ interaction.prompt }}</p>
    <details v-if="interaction.detail"><summary>查看详情</summary><pre>{{ interaction.detail }}</pre></details>
    <div v-if="interaction.kind === 'approval'" class="interaction-card__actions">
      <button class="quiet-button" type="button" :disabled="busy" @click="emit('approve', false)">拒绝</button>
      <button class="solid-button" type="button" :disabled="busy" @click="emit('approve', true)">允许</button>
    </div>
    <form v-else class="interaction-card__answer" @submit.prevent="answer.trim() && emit('clarify', answer.trim())">
      <div v-if="interaction.options?.length" class="interaction-card__options">
        <button v-for="option in interaction.options" :key="option" type="button" @click="answer = option">{{ option }}</button>
      </div>
      <textarea v-model="answer" rows="2" placeholder="输入回复" />
      <button class="solid-button" type="submit" :disabled="busy || !answer.trim()">提交</button>
    </form>
  </section>
</template>

<style scoped>
.interaction-card { width: min(560px, 100%); margin: 16px auto 6px; padding: 14px; border: 1px solid var(--line-strong); border-radius: 13px; background: var(--surface-raised); box-shadow: 0 12px 32px rgba(0,0,0,.06); }
.interaction-card__heading { display: flex; align-items: flex-start; gap: 10px; }.interaction-card__heading > span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); }.interaction-card__heading div { display: flex; flex: 1; flex-direction: column; }.interaction-card__heading small { color: var(--warning); font-size: 9px; font-weight: 650; letter-spacing: .07em; }.interaction-card__heading strong { margin-top: 2px; font-size: 12px; line-height: 1.45; }
p { margin: 10px 0 0 40px; color: var(--text-secondary); font-size: 11px; line-height: 1.6; } details { margin: 9px 0 0 40px; color: var(--text-muted); font-size: 10px; } summary { cursor: pointer; } pre { max-height: 180px; overflow: auto; font: 9px/1.5 var(--font-code); white-space: pre-wrap; }
.interaction-card__actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 13px; }.interaction-card__answer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }.interaction-card__answer textarea { width: 100%; resize: vertical; padding: 8px 9px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font-size: 12px; }.interaction-card__answer textarea:focus { border-color: var(--line-strong); }
.interaction-card__options { display: flex; width: 100%; flex-wrap: wrap; gap: 5px; }.interaction-card__options button { padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; }.interaction-card__options button:hover { background: var(--surface-hover); color: var(--text-primary); }
</style>

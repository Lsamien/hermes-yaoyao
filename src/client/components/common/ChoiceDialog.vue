<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { ChoiceOption } from './types'

defineProps<{ open: boolean; title: string; options: ChoiceOption[]; selectedId?: string }>()
const emit = defineEmits<{ close: []; select: [id: string] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="choice-fade">
      <div v-if="open" class="choice-layer" @mousedown.self="emit('close')">
        <section class="choice-dialog" role="dialog" aria-modal="true" :aria-label="title">
          <header><h2>{{ title }}</h2><button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
          <div class="choice-list">
            <button v-for="option in options" :key="option.id" type="button" :class="{ selected: option.id === selectedId }" :disabled="option.disabled" @click="emit('select', option.id)">
              <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span><AppIcon v-if="option.id === selectedId" name="check" :size="16" />
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.choice-layer { position: fixed; z-index: 210; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(4px); }
.choice-dialog { width: min(420px, 100%); max-height: min(620px, calc(100vh - 36px)); padding: 13px; overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
header { display: flex; min-height: 43px; align-items: center; justify-content: space-between; padding: 0 3px 7px 8px; } h2 { margin: 0; font-size: 14px; letter-spacing: -.02em; }
.choice-list { display: flex; flex-direction: column; gap: 3px; }.choice-list button { display: flex; width: 100%; min-height: 48px; align-items: center; gap: 10px; padding: 7px 9px; border: 0; border-radius: 10px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.choice-list button:hover, .choice-list button.selected { background: var(--surface-soft); }.choice-list button:disabled { cursor: not-allowed; opacity: .35; }.choice-list button > span { display: flex; min-width: 0; flex: 1; flex-direction: column; }.choice-list strong { font-size: 11px; }.choice-list small { margin-top: 3px; color: var(--text-muted); font-size: 9px; }
.choice-fade-enter-active, .choice-fade-leave-active { transition: opacity 130ms ease; }.choice-fade-enter-active .choice-dialog, .choice-fade-leave-active .choice-dialog { transition: transform 160ms var(--ease-out); }.choice-fade-enter-from, .choice-fade-leave-to { opacity: 0; }.choice-fade-enter-from .choice-dialog, .choice-fade-leave-to .choice-dialog { transform: translateY(7px) scale(.99); }
@media (max-width: 600px) { .choice-layer { place-items: end center; padding: 0; }.choice-dialog { width: 100%; max-height: 72vh; border-radius: 17px 17px 0 0; padding-bottom: max(13px, env(safe-area-inset-bottom)); } }
</style>

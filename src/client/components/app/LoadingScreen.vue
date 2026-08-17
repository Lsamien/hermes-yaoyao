<script setup lang="ts">
import BrandMark from '@/components/common/BrandMark.vue'

withDefaults(defineProps<{ message?: string }>(), { message: '正在恢复会话…' })
</script>

<template>
  <main class="loading-screen" aria-live="polite">
    <BrandMark :size="48" label />
    <span class="loading-line"><i />{{ message }}</span>
  </main>
</template>

<style scoped>
.loading-screen { display: grid; place-content: center; justify-items: center; width: 100%; height: 100%; background: var(--canvas); }
.loading-line { display: flex; align-items: center; gap: 8px; margin-top: 22px; color: var(--text-muted); font-size: 11px; }
.loading-line i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-primary); animation: blink 1.15s ease-in-out infinite; }
@keyframes blink { 50% { opacity: .2; transform: scale(.72); } }
</style>

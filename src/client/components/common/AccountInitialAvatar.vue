<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  size?: number
}>(), { size: 30 })

const initial = computed(() => Array.from(props.name.trim())[0]?.toLocaleUpperCase() || '?')
const colors = ['#1488ff', '#00a17a', '#9655f7', '#e05d2f', '#b7791f', '#5166d6'] as const
const background = computed(() => {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(props.name.trim().toLocaleLowerCase() || '?')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return colors[hash % colors.length]
})
</script>

<template>
  <span
    class="account-initial-avatar"
    :style="{ width: `${size}px`, height: `${size}px`, backgroundColor: background, fontSize: `${Math.max(11, Math.round(size * .42))}px` }"
    role="img"
    :aria-label="`${name || '当前账号'} 的账号头像`"
  ><span aria-hidden="true">{{ initial }}</span></span>
</template>

<style scoped>
.account-initial-avatar { display: inline-grid; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #fff; font-weight: 700; line-height: 1; text-transform: uppercase; user-select: none; }
</style>

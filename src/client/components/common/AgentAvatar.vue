<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  avatar?: string
  size?: number
}>(), { avatar: '', size: 32 })

const initials = computed(() => (props.name.trim() || 'A').slice(0, 1).toLocaleUpperCase())
const hasAvatar = computed(() => /^data:image\/(png|jpeg|webp);base64,/i.test(props.avatar))
</script>

<template>
  <span
    class="agent-avatar"
    :class="{ 'agent-avatar--image': hasAvatar }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :aria-label="`${name} 的头像`"
  >
    <img v-if="hasAvatar" :src="avatar" alt="" />
    <span v-else>{{ initials }}</span>
  </span>
</template>

<style scoped>
.agent-avatar { display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 50%; background: transparent; color: var(--text-secondary); font-size: calc(v-bind(size) * .36); font-weight: 700; line-height: 1; }
.agent-avatar.agent-avatar--image { background: transparent; }
.agent-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>

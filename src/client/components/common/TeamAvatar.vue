<script setup lang="ts">
import { computed } from 'vue'
import { resolvedTeamAvatarSource } from '@/utils/teamAvatar'

export type TeamAvatarMember = {
  name: string
  avatar?: string
}

const props = withDefaults(defineProps<{
  name: string
  avatar?: string
  members?: TeamAvatarMember[]
  fallbackKey?: string
  size?: number
}>(), {
  avatar: '',
  members: () => [],
  fallbackKey: '',
  size: 32,
})

const avatarSource = computed(() => resolvedTeamAvatarSource(props.avatar, props.fallbackKey || props.name))
</script>

<template>
  <span
    class="team-avatar"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="`${name}团队头像`"
  >
    <img class="team-avatar__image" :src="avatarSource" alt="" />
  </span>
</template>

<style scoped>
.team-avatar { position: relative; display: block; flex: 0 0 auto; overflow: hidden; border-radius: 50%; background: var(--surface-raised); }
.team-avatar__image { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>

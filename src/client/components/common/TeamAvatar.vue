<script setup lang="ts">
import { computed } from 'vue'
import AgentAvatar from './AgentAvatar.vue'
import { AGENT_MASCOT_COLORS, AGENT_MASCOT_SHAPES } from '@shared/agentIdentity'

export type TeamAvatarMember = {
  name: string
  avatar?: string
  state?: 'idle' | 'working' | 'waiting'
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

const hasUploadedImage = computed(() => /^data:image\/(png|jpeg|webp);base64,/i.test(props.avatar))

function stableIndex(value: string, count: number): number {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(value || 'team')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash % count
}

const clusterMembers = computed(() => {
  const entries = props.members.slice(0, 3).map(member => ({
    name: member.name,
    avatar: member.avatar || '',
    state: member.state || 'idle',
  }))
  const key = props.fallbackKey || props.name || 'team'
  const fallbackCount = entries.length ? entries.length : 3
  while (entries.length < fallbackCount) {
    const index = entries.length
    const shape = AGENT_MASCOT_SHAPES[index]!
    const color = AGENT_MASCOT_COLORS[
      stableIndex(`${key}:group:${index}`, 10)
    ]!.slice(1)
    entries.push({
      name: `${props.name || '团队'} ${index + 1}`,
      avatar: `yaoyao-mascot:v1:${shape}:${color}:friendly`,
      state: 'idle',
    })
  }
  return entries
})
</script>

<template>
  <span
    class="team-avatar"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="`${name}团队头像`"
  >
    <img v-if="hasUploadedImage" class="team-avatar__image" :src="avatar" alt="" />
    <span v-else class="team-avatar__cluster" aria-hidden="true">
      <AgentAvatar
        v-for="(member, index) in clusterMembers"
        :key="`${member.name}:${index}`"
        class="team-avatar__member"
        :class="`team-avatar__member--${index + 1}`"
        :name="member.name"
        :avatar="member.avatar"
        :state="member.state"
        :size="Math.round(size * .64)"
      />
    </span>
  </span>
</template>

<style scoped>
.team-avatar { position: relative; display: block; flex: 0 0 auto; overflow: visible; }
.team-avatar__image { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--line); }
.team-avatar__cluster { position: absolute; inset: 0; display: block; }
.team-avatar__member { position: absolute; filter: drop-shadow(0 1px 1px color-mix(in srgb, #000 18%, transparent)); }
.team-avatar__member--1 { z-index: 3; left: 0; top: 18%; }
.team-avatar__member--2 { z-index: 2; top: 0; right: 0; }
.team-avatar__member--3 { z-index: 1; right: 1%; bottom: 0; }
</style>

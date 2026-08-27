<script setup lang="ts">
import { computed } from 'vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'

export type TeamAvatarMember = {
  name: string
  avatar?: string
}

const props = withDefaults(defineProps<{
  name: string
  avatar?: string
  members?: TeamAvatarMember[]
  size?: number
}>(), {
  avatar: '',
  members: () => [],
  size: 32,
})

const hasCustomAvatar = computed(() => /^data:image\/(png|jpeg|webp);base64,/i.test(props.avatar))
const visibleMembers = computed(() => props.members.slice(0, 4))
const memberSize = computed(() => Math.max(12, Math.round(props.size * ({ 1: .72, 2: .62, 3: .54, 4: .48 }[visibleMembers.value.length] || .48))))
</script>

<template>
  <span
    class="team-avatar"
    :class="`team-avatar--${Math.max(1, visibleMembers.length)}`"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="`${name}团队头像`"
  >
    <img v-if="hasCustomAvatar" class="team-avatar__custom" :src="avatar" alt="" />
    <template v-else-if="visibleMembers.length">
      <span
        v-for="(member, index) in visibleMembers"
        :key="`${member.name}:${index}`"
        class="team-avatar__member"
        :style="{ width: `${memberSize}px`, height: `${memberSize}px` }"
      >
        <AgentAvatar :name="member.name" :avatar="member.avatar" :size="memberSize" />
      </span>
    </template>
    <span v-else class="team-avatar__fallback">{{ name.trim().slice(0, 1).toUpperCase() || '团' }}</span>
  </span>
</template>

<style scoped>
.team-avatar { position: relative; display: block; flex: 0 0 auto; overflow: hidden; border-radius: 50%; background: var(--surface-raised); color: var(--text-secondary); }
.team-avatar__custom { width: 100%; height: 100%; object-fit: cover; }
.team-avatar__member { position: absolute; display: grid; place-items: center; overflow: hidden; border-radius: 50%; background: color-mix(in srgb, var(--surface-raised) 82%, var(--accent)); box-shadow: 0 0 0 max(1px, calc(v-bind(size) * .035)) var(--surface-raised); }
.team-avatar__member :deep(.agent-avatar) { border-radius: 50%; }
.team-avatar__member:nth-of-type(2) { background: color-mix(in srgb, var(--surface-raised) 84%, var(--danger)); }
.team-avatar__member:nth-of-type(3) { background: color-mix(in srgb, var(--surface-raised) 84%, var(--success)); }
.team-avatar__member:nth-of-type(4) { background: color-mix(in srgb, var(--surface-raised) 84%, var(--warning)); }
.team-avatar--1 .team-avatar__member { top: 50%; left: 50%; transform: translate(-50%, -50%); }
.team-avatar--2 .team-avatar__member { top: 50%; left: 8%; transform: translateY(-50%); }
.team-avatar--2 .team-avatar__member:nth-of-type(2) { right: 8%; left: auto; }
.team-avatar--3 .team-avatar__member:first-of-type { top: 2%; left: 50%; transform: translateX(-50%); }
.team-avatar--3 .team-avatar__member:nth-of-type(2) { bottom: 3%; left: 4%; }
.team-avatar--3 .team-avatar__member:nth-of-type(3) { right: 4%; bottom: 3%; }
.team-avatar--4 .team-avatar__member:first-of-type { top: 4%; left: 4%; }
.team-avatar--4 .team-avatar__member:nth-of-type(2) { top: 4%; right: 4%; }
.team-avatar--4 .team-avatar__member:nth-of-type(3) { bottom: 4%; left: 4%; }
.team-avatar--4 .team-avatar__member:nth-of-type(4) { right: 4%; bottom: 4%; }
.team-avatar__fallback { display: grid; width: 100%; height: 100%; place-items: center; background: var(--surface-hover); font-size: calc(v-bind(size) * .36); font-weight: 700; }
</style>

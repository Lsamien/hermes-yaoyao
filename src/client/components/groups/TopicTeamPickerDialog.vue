<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import type { GroupRoomSummary } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'

const props = withDefaults(defineProps<{
  open: boolean
  rooms: GroupRoomSummary[]
  currentRoomId?: string
}>(), { currentRoomId: '' })

const emit = defineEmits<{ close: []; select: [roomId: string] }>()

function close() { emit('close') }
function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') close()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="topic-team-picker-fade">
      <div v-if="open" class="topic-team-picker-layer" role="presentation" @mousedown.self="close">
        <section class="topic-team-picker" role="dialog" aria-modal="true" aria-labelledby="topic-team-picker-title">
          <header>
            <div><small>新建话题</small><h2 id="topic-team-picker-title">选择团队</h2></div>
            <button class="icon-button" type="button" aria-label="关闭" @click="close"><AppIcon name="close" :size="17" /></button>
          </header>
          <p class="topic-team-picker__hint">话题将创建在所选团队中。</p>
          <div class="topic-team-picker__list">
            <button v-for="room in rooms" :key="room.id" type="button" :class="{ current: room.id === currentRoomId }" @click="emit('select', room.id)">
              <TeamAvatar :name="room.name" :avatar="room.avatar || ''" :members="room.avatarMembers?.map(member => ({ name: member.displayName })) || []" :fallback-key="room.id" :size="34" />
              <span><strong>{{ room.name }}</strong><small>{{ room.agentCount }} 个 Agent</small></span>
              <em v-if="room.id === currentRoomId">当前</em>
              <AppIcon class="topic-team-picker__next" name="chevron-left" :size="15" />
            </button>
          </div>
          <p v-if="!rooms.length" class="topic-team-picker__empty">当前没有可用团队，请先新建团队。</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.topic-team-picker-layer { position: fixed; z-index: 230; inset: 0; display: grid; place-items: center; padding: 16px; background: var(--scrim); backdrop-filter: blur(4px); }
.topic-team-picker { display: flex; width: min(420px, calc(100vw - 32px)); max-height: min(600px, calc(100dvh - 32px)); padding: 14px; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: var(--shadow-float); flex-direction: column; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 2px 2px 10px 7px; } header small { color: var(--text-muted); font-size: 10px; letter-spacing: .04em; } h2 { margin: 3px 0 0; color: var(--text-primary); font-size: 18px; font-weight: 680; letter-spacing: -.025em; }
.icon-button { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); cursor: pointer; }.icon-button:hover, .icon-button:focus-visible { outline: 0; background: var(--surface-soft); color: var(--text-primary); }
.topic-team-picker__hint { margin: 0 7px 10px; color: var(--text-muted); font-size: 11px; }
.topic-team-picker__list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.topic-team-picker__list > button { display: flex; width: 100%; min-height: 52px; align-items: center; gap: 10px; padding: 7px 9px; border: 0; border-radius: 10px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.topic-team-picker__list > button:hover, .topic-team-picker__list > button:focus-visible { outline: 0; background: var(--surface-soft); }.topic-team-picker__list > button.current { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.topic-team-picker__list > button > span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.topic-team-picker__list strong, .topic-team-picker__list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.topic-team-picker__list strong { font-size: 14px; font-weight: 620; }.topic-team-picker__list small { color: var(--text-muted); font-size: 10px; font-weight: 400; }.topic-team-picker__list em { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 9px; font-style: normal; font-weight: 620; }.topic-team-picker__list :deep(.app-icon) { flex: 0 0 auto; color: var(--text-muted); }
.topic-team-picker__next { transform: rotate(180deg); }
.topic-team-picker__empty { margin: 0; padding: 34px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
.topic-team-picker-fade-enter-active, .topic-team-picker-fade-leave-active { transition: opacity 130ms ease; }.topic-team-picker-fade-enter-active .topic-team-picker, .topic-team-picker-fade-leave-active .topic-team-picker { transition: transform 160ms var(--ease-out); }.topic-team-picker-fade-enter-from, .topic-team-picker-fade-leave-to { opacity: 0; }.topic-team-picker-fade-enter-from .topic-team-picker, .topic-team-picker-fade-leave-to .topic-team-picker { transform: translateY(7px) scale(.99); }
@media (max-width: 600px) { .topic-team-picker-layer { padding: 12px; }.topic-team-picker { width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); } }
@media (prefers-reduced-motion: reduce) { .topic-team-picker-fade-enter-active, .topic-team-picker-fade-leave-active, .topic-team-picker-fade-enter-active .topic-team-picker, .topic-team-picker-fade-leave-active .topic-team-picker { transition: none; } }
</style>

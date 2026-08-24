<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

interface CreateGroupPayload {
  name: string
  profiles: string[]
  autoReply: boolean
  replyRounds: number
  hostProfile?: string
  orchestrationMode?: 'free' | 'host'
}

const props = withDefaults(defineProps<{ open: boolean; profiles: string[]; hostEnabled?: boolean; hostFlowEnabled?: boolean; busy?: boolean }>(), {
  hostEnabled: false,
  hostFlowEnabled: false,
  busy: false,
})
const emit = defineEmits<{ close: []; create: [payload: CreateGroupPayload] }>()

const name = ref('')
const selected = ref<string[]>([])
const hostProfile = ref('')
const autoReply = ref(true)
const replyRounds = ref(3)
const orchestrationMode = ref<'free' | 'host'>('free')
const valid = computed(() => name.value.trim().length > 0
  && selected.value.length >= 1
  && selected.value.length <= 8
  && (!props.hostEnabled || selected.value.includes(hostProfile.value)))

watch(() => props.open, open => {
  if (!open) return
  name.value = ''
  selected.value = props.profiles.slice(0, 1)
  hostProfile.value = selected.value[0] ?? ''
  autoReply.value = true
  replyRounds.value = 3
  orchestrationMode.value = 'free'
}, { immediate: true })

function toggle(profile: string) {
  if (selected.value.includes(profile)) selected.value = selected.value.filter(item => item !== profile)
  else if (selected.value.length < 8) selected.value.push(profile)
  if (!selected.value.includes(hostProfile.value)) hostProfile.value = selected.value[0] ?? ''
}

function create() {
  if (!valid.value) return
  const payload: CreateGroupPayload = {
    name: name.value.trim(),
    profiles: selected.value,
    autoReply: autoReply.value,
    replyRounds: replyRounds.value,
  }
  if (props.hostEnabled) payload.hostProfile = hostProfile.value
  if (props.hostFlowEnabled) payload.orchestrationMode = orchestrationMode.value
  emit('create', payload)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="open" class="dialog-layer" role="presentation" @mousedown.self="emit('close')">
        <section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title">
          <header><div><small>9119 群聊</small><h2 id="create-group-title">新建群聊</h2></div><button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
          <label class="field"><span>群聊名称</span><input v-model="name" maxlength="80" autofocus placeholder="例如：产品评审" /></label>
          <div class="agent-picker">
            <div class="agent-picker__heading"><span>选择 Agent</span><small>{{ selected.length }}/8</small></div>
            <button v-for="profile in profiles" :key="profile" type="button" :class="{ selected: selected.includes(profile) }" :disabled="!selected.includes(profile) && selected.length >= 8" @click="toggle(profile)">
              <span>{{ profile.slice(0, 1).toUpperCase() }}</span><strong>{{ profile }}</strong><AppIcon v-if="selected.includes(profile)" name="check" :size="15" />
            </button>
            <p v-if="!profiles.length">当前没有可用 Agent，请先在 Hermes 配置 Profile。</p>
          </div>
          <label v-if="hostEnabled" class="host-picker">
            <span>主持人<small>用户没有明确 @ 时，主持人始终负责回应。</small></span>
            <select v-model="hostProfile" aria-label="主持人">
              <option v-for="profile in selected" :key="profile" :value="profile">{{ profile }}</option>
            </select>
          </label>
          <label v-if="hostFlowEnabled" class="host-picker">
            <span>协作模式<small>主持人可按依赖串行调度，也可一次 @ 多人并列执行；整批结束后统一复核。</small></span>
            <select v-model="orchestrationMode" aria-label="协作模式">
              <option value="free">自由讨论</option>
              <option value="host">主持流程</option>
            </select>
          </label>
          <div class="dialog-settings">
            <label><input v-model="autoReply" type="checkbox" :aria-label="hostEnabled ? '所有成员无需 @ 也回复' : '启用自动回复'" />{{ hostEnabled ? (orchestrationMode === 'host' ? '自由讨论时无需 @ 也回复' : '所有成员无需 @ 也回复') : '启用自动回复' }}</label>
            <label>最多轮数 <input v-model.number="replyRounds" type="number" min="1" max="12" /></label>
          </div>
          <footer><button class="quiet-button" type="button" @click="emit('close')">取消</button><button class="solid-button" type="button" :disabled="!valid || busy" @click="create">{{ busy ? '创建中…' : '创建群聊' }}</button></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-layer { position: fixed; z-index: 200; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(5px); }
.create-dialog { width: min(470px, 100%); max-height: min(680px, calc(100vh - 36px)); padding: 18px; overflow-y: auto; border: 1px solid var(--line); border-radius: 17px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; } header small { color: var(--text-muted); font-size: 9px; letter-spacing: .06em; } h2 { margin: 3px 0 0; font-size: 19px; letter-spacing: -.03em; }
.field { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 10px; }.field input { height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; outline: none; background: var(--surface-soft); color: var(--text-primary); }.field input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.agent-picker { margin-top: 17px; }.agent-picker__heading { display: flex; justify-content: space-between; margin-bottom: 7px; color: var(--text-secondary); font-size: 10px; }.agent-picker__heading small { color: var(--text-muted); }.agent-picker > button { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 5px 8px; border: 0; border-radius: 9px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.agent-picker > button:hover, .agent-picker > button.selected { background: var(--surface-soft); }.agent-picker > button:disabled { opacity: .35; }.agent-picker > button > span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--text-on-solid); font-size: 10px; }.agent-picker > button strong { flex: 1; font-size: 11px; }.agent-picker p { color: var(--text-muted); font-size: 10px; }
.host-picker { display: grid; grid-template-columns: minmax(0, 1fr) 148px; align-items: center; gap: 12px; margin-top: 13px; padding: 11px; border: 1px solid var(--line); border-radius: 10px; color: var(--text-secondary); font-size: 10px; }.host-picker > span { display: flex; min-width: 0; flex-direction: column; gap: 3px; font-weight: 650; }.host-picker small { color: var(--text-muted); font-size: 9px; font-weight: 400; line-height: 1.45; }.host-picker select { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font-size: 10px; }.host-picker select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.dialog-settings { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 15px; padding: 11px; border-radius: 10px; background: var(--surface-soft); }.dialog-settings label { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 10px; }.dialog-settings input[type="checkbox"] { accent-color: var(--accent); }.dialog-settings input[type="number"] { width: 51px; padding: 4px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-raised); color: var(--text-primary); text-align: center; }
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.dialog-fade-enter-active, .dialog-fade-leave-active { transition: opacity 140ms ease; }.dialog-fade-enter-active .create-dialog, .dialog-fade-leave-active .create-dialog { transition: transform 170ms var(--ease-out); }.dialog-fade-enter-from, .dialog-fade-leave-to { opacity: 0; }.dialog-fade-enter-from .create-dialog, .dialog-fade-leave-to .create-dialog { transform: translateY(8px) scale(.985); }
@media (max-width: 480px) { .host-picker { grid-template-columns: 1fr; }.host-picker select { width: 100%; } }
</style>

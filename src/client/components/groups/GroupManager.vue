<script setup lang="ts">
import { reactive, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiAgent, UiRoom } from './types'

const props = defineProps<{
  room: UiRoom
  agents: UiAgent[]
  availableProfiles?: string[]
  busy?: boolean
}>()

const emit = defineEmits<{
  updateRoom: [patch: Partial<UiRoom>]
  addAgent: [profile: string]
  updateAgent: [id: string, patch: Partial<UiAgent>]
  removeAgent: [id: string]
  interruptAgent: [id: string]
  archiveRoom: []
  close: []
}>()

const form = reactive({ name: props.room.name, description: props.room.description || '', autoReply: props.room.autoReply ?? true, replyRounds: props.room.replyRounds ?? 3 })

watch(() => props.room, room => {
  form.name = room.name
  form.description = room.description || ''
  form.autoReply = room.autoReply ?? true
  form.replyRounds = room.replyRounds ?? 3
}, { deep: true })

function save() {
  emit('updateRoom', {
    name: form.name.trim() || props.room.name,
    description: form.description.trim(),
    autoReply: form.autoReply,
    replyRounds: Math.min(12, Math.max(1, Number(form.replyRounds) || 1)),
  })
}
</script>

<template>
  <div class="group-manager">
    <header>
      <span><small>群聊管理</small><strong>{{ room.name }}</strong></span>
      <button class="icon-button" type="button" aria-label="关闭群聊管理" @click="emit('close')"><AppIcon name="close" /></button>
    </header>

    <section>
      <h3>房间</h3>
      <label><span>名称</span><input v-model="form.name" maxlength="80" @change="save" /></label>
      <label><span>说明</span><textarea v-model="form.description" rows="2" maxlength="240" @change="save" /></label>
      <div class="setting-row">
        <span><strong>自动回复</strong><small>Agent 根据新消息自动协作</small></span>
        <button class="switch" :class="{ active: form.autoReply }" type="button" role="switch" :aria-checked="form.autoReply" @click="form.autoReply = !form.autoReply; save()"><i /></button>
      </div>
      <label class="rounds"><span>最多回复轮数</span><input v-model.number="form.replyRounds" type="number" min="1" max="12" @change="save" /></label>
    </section>

    <section>
      <div class="section-heading"><h3>成员 <em>{{ agents.length }}/8</em></h3></div>
      <div class="agent-list">
        <article v-for="agent in agents" :key="agent.id">
          <span class="agent-avatar">{{ agent.name.slice(0, 1).toUpperCase() }}<i :class="`status-${agent.status || 'idle'}`" /></span>
          <span class="agent-copy"><strong>{{ agent.name }}</strong><small>{{ agent.profile || agent.id }} · {{ { idle: '空闲', working: '正在回复', offline: '离线', error: '异常' }[agent.status || 'idle'] }}</small></span>
          <button v-if="agent.status === 'working'" class="agent-action" type="button" title="中断" @click="emit('interruptAgent', agent.id)"><AppIcon name="stop" :size="13" /></button>
          <button class="agent-action danger" type="button" title="移除" :disabled="agents.length <= 1" @click="emit('removeAgent', agent.id)"><AppIcon name="trash" :size="14" /></button>
          <div class="agent-settings">
            <label><input type="checkbox" :checked="agent.enabled !== false" @change="emit('updateAgent', agent.id, { enabled: ($event.target as HTMLInputElement).checked })" />启用</label>
            <label><input type="checkbox" :checked="agent.autoReply !== false" @change="emit('updateAgent', agent.id, { autoReply: ($event.target as HTMLInputElement).checked })" />自动回复</label>
          </div>
        </article>
      </div>

      <div v-if="agents.length < 8 && availableProfiles?.length" class="add-agent">
        <select aria-label="选择要添加的 Agent" @change="($event.target as HTMLSelectElement).value && emit('addAgent', ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">添加 Agent…</option>
          <option v-for="profile in availableProfiles" :key="profile" :value="profile">{{ profile }}</option>
        </select>
      </div>
    </section>

    <section class="danger-zone">
      <div><strong>归档群聊</strong><p>归档后不再出现在活跃列表，历史消息仍会保留。</p></div>
      <button class="quiet-button" type="button" :disabled="busy" @click="emit('archiveRoom')"><AppIcon name="archive" :size="14" />归档</button>
    </section>
  </div>
</template>

<style scoped>
.group-manager { height: 100%; overflow-y: auto; padding: 0 17px 24px; }
header { display: flex; position: sticky; z-index: 3; top: 0; min-height: 62px; align-items: center; justify-content: space-between; background: var(--surface); }
header > span { display: flex; flex-direction: column; } header small { color: var(--text-muted); font-size: 9px; } header strong { margin-top: 2px; font-size: 13px; font-weight: 620; }
section { padding: 17px 0; border-top: 1px solid var(--line); } section:first-of-type { border-top: 0; }
h3 { margin: 0 0 13px; color: var(--text-secondary); font-size: 10px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; } h3 em { color: var(--text-muted); font-style: normal; font-weight: 500; }
label { display: flex; flex-direction: column; gap: 5px; margin: 0 0 11px; color: var(--text-muted); font-size: 10px; }
input, textarea, select { width: 100%; padding: 8px 9px; border: 1px solid var(--line); border-radius: 9px; outline: 0; resize: vertical; background: var(--surface-soft); color: var(--text-primary); font-size: 11px; } input:focus, textarea:focus, select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 13px 0; }.setting-row > span { display: flex; flex-direction: column; }.setting-row strong { font-size: 11px; }.setting-row small { margin-top: 2px; color: var(--text-muted); font-size: 9px; }
.switch { position: relative; width: 34px; height: 20px; padding: 0; border: 0; border-radius: 999px; background: var(--surface-hover); cursor: pointer; }.switch i { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform 140ms ease, background 140ms ease; }.switch.active { background: var(--accent); }.switch.active i { background: var(--text-on-solid); transform: translateX(14px); }
.rounds { flex-direction: row; align-items: center; justify-content: space-between; }.rounds input { width: 62px; text-align: center; }
.agent-list { display: flex; flex-direction: column; gap: 6px; }.agent-list article { display: grid; grid-template-columns: 32px minmax(0,1fr) 28px 28px; align-items: center; gap: 7px; padding: 8px; border-radius: 10px; background: var(--surface-soft); }
.agent-avatar { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font-size: 10px; font-weight: 700; }.agent-avatar i { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border: 2px solid var(--surface-soft); border-radius: 50%; background: var(--text-muted); }.agent-avatar .status-working { background: var(--warning); }.agent-avatar .status-idle { background: var(--success); }.agent-avatar .status-error { background: var(--danger); }
.agent-copy { display: flex; min-width: 0; flex-direction: column; }.agent-copy strong, .agent-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.agent-copy strong { font-size: 11px; }.agent-copy small { margin-top: 2px; color: var(--text-muted); font-size: 9px; }
.agent-action { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }.agent-action:hover { background: var(--surface-hover); color: var(--text-primary); }.agent-action.danger:hover { color: var(--danger); }.agent-action:disabled { cursor: not-allowed; opacity: .25; }
.agent-settings { display: flex; grid-column: 2 / -1; align-items: center; gap: 15px; padding-top: 2px; }.agent-settings label { display: flex; flex-direction: row; align-items: center; gap: 5px; margin: 0; }.agent-settings input { width: auto; margin: 0; accent-color: var(--accent); }
.add-agent { margin-top: 8px; }.add-agent select { cursor: pointer; }
.danger-zone { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.danger-zone strong { font-size: 11px; }.danger-zone p { margin: 3px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.5; }.danger-zone .quiet-button { display: flex; flex: 0 0 auto; gap: 6px; color: var(--danger); font-size: 10px; }
</style>

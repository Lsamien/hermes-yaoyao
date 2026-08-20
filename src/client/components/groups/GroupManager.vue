<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { GroupAgent, ModelOption } from '@shared/types'
import AppIcon from '@/components/common/AppIcon.vue'
import type { UiRoom } from './types'

type AgentSettingsPatch = Partial<Pick<GroupAgent,
  'displayName' | 'description' | 'enabled' | 'replyWithoutMention' | 'model' | 'provider' | 'reasoningEffort' | 'fastMode'>>

type FastModeDraft = '' | 'true' | 'false'

interface AgentDraft {
  displayName: string
  description: string
  enabled: boolean
  replyWithoutMention: boolean
  modelKey: string
  reasoningEffort: string
  fastMode: FastModeDraft
}

const REASONING_OPTIONS = [
  { value: '', label: '跟随 Profile 默认' },
  { value: 'none', label: '关闭' },
  { value: 'minimal', label: '最小' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
  { value: 'ultra', label: 'Ultra' },
]

const props = defineProps<{
  room: UiRoom
  agents: GroupAgent[]
  availableProfiles?: string[]
  modelOptionsByProfile?: Record<string, ModelOption[]>
  modelOptionsLoading?: Record<string, boolean>
  modelOptionsError?: Record<string, string>
  agentUpdateError?: Record<string, string>
  busy?: boolean
}>()

const emit = defineEmits<{
  updateRoom: [patch: Partial<UiRoom>]
  addAgent: [profile: string]
  loadModels: [profile: string]
  clearAgentError: [id: string]
  updateAgent: [id: string, patch: AgentSettingsPatch]
  removeAgent: [id: string]
  interruptAgent: [id: string]
  archiveRoom: []
}>()

const form = reactive({ name: props.room.name, replyRounds: props.room.replyRounds ?? 3 })
const expandedAgentId = ref('')
const agentDrafts = reactive<Record<string, AgentDraft>>({})
const dirtyAgents = reactive(new Set<string>())

function modelKey(provider?: string | null, model?: string | null): string {
  return provider && model ? JSON.stringify([provider, model]) : ''
}

function parseModelKey(value: string): { provider: string; model: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string' && item.trim())) {
      return { provider: parsed[0]!, model: parsed[1]! }
    }
  } catch { /* malformed select values fall back to the Profile default */ }
  return null
}

function draftFrom(agent: GroupAgent): AgentDraft {
  return {
    displayName: agent.displayName,
    description: agent.description,
    enabled: agent.enabled,
    replyWithoutMention: agent.replyWithoutMention,
    modelKey: modelKey(agent.provider, agent.model),
    reasoningEffort: agent.reasoningEffort ?? '',
    fastMode: agent.fastMode == null ? '' : agent.fastMode ? 'true' : 'false',
  }
}

watch(() => props.room, room => {
  form.name = room.name
  form.replyRounds = room.replyRounds ?? 3
}, { deep: true })

watch(() => props.agents, agents => {
  const ids = new Set(agents.map(agent => agent.id))
  for (const id of Object.keys(agentDrafts)) if (!ids.has(id)) delete agentDrafts[id]
  for (const agent of agents) {
    if (!agentDrafts[agent.id] || !dirtyAgents.has(agent.id)) {
      agentDrafts[agent.id] = draftFrom(agent)
    } else if (!Object.keys(agentPatch(agent)).length) {
      dirtyAgents.delete(agent.id)
      agentDrafts[agent.id] = draftFrom(agent)
    }
  }
}, { deep: true, immediate: true })

function saveRoom() {
  emit('updateRoom', {
    name: form.name.trim() || props.room.name,
    replyRounds: Math.min(12, Math.max(1, Number(form.replyRounds) || 1)),
  })
}

function toggleAgent(agent: GroupAgent) {
  if (expandedAgentId.value === agent.id) {
    expandedAgentId.value = ''
    return
  }
  expandedAgentId.value = agent.id
  if (!dirtyAgents.has(agent.id)) agentDrafts[agent.id] = draftFrom(agent)
  emit('loadModels', agent.profile)
}

function markDirty(agentId: string) {
  dirtyAgents.add(agentId)
  emit('clearAgentError', agentId)
}

function resetAgent(agent: GroupAgent) {
  agentDrafts[agent.id] = draftFrom(agent)
  dirtyAgents.delete(agent.id)
  emit('clearAgentError', agent.id)
}

function modelOptionsFor(agent: GroupAgent): ModelOption[] {
  const options = props.modelOptionsByProfile?.[agent.profile] ?? []
  if (!agent.model || !agent.provider || options.some(option => option.id === agent.model && option.provider === agent.provider)) return options
  return [{ id: agent.model, name: agent.model, provider: agent.provider }, ...options]
}

function fastModeValue(value: FastModeDraft): boolean | null {
  return value === '' ? null : value === 'true'
}

function agentPatch(agent: GroupAgent): AgentSettingsPatch {
  const draft = agentDrafts[agent.id]
  if (!draft) return {}
  const patch: AgentSettingsPatch = {}
  const displayName = draft.displayName.trim()
  const description = draft.description.trim()
  if (displayName !== agent.displayName) patch.displayName = displayName
  if (description !== agent.description) patch.description = description
  if (draft.enabled !== agent.enabled) patch.enabled = draft.enabled
  if (draft.replyWithoutMention !== agent.replyWithoutMention) patch.replyWithoutMention = draft.replyWithoutMention
  if (draft.modelKey !== modelKey(agent.provider, agent.model)) {
    const selected = parseModelKey(draft.modelKey)
    patch.model = selected?.model ?? null
    patch.provider = selected?.provider ?? null
  }
  if (draft.reasoningEffort !== (agent.reasoningEffort ?? '')) patch.reasoningEffort = draft.reasoningEffort || null
  const nextFastMode = fastModeValue(draft.fastMode)
  if (nextFastMode !== (agent.fastMode ?? null)) patch.fastMode = nextFastMode
  return patch
}

function hasAgentChanges(agent: GroupAgent): boolean {
  return Object.keys(agentPatch(agent)).length > 0
}

function saveAgent(agent: GroupAgent) {
  const patch = agentPatch(agent)
  if (!Object.keys(patch).length) return
  emit('updateAgent', agent.id, patch)
}

function statusLabel(status: GroupAgent['status']): string {
  return { idle: '空闲', queued: '等待中', running: '正在回复', awaiting_input: '等待输入', unknown: '离线' }[status]
}
</script>

<template>
  <div class="group-manager">
    <header>
      <span><small>群聊管理</small><strong>{{ room.name }}</strong></span>
    </header>

    <section>
      <h3>房间</h3>
      <label><span>名称</span><input v-model="form.name" maxlength="80" @change="saveRoom" /></label>
      <label class="rounds"><span>最多回复轮数</span><input v-model.number="form.replyRounds" type="number" min="1" max="12" @change="saveRoom" /></label>
    </section>

    <section>
      <div class="section-heading"><h3>成员 <em>{{ agents.length }}/8</em></h3></div>
      <div class="agent-list">
        <article v-for="agent in agents" :key="agent.id" :class="{ expanded: expandedAgentId === agent.id }">
          <span class="agent-avatar">{{ agent.displayName.slice(0, 1).toUpperCase() }}<i :class="`status-${agent.status}`" /></span>
          <span class="agent-copy"><strong>{{ agent.displayName }}</strong><small>{{ agent.profile }} · {{ statusLabel(agent.status) }}</small></span>
          <button class="agent-action" type="button" :title="`设置 ${agent.displayName}`" :aria-label="`设置${agent.displayName}`" @click="toggleAgent(agent)"><AppIcon name="settings" :size="14" /></button>
          <button v-if="agent.status === 'running' || agent.status === 'queued'" class="agent-action" type="button" title="中断" @click="emit('interruptAgent', agent.id)"><AppIcon name="stop" :size="13" /></button>
          <button class="agent-action danger" type="button" title="移除" :disabled="agents.length <= 1" @click="emit('removeAgent', agent.id)"><AppIcon name="trash" :size="14" /></button>

          <fieldset v-if="expandedAgentId === agent.id && agentDrafts[agent.id]" class="agent-editor" :aria-label="`${agent.displayName} Agent 设置`">
            <legend>Agent 设置</legend>
            <div class="editor-grid">
              <label><span>显示名称</span><input v-model="agentDrafts[agent.id].displayName" maxlength="100" aria-label="显示名称" @input="markDirty(agent.id)" /></label>
              <label><span>职责说明</span><textarea v-model="agentDrafts[agent.id].description" rows="2" maxlength="500" aria-label="职责说明" @input="markDirty(agent.id)" /></label>
              <label>
                <span>模型</span>
                <select v-model="agentDrafts[agent.id].modelKey" aria-label="模型" @focus="emit('loadModels', agent.profile)" @change="markDirty(agent.id)">
                  <option value="">跟随 Profile 默认</option>
                  <option v-for="option in modelOptionsFor(agent)" :key="modelKey(option.provider, option.id)" :value="modelKey(option.provider, option.id)">{{ option.name }} · {{ option.provider }}</option>
                </select>
                <small v-if="modelOptionsLoading?.[agent.profile]" class="editor-note">正在加载模型选项…</small>
                <small v-else-if="modelOptionsError?.[agent.profile]" class="editor-note error">{{ modelOptionsError[agent.profile] }}</small>
              </label>
              <label>
                <span>推理强度</span>
                <select v-model="agentDrafts[agent.id].reasoningEffort" aria-label="推理强度" @change="markDirty(agent.id)">
                  <option v-for="option in REASONING_OPTIONS" :key="option.value || 'default'" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <label>
                <span>快速模式</span>
                <select v-model="agentDrafts[agent.id].fastMode" aria-label="快速模式" @change="markDirty(agent.id)">
                  <option value="">跟随 Profile 默认</option>
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </label>
            </div>
            <div class="editor-toggles">
              <label><input v-model="agentDrafts[agent.id].enabled" type="checkbox" aria-label="启用" @change="markDirty(agent.id)" />启用</label>
              <label><input v-model="agentDrafts[agent.id].replyWithoutMention" type="checkbox" aria-label="自动回复" @change="markDirty(agent.id)" />自动回复</label>
            </div>
            <p v-if="agentUpdateError?.[agent.id]" class="agent-save-error" role="alert">{{ agentUpdateError[agent.id] }}</p>
            <div class="editor-actions">
              <button class="quiet-button" type="button" :disabled="busy || !hasAgentChanges(agent)" @click="resetAgent(agent)">取消更改</button>
              <button class="save-agent" type="button" :disabled="busy || !hasAgentChanges(agent)" @click="saveAgent(agent)">保存 Agent 设置</button>
            </div>
          </fieldset>
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
header { display: flex; position: sticky; z-index: 3; top: 0; min-height: 62px; align-items: center; justify-content: space-between; padding-right: 40px; background: var(--surface); }
header > span { display: flex; flex-direction: column; } header small { color: var(--text-muted); font-size: 9px; } header strong { margin-top: 2px; font-size: 13px; font-weight: 620; }
section { padding: 17px 0; border-top: 1px solid var(--line); } section:first-of-type { border-top: 0; }
h3 { margin: 0 0 13px; color: var(--text-secondary); font-size: 10px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; } h3 em { color: var(--text-muted); font-style: normal; font-weight: 500; }
label { display: flex; flex-direction: column; gap: 5px; margin: 0 0 11px; color: var(--text-muted); font-size: 10px; }
input, textarea, select { width: 100%; padding: 8px 9px; border: 1px solid var(--line); border-radius: 9px; outline: 0; resize: vertical; background: var(--surface-soft); color: var(--text-primary); font-size: 11px; } input:focus, textarea:focus, select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.rounds { flex-direction: row; align-items: center; justify-content: space-between; }.rounds input { width: 62px; text-align: center; }
.agent-list { display: flex; flex-direction: column; gap: 7px; }.agent-list article { display: grid; grid-template-columns: 32px minmax(0,1fr) repeat(3, 28px); align-items: center; gap: 7px; padding: 8px; border: 1px solid transparent; border-radius: 10px; background: var(--surface-soft); }.agent-list article.expanded { border-color: var(--line); background: var(--surface); }
.agent-avatar { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent); color: var(--text-on-solid); font-size: 10px; font-weight: 700; }.agent-avatar i { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border: 2px solid var(--surface-soft); border-radius: 50%; background: var(--text-muted); }.agent-avatar .status-running, .agent-avatar .status-queued { background: var(--warning); }.agent-avatar .status-idle { background: var(--success); }.agent-avatar .status-awaiting_input { background: var(--warning); }
.agent-copy { display: flex; min-width: 0; flex-direction: column; }.agent-copy strong, .agent-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.agent-copy strong { font-size: 11px; }.agent-copy small { margin-top: 2px; color: var(--text-muted); font-size: 9px; }
.agent-action { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }.agent-action:hover { background: var(--surface-hover); color: var(--text-primary); }.agent-action.danger:hover { color: var(--danger); }.agent-action:disabled { cursor: not-allowed; opacity: .25; }
.agent-editor { display: block; grid-column: 1 / -1; min-width: 0; margin: 4px 0 0; padding: 12px 0 2px; border: 0; border-top: 1px solid var(--line); }.agent-editor legend { padding: 0 0 10px; color: var(--text-secondary); font-size: 10px; font-weight: 650; }.editor-grid { display: grid; gap: 0; }.editor-grid label:last-child { margin-bottom: 7px; }.editor-note { margin: -1px 2px 0; color: var(--text-muted); font-size: 9px; }.editor-note.error { color: var(--danger); }
.editor-toggles { display: flex; align-items: center; gap: 16px; padding: 3px 0 12px; }.editor-toggles label { display: flex; flex-direction: row; align-items: center; gap: 5px; margin: 0; color: var(--text-secondary); }.editor-toggles input { width: auto; margin: 0; accent-color: var(--accent); }
.agent-save-error { margin: 0 0 10px; color: var(--danger); font-size: 9px; line-height: 1.45; }
.editor-actions { display: flex; justify-content: flex-end; gap: 7px; }.editor-actions button { min-height: 30px; padding: 0 10px; border-radius: 8px; cursor: pointer; font-size: 10px; }.editor-actions button:disabled { cursor: not-allowed; opacity: .35; }.save-agent { border: 1px solid var(--accent); background: var(--accent); color: var(--text-on-solid); }
.add-agent { margin-top: 8px; }.add-agent select { cursor: pointer; }
.danger-zone { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.danger-zone strong { font-size: 11px; }.danger-zone p { margin: 3px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.5; }.danger-zone .quiet-button { display: flex; flex: 0 0 auto; gap: 6px; color: var(--danger); font-size: 10px; }
</style>

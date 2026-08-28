<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { getDuplexVoiceSettings, saveDuplexVoiceSettings, type DuplexVoice } from '@/api/agentManagement'

const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const hasApiKey = ref(false)
const apiKey = ref('')
const voices = ref<DuplexVoice[]>([])
const currentVoiceId = ref('')

async function load() {
  loading.value = true; error.value = ''
  try {
    const settings = await getDuplexVoiceSettings()
    hasApiKey.value = settings.hasApiKey
    voices.value = settings.voices.map(voice => ({ ...voice }))
    currentVoiceId.value = settings.currentVoiceId
    apiKey.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '双流语音设置加载失败'
  } finally {
    loading.value = false
  }
}

function addVoice() {
  let suffix = voices.value.length + 1
  while (voices.value.some(voice => voice.id === `voice-${suffix}`)) suffix += 1
  voices.value.push({ id: `voice-${suffix}`, name: `新音色 ${suffix}` })
  if (!currentVoiceId.value) currentVoiceId.value = voices.value[0]!.id
}

function removeVoice(index: number) {
  if (voices.value.length <= 1) { error.value = '至少保留一个音色'; return }
  const [removed] = voices.value.splice(index, 1)
  if (removed?.id === currentVoiceId.value) currentVoiceId.value = voices.value[0]!.id
}

function validate(): string {
  if (!voices.value.length) return '至少保留一个音色'
  const ids = new Set<string>()
  for (const voice of voices.value) {
    voice.id = voice.id.trim(); voice.name = voice.name.trim()
    if (!voice.id || !voice.name) return '音色 ID 和名称不能为空'
    if (voice.id.length > 200 || voice.name.length > 200) return '音色 ID 和名称不能超过 200 个字符'
    if (ids.has(voice.id)) return `音色 ID 重复：${voice.id}`
    ids.add(voice.id)
  }
  if (!ids.has(currentVoiceId.value)) currentVoiceId.value = voices.value[0]!.id
  return ''
}

async function save() {
  const validationError = validate()
  if (validationError) { error.value = validationError; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await saveDuplexVoiceSettings({
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
      voices: voices.value,
      currentVoiceId: currentVoiceId.value,
    })
    hasApiKey.value = result.hasApiKey
    voices.value = result.voices.map(voice => ({ ...voice }))
    currentVoiceId.value = result.currentVoiceId
    apiKey.value = ''
    notice.value = '双流语音设置已保存，iOS 可直接同步使用'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '双流语音设置保存失败'
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="voice-panel" aria-label="双流语音">
    <div class="voice-heading"><div><h3>yaoyao 双流语音</h3><p>这是整个 yaoyao 安装共享的全局设置，不随当前 Agent 切换。</p></div><span>全局</span></div>
    <p v-if="error" class="voice-error" role="alert">{{ error }}</p><p v-else-if="notice" class="voice-notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="voice-empty">正在读取 yaoyao 插件设置…</p>
    <form v-else @submit.prevent="save">
      <label>API Key<input v-model="apiKey" type="password" :placeholder="hasApiKey ? '已保存；留空保持不变' : '输入双流语音 API Key'" autocomplete="new-password" /></label>
      <div class="voice-list-heading"><strong>音色列表</strong><button type="button" :disabled="busy || voices.length >= 100" @click="addVoice"><AppIcon name="plus" :size="13" />增加音色</button></div>
      <div class="voice-list">
        <div v-for="(voice, index) in voices" :key="index" class="voice-row">
          <label>音色 ID<input v-model="voice.id" maxlength="200" autocomplete="off" /></label><label>显示名称<input v-model="voice.name" maxlength="200" autocomplete="off" /></label><button class="remove-button" type="button" aria-label="删除音色" :disabled="busy || voices.length <= 1" @click="removeVoice(index)"><AppIcon name="trash" :size="14" /></button>
        </div>
      </div>
      <label>当前音色<select v-model="currentVoiceId"><option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.name || voice.id }}</option></select></label>
      <footer><button class="primary-button" type="submit" :disabled="busy || !voices.length">{{ busy ? '正在保存…' : '保存双流语音设置' }}</button></footer>
    </form>
  </section>
</template>

<style scoped>
.voice-panel{display:grid;gap:12px}.voice-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.voice-heading h3{margin:0;font-size:13px}.voice-heading p{margin:4px 0 0;color:var(--text-muted);font-size:9px}.voice-heading>span{padding:3px 7px;border-radius:999px;background:var(--surface-hover);color:var(--text-muted);font-size:8px}.voice-error,.voice-notice,.voice-empty{margin:0;padding:9px 10px;border-radius:8px;font-size:10px}.voice-error{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger)}.voice-notice{background:color-mix(in srgb,var(--success,#21845b) 9%,transparent);color:var(--success,#21845b)}.voice-empty{color:var(--text-muted);background:var(--surface-soft)}form{display:grid;gap:12px}label{display:grid;gap:5px;color:var(--text-secondary);font-size:9px;font-weight:650}input,select{width:100%;height:36px;box-sizing:border-box;padding:0 9px;border:1px solid var(--line);border-radius:8px;outline:0;background:var(--surface-soft);color:var(--text-primary);font:10px var(--font-ui)}.voice-list-heading{display:flex;align-items:center;justify-content:space-between}.voice-list-heading strong{font-size:10px}.voice-list-heading button,.primary-button{display:inline-flex;min-height:31px;align-items:center;justify-content:center;gap:5px;padding:0 9px;border:0;border-radius:7px;cursor:pointer;font-size:9px}.voice-list-heading button{background:var(--surface-hover);color:var(--text-secondary)}.primary-button{background:var(--accent);color:var(--text-on-solid)}button:disabled{cursor:wait;opacity:.5}.voice-list{display:grid;gap:7px}.voice-row{display:grid;grid-template-columns:1fr 1fr 32px;align-items:end;gap:7px}.remove-button{display:grid;width:32px;height:36px;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--danger);cursor:pointer}footer{display:flex;justify-content:flex-end;padding-top:3px}@media(max-width:600px){.voice-row{grid-template-columns:1fr 32px}.voice-row label:first-child{grid-column:1/-1}.voice-row label:nth-child(2){grid-column:1}.remove-button{grid-column:2}}
</style>

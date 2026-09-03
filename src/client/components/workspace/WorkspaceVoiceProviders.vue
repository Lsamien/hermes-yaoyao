<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { apiRequest } from '@/api/client'
const kind = ref<'tts' | 'stt'>('tts'),
  provider = ref('openai'),
  active = ref(''),
  rows = ref<
    Array<{ provider: string; settings: Record<string, unknown>; secrets: Record<string, string> }>
  >([])
const baseUrl = ref(''),
  model = ref(''),
  voice = ref(''),
  apiKey = ref(''),
  error = ref(''),
  notice = ref(''),
  busy = ref(false)
async function load() {
  const r = await apiRequest<{ activeProvider: string; settings: typeof rows.value }>(
    `/api/app/${kind.value}/settings`,
  )
  rows.value = r.settings
  active.value = r.activeProvider
  fill()
}
function fill() {
  const r = rows.value.find((r) => r.provider === provider.value)
  baseUrl.value = String(r?.settings.baseUrl ?? '')
  model.value = String(r?.settings.model ?? '')
  voice.value = String(r?.settings.voice ?? '')
  apiKey.value = ''
}
async function save() {
  busy.value = true
  error.value = ''
  try {
    await apiRequest(`/api/app/${kind.value}/settings/${encodeURIComponent(provider.value)}`, {
      method: 'PUT',
      body: {
        settings: { baseUrl: baseUrl.value, model: model.value, voice: voice.value },
        secrets: apiKey.value ? { apiKey: apiKey.value } : {},
        activeProvider: provider.value,
      },
    })
    await load()
    notice.value = '配置已保存'
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}
async function probe() {
  busy.value = true
  try {
    const r = await apiRequest<{ ok: boolean; models: string[]; errorSummary?: string }>(
      '/api/app/voice/probe',
      {
        method: 'POST',
        body: {
          kind: kind.value,
          provider: provider.value,
          baseUrl: baseUrl.value,
          ...(apiKey.value ? { apiKey: apiKey.value } : {}),
          compatibility: 'openai-compatible',
        },
      },
    )
    notice.value = r.ok
      ? `连接成功，可用模型：${r.models.slice(0, 8).join('、')}`
      : (r.errorSummary ?? '连接失败')
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}
async function remove() {
  try {
    await apiRequest(`/api/app/${kind.value}/settings/${encodeURIComponent(provider.value)}`, {
      method: 'DELETE',
    })
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
watch(kind, () => void load().catch((e) => (error.value = String(e))))
watch(provider, fill)
onMounted(() => void load().catch((e) => (error.value = String(e))))
</script>
<template>
  <section class="voice-providers">
    <h3>语音服务商</h3>
    <p>当前启用：{{ active || '未配置' }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form @submit.prevent="save">
      <label
        >用途<select v-model="kind">
          <option value="tts">语音合成 TTS</option>
          <option value="stt">语音识别 STT</option>
        </select></label
      ><label
        >服务商<select v-model="provider">
          <option
            v-for="p in kind === 'tts'
              ? ['edge', 'openai', 'custom', 'mimo', 'doubao']
              : ['openai', 'custom', 'doubao']"
            :key="p"
          >
            {{ p }}
          </option>
        </select></label
      ><label>服务地址<input v-model="baseUrl" type="url" /></label
      ><label>模型<input v-model="model" /></label
      ><label v-if="kind === 'tts'">音色<input v-model="voice" /></label
      ><label
        >API Key<input
          v-model="apiKey"
          type="password"
          placeholder="留空保留已保存密钥"
          autocomplete="new-password"
      /></label>
      <div>
        <button :disabled="busy">保存并启用</button
        ><button type="button" :disabled="busy || !baseUrl" @click="probe">测试连接</button
        ><button type="button" :disabled="busy" @click="remove">删除配置</button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.voice-providers {
  padding: 20px 0;
  border-top: 1px solid var(--line);
  margin-top: 22px;
}
form {
  display: grid;
  gap: 14px;
}
label {
  display: grid;
  gap: 7px;
  font-size: 13px;
}
input,
select,
button {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--text-primary);
  background: var(--surface-soft);
}
button {
  margin-right: 8px;
  cursor: pointer;
}
p {
  font-size: 12px;
  color: var(--text-muted);
}
[role='alert'] {
  color: var(--danger, #b44);
}
</style>

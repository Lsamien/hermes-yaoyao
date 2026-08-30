<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { listModelCatalog } from '@/api/agentManagement'

const props = withDefaults(defineProps<{
  profile: Profile
  busy?: boolean
  error?: string
  formId?: string
  showActions?: boolean
  resetVersion?: number
  defaultModelLabel?: string
}>(), {
  busy: false,
  error: '',
  formId: undefined,
  showActions: true,
  resetVersion: 0,
  defaultModelLabel: '',
})
const emit = defineEmits<{
  save: [input: { title: string; avatarDataURL?: string | null }]
  'dirty-change': [dirty: boolean]
}>()

const title = ref('')
const avatarDataURL = ref<string | null>(null)
const avatarTouched = ref(false)
const localError = ref('')
const fileInput = ref<HTMLInputElement>()
const baseline = ref<{ title: string; avatarDataURL: string | null }>({ title: '', avatarDataURL: null })
const resolvedDefaultModelLabel = ref('')
let profileGeneration = 0
let modelLoadGeneration = 0

function resetFromProfile() {
  profileGeneration += 1
  const profile = props.profile
  const nextTitle = profile.agentName || profile.displayName || profile.name || ''
  const nextAvatarDataURL = profile.agentAvatar || null
  title.value = nextTitle
  avatarDataURL.value = nextAvatarDataURL
  baseline.value = { title: nextTitle, avatarDataURL: nextAvatarDataURL }
  avatarTouched.value = false
  localError.value = ''
}

watch([() => props.profile.name, () => props.resetVersion], resetFromProfile, { immediate: true })
watch([() => props.profile.name, () => props.defaultModelLabel], async () => {
  const generation = ++modelLoadGeneration
  const fallback = props.defaultModelLabel
    || [props.profile.provider, props.profile.model].filter(Boolean).join(' / ')
  resolvedDefaultModelLabel.value = fallback
  try {
    const current = (await listModelCatalog(props.profile.name))
      .find(provider => provider.isCurrent && provider.currentModel)
    if (generation === modelLoadGeneration && current?.currentModel) {
      resolvedDefaultModelLabel.value = `${current.slug} / ${current.currentModel}`
    }
  } catch { /* Keep the Profile payload as a read-only fallback. */ }
}, { immediate: true })

const dirty = computed(() => title.value !== baseline.value.title || avatarDataURL.value !== baseline.value.avatarDataURL)
watch(dirty, value => emit('dirty-change', value), { immediate: true })

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

function resizeImage(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const edge = Math.min(256, Math.max(image.width, image.height))
      const ratio = edge / Math.max(image.width, image.height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('当前浏览器不支持图片处理'))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('请选择有效的 PNG、JPEG 或 WebP 图片'))
    image.src = source
  })
}

async function chooseAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const generation = profileGeneration
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB')
    const nextAvatar = await resizeImage(await readImage(file))
    if (generation !== profileGeneration) return
    avatarDataURL.value = nextAvatar
    avatarTouched.value = true
    localError.value = ''
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : '处理头像失败'
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

function submit() {
  const normalized = title.value.trim().replace(/\s+/g, ' ')
  if (!normalized) { localError.value = '请输入 Agent 名称'; return }
  emit('save', { title: normalized, ...(avatarTouched.value ? { avatarDataURL: avatarDataURL.value } : {}) })
  title.value = normalized
}
</script>

<template>
  <form :id="formId" class="identity-form" @submit.prevent="submit">
    <div class="identity-avatar">
      <AgentAvatar :name="title || profile.name" :avatar="avatarDataURL || ''" :size="104" />
      <div>
        <strong>Bots 头像</strong>
        <small>会压缩为 256 px，并写入原生 Agent 头像；所有设备同步。</small>
        <p>
          <button class="quiet-button" type="button" :disabled="busy" @click="fileInput?.click()"><AppIcon name="image" :size="14" />选择图片</button>
          <button v-if="avatarDataURL" class="quiet-button" type="button" :disabled="busy" @click="avatarDataURL = null; avatarTouched = true">移除</button>
        </p>
      </div>
      <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="chooseAvatar" />
    </div>
    <label>名称<input v-model="title" :disabled="busy" maxlength="100" autocomplete="off" /></label>
    <div class="identity-default-model">
      <strong>默认全局模型</strong>
      <span>{{ resolvedDefaultModelLabel || '服务器未返回默认模型' }}</span>
      <small>仅影响之后新建的会话；已有会话保留自己的模型。</small>
    </div>
    <p v-if="localError || error" class="identity-error" role="alert">{{ localError || error }}</p>
    <footer v-if="showActions" class="identity-actions">
      <slot name="actions">
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在同步…' : '保存并同步' }}</button>
      </slot>
    </footer>
  </form>
</template>

<style scoped>
.identity-form{display:grid;max-width:720px}.identity-avatar{display:flex;align-items:flex-start;gap:24px;margin-bottom:32px;padding:0;background:transparent}.identity-avatar>div{display:grid;gap:7px;padding-top:4px}.identity-avatar strong{font-size:16px}.identity-avatar small{max-width:480px;color:var(--text-muted);font-size:13px;line-height:1.55}.identity-avatar p{display:flex;gap:8px;margin:6px 0 0}.identity-form label{display:grid;max-width:480px;gap:8px;color:var(--text-secondary);font-size:14px;font-weight:650}.identity-form input:not(.sr-only){width:100%;min-height:46px;box-sizing:border-box;padding:0 13px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:14px var(--font-ui);font-weight:400}.identity-form input:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}.quiet-button,.primary-button,.identity-actions :slotted(.quiet-button),.identity-actions :slotted(.primary-button){display:inline-flex;min-height:40px;align-items:center;justify-content:center;gap:7px;padding:0 14px;border:0;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}.quiet-button,.identity-actions :slotted(.quiet-button){border:1px solid var(--line);background:var(--surface-raised);color:var(--text-secondary)}.primary-button,.identity-actions :slotted(.primary-button){min-width:118px;background:var(--accent);color:var(--text-on-solid)}.quiet-button:disabled,.primary-button:disabled,.identity-actions :slotted(.quiet-button:disabled),.identity-actions :slotted(.primary-button:disabled){cursor:wait;opacity:.5}.identity-error{margin:14px 0 0;color:var(--danger);font-size:13px}.identity-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:30px;padding-top:18px;border-top:1px solid var(--line)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:600px){.identity-avatar{align-items:flex-start;flex-direction:column}.identity-form label{max-width:none}}
.identity-default-model{display:grid;max-width:480px;gap:5px;margin-top:20px;padding:13px;border:1px solid var(--line);border-radius:9px;background:var(--surface-soft)}
.identity-default-model strong{color:var(--text-secondary);font-size:13px}.identity-default-model span{font:12px var(--font-code);overflow-wrap:anywhere}.identity-default-model small{color:var(--text-muted);font-size:11px}
</style>

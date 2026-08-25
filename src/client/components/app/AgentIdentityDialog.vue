<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AppIcon from '@/components/common/AppIcon.vue'

const props = defineProps<{ open: boolean; profile?: Profile; busy?: boolean; error?: string }>()
const emit = defineEmits<{
  close: []
  save: [input: { title: string; avatarDataURL?: string | null }]
}>()

const title = ref('')
const avatarDataURL = ref<string | null>(null)
const avatarTouched = ref(false)
const localError = ref('')
const fileInput = ref<HTMLInputElement>()

watch(() => [props.open, props.profile] as const, () => {
  if (!props.open) return
  title.value = props.profile?.agentName || props.profile?.displayName || props.profile?.name || ''
  avatarDataURL.value = props.profile?.agentAvatar || null
  avatarTouched.value = false
  localError.value = ''
}, { immediate: true })

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
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB')
    avatarDataURL.value = await resizeImage(await readImage(file))
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
  if (!normalized) {
    localError.value = '请输入 Agent 名称'
    return
  }
  emit('save', { title: normalized, ...(avatarTouched.value ? { avatarDataURL: avatarDataURL.value } : {}) })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="identity-fade">
      <div v-if="open && profile" class="identity-layer" @mousedown.self="emit('close')">
        <form class="identity-dialog" @submit.prevent="submit">
          <header><div><small>AGENT 身份</small><h2>编辑 {{ profile.name }}</h2></div><button class="icon-button" type="button" aria-label="关闭" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></header>
          <div class="identity-avatar"><AgentAvatar :name="title || profile.name" :avatar="avatarDataURL || ''" :size="76" /><div><strong>Desktop Bots 头像</strong><small>会压缩为 256 px，并写入 Desktop 原生 Agent 头像；所有设备同步。</small><p><button class="quiet-button" type="button" :disabled="busy" @click="fileInput?.click()"><AppIcon name="image" :size="14" />选择图片</button><button v-if="avatarDataURL" class="quiet-button" type="button" :disabled="busy" @click="avatarDataURL = null; avatarTouched = true">移除</button></p></div><input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="chooseAvatar" /></div>
          <label>名称<input v-model="title" :disabled="busy" maxlength="100" autocomplete="off" /></label>
          <p v-if="localError || error" class="identity-error" role="alert">{{ localError || error }}</p>
          <footer><button class="quiet-button" type="button" :disabled="busy" @click="emit('close')">取消</button><button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在同步…' : '保存并同步' }}</button></footer>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.identity-layer { position: fixed; z-index: 230; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(4px); }.identity-dialog { width: min(430px, 100%); padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); box-shadow: var(--shadow-float); }.identity-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }.identity-dialog h2 { margin: 3px 0 0; font-size: 17px; }.identity-dialog header small { color: var(--text-muted); font-size: 9px; letter-spacing: .08em; }.identity-avatar { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; padding: 11px; border-radius: 12px; background: var(--surface-soft); }.identity-avatar > div { display: grid; gap: 4px; }.identity-avatar strong { font-size: 11px; }.identity-avatar small { color: var(--text-muted); font-size: 9px; line-height: 1.45; }.identity-avatar p { display: flex; gap: 5px; margin: 3px 0 0; }.identity-dialog label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 10px; font-weight: 650; }.identity-dialog input:not(.sr-only) { width: 100%; min-height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font: inherit; font-weight: 400; }.identity-dialog input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.quiet-button, .primary-button { display: inline-flex; min-height: 29px; align-items: center; justify-content: center; gap: 5px; padding: 0 9px; border: 0; border-radius: 7px; cursor: pointer; font-size: 10px; }.quiet-button { background: var(--surface-hover); color: var(--text-secondary); }.primary-button { background: var(--accent); color: var(--text-on-solid); }.quiet-button:disabled, .primary-button:disabled { cursor: wait; opacity: .5; }.identity-error { margin: 11px 0 0; color: var(--danger); font-size: 10px; }.identity-dialog footer { display: flex; justify-content: flex-end; gap: 7px; margin-top: 20px; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }.identity-fade-enter-active, .identity-fade-leave-active { transition: opacity 130ms ease; }.identity-fade-enter-from, .identity-fade-leave-to { opacity: 0; }
@media (max-width: 600px) { .identity-layer { place-items: end center; padding: 0; }.identity-dialog { width: 100%; border-radius: 17px 17px 0 0; padding-bottom: max(18px, env(safe-area-inset-bottom)); } }
</style>

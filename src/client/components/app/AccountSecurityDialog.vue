<script setup lang="ts">
import { ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const auth = useAuthStore()
const username = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')

async function save() {
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致'; return }
  busy.value = true; error.value = ''
  try {
    await auth.changeCredentials({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      username: auth.user?.role === 'admin' ? username.value.trim() : undefined,
    })
    emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '修改账号失败' }
  finally { busy.value = false }
}
watch(() => props.open, open => {
  if (open) { username.value = auth.user?.username || ''; currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; error.value = '' }
})
</script>

<template><Teleport to="body"><div v-if="open" class="layer" @mousedown.self="emit('close')"><section role="dialog" aria-modal="true" aria-label="账号安全"><header><h2>账号安全</h2><button class="icon-button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header><form @submit.prevent="save"><label v-if="auth.user?.role === 'admin'"><span>管理员用户名</span><input v-model="username" autocomplete="username" /></label><label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label><label><span>新密码</span><input v-model="newPassword" type="password" autocomplete="new-password" placeholder="至少 8 个字符" /></label><label><span>确认新密码</span><input v-model="confirmation" type="password" autocomplete="new-password" /></label><p v-if="error">{{ error }}</p><button class="solid-button" :disabled="busy || !currentPassword || newPassword.length < 8 || newPassword !== confirmation">{{ busy ? '正在保存…' : '保存修改' }}</button></form></section></div></Teleport></template>

<style scoped>.layer{position:fixed;z-index:285;inset:0;display:grid;place-items:center;padding:20px;background:var(--scrim);backdrop-filter:blur(6px)}section{width:min(420px,100%);padding:19px;border:1px solid var(--line);border-radius:18px;background:var(--surface-raised);box-shadow:var(--shadow-float)}header{display:flex;align-items:center;justify-content:space-between}h2{margin:0;font-size:18px}form{display:grid;gap:12px;margin-top:18px}label{display:grid;gap:5px;color:var(--text-secondary);font-size:10px}input{height:40px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface-soft);color:var(--text-primary)}p{margin:0;color:var(--danger);font-size:10px}.solid-button{min-height:41px}@media(max-width:520px){.layer{place-items:end center;padding:0}section{border-radius:18px 18px 0 0;padding-bottom:max(20px,env(safe-area-inset-bottom))}}</style>

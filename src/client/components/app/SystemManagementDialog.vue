<script setup lang="ts">
import { ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { createUser, deleteUser, listUsers, setUpstreamCredentials, updateUser, type ManagedUser } from '@/api/admin'

const props = defineProps<{ open: boolean; upstreamReady?: boolean; upstreamError?: string }>()
const emit = defineEmits<{ close: [] }>()
const users = ref<ManagedUser[]>([])
const username = ref('')
const password = ref('')
const upstreamUsername = ref('admin')
const upstreamPassword = ref('')
const busy = ref(false)
const error = ref('')

async function refresh() { users.value = await listUsers() }
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action(); await refresh() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { busy.value = false }
}
function add() { void run(async () => { await createUser(username.value.trim(), password.value); username.value = ''; password.value = '' }) }
function toggle(user: ManagedUser) { void run(async () => { await updateUser(user.id, { enabled: !user.enabled }) }) }
function reset(user: ManagedUser) {
  const value = window.prompt(`为“${user.username}”设置临时密码（至少 8 个字符）`)
  if (value) void run(async () => { await updateUser(user.id, { password: value }) })
}
function remove(user: ManagedUser) {
  if (window.confirm(`删除用户“${user.username}”？`)) void run(async () => { await deleteUser(user.id) })
}
async function saveUpstream() {
  await run(async () => { await setUpstreamCredentials(upstreamUsername.value.trim(), upstreamPassword.value); upstreamPassword.value = '' })
}
watch(() => props.open, open => { if (open) void refresh().catch(cause => { error.value = cause instanceof Error ? cause.message : '读取用户失败' }) })
</script>

<template>
  <Teleport to="body"><div v-if="open" class="layer" @mousedown.self="emit('close')"><section role="dialog" aria-modal="true" aria-label="系统管理">
    <header><div><small>ADMIN</small><h2>系统管理</h2></div><button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="block"><h3>用户</h3><div v-for="user in users" :key="user.id" class="user"><span><b>{{ user.username }}</b><small>{{ user.role === 'admin' ? '管理员' : user.enabled ? (user.mustChangePassword ? '等待修改临时密码' : '普通用户') : '已禁用' }}</small></span><template v-if="user.role !== 'admin'"><button @click="reset(user)">重置密码</button><button @click="toggle(user)">{{ user.enabled ? '禁用' : '启用' }}</button><button class="danger" @click="remove(user)">删除</button></template></div>
      <form @submit.prevent="add"><input v-model="username" placeholder="新用户名" autocomplete="off" /><input v-model="password" type="password" placeholder="临时密码（至少 8 位）" autocomplete="new-password" /><button class="solid-button" :disabled="busy || !username.trim() || password.length < 8">创建用户</button></form>
    </div>
    <div class="block"><h3>9119 服务账号</h3><p :class="{ ok: upstreamReady }">{{ upstreamReady ? '上游连接正常' : upstreamError || '尚未验证上游连接' }}</p><form @submit.prevent="saveUpstream"><input v-model="upstreamUsername" placeholder="9119 用户名" autocomplete="off" /><input v-model="upstreamPassword" type="password" placeholder="9119 密码" autocomplete="new-password" /><button class="solid-button" :disabled="busy || !upstreamUsername.trim() || !upstreamPassword">验证并保存</button></form></div>
  </section></div></Teleport>
</template>

<style scoped>
.layer { position: fixed; z-index: 280; inset: 0; display: grid; place-items: center; padding: 20px; background: var(--scrim); backdrop-filter: blur(6px); }.layer > section { width: min(620px, 100%); max-height: calc(100vh - 40px); overflow: auto; padding: 19px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface-raised); box-shadow: var(--shadow-float); }header { display: flex; justify-content: space-between; }header small { color: var(--text-muted); font-size: 9px; }h2 { margin: 3px 0 0; font-size: 19px; }.block { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }.block h3 { margin: 0 0 10px; font-size: 12px; }.block p { color: var(--danger); font-size: 10px; }.block p.ok { color: var(--success, #21845b); }.user { display: flex; min-height: 48px; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); }.user span { display: flex; min-width: 0; flex: 1; flex-direction: column; }.user b { font-size: 11px; }.user small { color: var(--text-muted); font-size: 9px; }.user button { border: 0; background: transparent; color: var(--text-secondary); font-size: 9px; cursor: pointer; }.user button.danger,.error { color: var(--danger); }form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin-top: 12px; }input { min-width: 0; height: 38px; padding: 0 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); color: var(--text-primary); }.solid-button { min-height: 38px; }@media(max-width:600px){.layer{place-items:end center;padding:0}.layer>section{max-height:calc(100vh - 12px);border-radius:18px 18px 0 0}form{grid-template-columns:1fr}.user{flex-wrap:wrap;padding:8px 0}.user span{flex-basis:100%}}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import AgentIdentityDialog from '@/components/app/AgentIdentityDialog.vue'
import { updateProfileIdentity } from '@/api/profiles'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

withDefaults(defineProps<{
  sidebarTitle: string
  sidebarSubtitle?: string
  sidebarContextTitle?: string
  sidebarFocusMode?: boolean
  inspectorOpen?: boolean
  inspectorCloseLabel?: string
}>(), { sidebarSubtitle: '', sidebarContextTitle: '', sidebarFocusMode: false, inspectorOpen: false, inspectorCloseLabel: '关闭预览' })

const emit = defineEmits<{ closeInspector: [] }>()
const auth = useAuthStore()
const theme = useThemeStore()

const userName = computed(() => auth.user?.displayName || auth.user?.username || '')
const identityOpen = ref(false)
const identityBusy = ref(false)
const identityError = ref('')

async function logout() { await auth.logout() }
function selectProfile(name: string) { auth.selectProfile(name) }
async function saveIdentity(input: { title: string; avatarDataURL?: string | null }) {
  const profile = auth.activeProfile
  if (!profile) return
  identityBusy.value = true
  identityError.value = ''
  try {
    await updateProfileIdentity(profile, input)
    await auth.refreshProfiles()
    await auth.refreshProfileAvatars()
    identityOpen.value = false
  } catch (cause) {
    identityError.value = cause instanceof Error ? cause.message : '保存 Agent 身份失败'
  } finally {
    identityBusy.value = false
  }
}
async function refreshOnFocus() {
  await auth.refreshProfiles()
  await auth.refreshProfileAvatars()
}
function refreshOnWindowFocus() { void refreshOnFocus().catch(() => undefined) }
function openIdentity() {
  void auth.refreshProfileAvatars().finally(() => { identityOpen.value = true })
}
onMounted(() => {
  window.addEventListener('focus', refreshOnWindowFocus)
  void auth.refreshProfileAvatars().catch(() => undefined)
})
onBeforeUnmount(() => window.removeEventListener('focus', refreshOnWindowFocus))
</script>

<template>
  <WorkspaceShell
    :user-name="userName"
    :pairing-user-name="auth.user?.username || ''"
    :active-profile="auth.activeProfile"
    :profiles="auth.profiles"
    :theme="theme.resolvedTheme"
    :insecure-transport="auth.insecureLan"
    :is-admin="auth.user?.role === 'admin'"
    :upstream-ready="auth.upstreamReady"
    :upstream-error="auth.upstreamError"
    :sidebar-title="sidebarTitle"
    :sidebar-subtitle="sidebarSubtitle"
    :sidebar-context-title="sidebarContextTitle"
    :sidebar-focus-mode="sidebarFocusMode"
    :inspector-open="inspectorOpen"
    :inspector-close-label="inspectorCloseLabel"
    @logout="logout"
    @toggle-theme="theme.toggle"
    @select-profile="selectProfile"
    @edit-profile="openIdentity"
    @close-inspector="emit('closeInspector')"
  >
    <template #sidebar-action><slot name="sidebar-action" /></template>
    <template #sidebar-before-heading><slot name="sidebar-before-heading" /></template>
    <template #sidebar><slot name="sidebar" /></template>
    <template #mobile-sidebar><slot name="sidebar" /></template>
    <template #default><slot /></template>
    <template #inspector><slot name="inspector" /></template>
  </WorkspaceShell>
  <AgentIdentityDialog :open="identityOpen" :profile="auth.activeProfile" :busy="identityBusy" :error="identityError" @close="identityOpen = false" @save="saveIdentity" />
</template>

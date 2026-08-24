<script setup lang="ts">
import { computed } from 'vue'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

withDefaults(defineProps<{
  sidebarTitle: string
  sidebarSubtitle?: string
  sidebarContextTitle?: string
  inspectorOpen?: boolean
  inspectorCloseLabel?: string
}>(), { sidebarSubtitle: '', sidebarContextTitle: '', inspectorOpen: false, inspectorCloseLabel: '关闭预览' })

const emit = defineEmits<{ closeInspector: [] }>()
const auth = useAuthStore()
const theme = useThemeStore()

const userName = computed(() => auth.user?.displayName || auth.user?.username || '')
const profileName = computed(() => auth.activeProfileName)
const profileNames = computed(() => auth.profiles.map(profile => profile.agentName || profile.displayName || profile.name))
const profileNameMap = computed(() => new Map(auth.profiles.map(profile => [profile.agentName || profile.displayName || profile.name, profile.name])))

async function logout() { await auth.logout() }
function selectProfile(label: string) { auth.selectProfile(profileNameMap.value.get(label) || label) }
</script>

<template>
  <WorkspaceShell
    :user-name="userName"
    :pairing-user-name="auth.user?.username || ''"
    :profile-name="auth.activeProfile?.agentName || auth.activeProfile?.displayName || profileName"
    :profiles="profileNames"
    :theme="theme.resolvedTheme"
    :insecure-transport="auth.insecureLan"
    :sidebar-title="sidebarTitle"
    :sidebar-subtitle="sidebarSubtitle"
    :sidebar-context-title="sidebarContextTitle"
    :inspector-open="inspectorOpen"
    :inspector-close-label="inspectorCloseLabel"
    @logout="logout"
    @toggle-theme="theme.toggle"
    @select-profile="selectProfile"
    @close-inspector="emit('closeInspector')"
  >
    <template #sidebar-action><slot name="sidebar-action" /></template>
    <template #sidebar-before-heading><slot name="sidebar-before-heading" /></template>
    <template #sidebar><slot name="sidebar" /></template>
    <template #mobile-sidebar><slot name="sidebar" /></template>
    <template #default><slot /></template>
    <template #inspector><slot name="inspector" /></template>
  </WorkspaceShell>
</template>

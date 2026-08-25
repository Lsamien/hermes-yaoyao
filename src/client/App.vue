<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import LoadingScreen from '@/components/app/LoadingScreen.vue'
import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useGroupsStore } from '@/stores/groups'
import { useThemeStore } from '@/stores/theme'

const auth = useAuthStore()
const chat = useChatStore()
const groups = useGroupsStore()
const theme = useThemeStore()
const route = useRoute()

const pageTitle = computed(() => {
  const name = route.path.startsWith('/groups')
    ? groups.selectedRoom?.name || '群聊'
    : route.path.startsWith('/files')
      ? '文件库'
      : chat.activeSession?.title || '对话'
  return `${name} · 夭夭`
})

watch(() => theme.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.dataset.theme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#181817' : '#f8f8f6')
}, { immediate: true })

watch(pageTitle, value => { document.title = value }, { immediate: true })

watch(() => auth.isAuthenticated, authenticated => {
  if (authenticated) void chat.connect().catch(() => undefined)
})

onMounted(() => auth.bootstrap())
</script>

<template>
  <LoadingScreen v-if="auth.status === 'checking'" />
  <LoginView v-else-if="!auth.isAuthenticated" />
  <RouterView v-else />
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import LoadingScreen from '@/components/app/LoadingScreen.vue'
import LoginView from '@/views/LoginView.vue'
import PasswordChangeView from '@/views/PasswordChangeView.vue'
import { useAuthStore } from '@/stores/auth'
import { useKanbanStore } from '@/stores/kanban'
import { useThemeStore } from '@/stores/theme'
import AgentIdentityFixture from '@/components/app/AgentIdentityFixture.vue'

const auth = useAuthStore()
const kanban = useKanbanStore()
const theme = useThemeStore()
const route = useRoute()
const agentIdentityFixture = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get('fixture') === 'agent-identity'

const pageTitle = computed(() => {
  const name = route.path.startsWith('/conversations')
    ? '聊天'
    : route.path.startsWith('/kanban')
      ? kanban.selectedBoard?.name || kanban.selectedBoardSlug || '看板'
    : route.path.startsWith('/files')
      ? '文件库'
      : '历史记录'
  return `${name} · 夭夭`
})

watch(() => theme.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.dataset.theme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#181817' : '#f8f8f6')
}, { immediate: true })

watch(pageTitle, value => { document.title = value }, { immediate: true })

onMounted(() => {
  if (!agentIdentityFixture) void auth.bootstrap()
})
</script>

<template>
  <AgentIdentityFixture v-if="agentIdentityFixture" />
  <LoadingScreen v-else-if="auth.status === 'checking'" />
  <LoginView v-else-if="!auth.isAuthenticated" />
  <PasswordChangeView v-else-if="auth.user?.mustChangePassword" />
  <RouterView v-else />
</template>

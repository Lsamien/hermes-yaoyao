<script setup lang="ts">
import { onMounted, watch } from 'vue'
import LoadingScreen from '@/components/app/LoadingScreen.vue'
import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

const auth = useAuthStore()
const theme = useThemeStore()

watch(() => theme.resolvedTheme, value => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.dataset.theme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#181817' : '#f8f8f6')
}, { immediate: true })

onMounted(() => auth.bootstrap())
</script>

<template>
  <LoadingScreen v-if="auth.status === 'checking'" />
  <LoginView v-else-if="!auth.isAuthenticated" />
  <RouterView v-else />
</template>

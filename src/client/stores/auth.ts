import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AuthStatus, BootstrapResponse, CurrentUser, Profile } from '@shared/types'
import * as authApi from '@/api/auth'
import { ApiError, clearApiSecurityContext, onApiUnauthorized } from '@/api/client'

function message(error: unknown): string {
  return error instanceof Error ? error.message : '认证请求失败'
}

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus>('checking')
  const user = ref<CurrentUser>()
  const profiles = ref<Profile[]>([])
  const activeProfileName = ref('')
  const csrfToken = ref('')
  const error = ref<string>()
  const authRequired = ref(true)
  const insecureLan = ref(false)
  const groupUploadsEnabled = ref(false)

  const activeProfile = computed(() => profiles.value.find(profile => profile.name === activeProfileName.value)
    ?? profiles.value.find(profile => profile.isDefault)
    ?? profiles.value[0])
  const isAuthenticated = computed(() => status.value === 'authenticated')

  function publish(response: BootstrapResponse): void {
    authRequired.value = response.authRequired
    csrfToken.value = response.csrfToken
    insecureLan.value = Boolean(response.insecureLan)
    groupUploadsEnabled.value = Boolean(response.groupUploadsEnabled)
    profiles.value = response.profiles
    user.value = response.user ?? (!response.authRequired
      ? { id: 'local', username: '本机 Hermes', role: 'local' }
      : undefined)
    if (!profiles.value.some(profile => profile.name === activeProfileName.value)) {
      activeProfileName.value = profiles.value.find(profile => profile.isDefault)?.name ?? profiles.value[0]?.name ?? ''
    }
    status.value = user.value ? 'authenticated' : 'anonymous'
    error.value = undefined
  }

  function expire(): void {
    if (status.value === 'anonymous' || status.value === 'checking') return
    status.value = 'expired'
    user.value = undefined
    profiles.value = []
    activeProfileName.value = ''
    csrfToken.value = ''
    clearApiSecurityContext()
  }

  onApiUnauthorized(expire)

  async function bootstrap(): Promise<void> {
    status.value = 'checking'
    error.value = undefined
    try { publish(await authApi.bootstrap()) }
    catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) status.value = 'anonymous'
      else status.value = 'error'
      error.value = message(cause)
      user.value = undefined
      profiles.value = []
    }
  }

  async function login(input: authApi.LoginInput): Promise<void> {
    status.value = 'authenticating'
    error.value = undefined
    try { publish(await authApi.login(input)) }
    catch (cause) {
      status.value = 'anonymous'
      error.value = message(cause)
      throw cause
    }
  }

  async function logout(): Promise<void> {
    try { await authApi.logout() } catch { /* local state still signs out */ }
    status.value = 'anonymous'
    user.value = undefined
    profiles.value = []
    activeProfileName.value = ''
    csrfToken.value = ''
    clearApiSecurityContext()
    try { publish(await authApi.bootstrap()) } catch { status.value = 'anonymous' }
  }

  function selectProfile(name: string): void {
    if (!profiles.value.some(profile => profile.name === name)) throw new Error(`未知 Profile：${name}`)
    activeProfileName.value = name
  }

  return {
    status, user, profiles, activeProfileName, activeProfile, csrfToken, error, authRequired, insecureLan, groupUploadsEnabled,
    isAuthenticated, bootstrap, login, logout, selectProfile, expire,
  }
})

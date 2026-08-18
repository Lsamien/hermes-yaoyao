<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import BrandMark from '@/components/common/BrandMark.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

const auth = useAuthStore()
const theme = useThemeStore()
const username = ref('')
const password = ref('')
const provider = ref('')
const localError = ref('')
const submitting = computed(() => auth.status === 'authenticating')

async function login() {
  if (!username.value.trim() || !password.value) return
  localError.value = ''
  try {
    await auth.login({ username: username.value.trim(), password: password.value, provider: provider.value || undefined })
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '登录失败，请检查账号和密码'
    password.value = ''
    await nextTick()
    document.querySelector<HTMLInputElement>('#password')?.focus()
  }
}
</script>

<template>
  <main class="login-view">
    <button class="theme-button icon-button" type="button" :aria-label="theme.resolvedTheme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="theme.toggle">
      <AppIcon :name="theme.resolvedTheme === 'dark' ? 'sun' : 'moon'" />
    </button>
    <div class="login-atmosphere" aria-hidden="true"><i /><i /><i /></div>
    <section class="login-panel" aria-labelledby="login-title">
      <BrandMark :size="72" />
      <div class="login-copy">
        <h1 id="login-title">登录 Hermes</h1>
      </div>
      <form @submit.prevent="login">
        <label><span>账号</span><input v-model="username" name="username" autocomplete="username" autofocus required placeholder="用户名" /></label>
        <label><span>密码</span><input id="password" v-model="password" name="password" type="password" autocomplete="current-password" required placeholder="密码" /></label>
        <label class="provider"><span>认证方式 <small>可选</small></span><input v-model="provider" name="provider" autocomplete="off" placeholder="使用服务器默认设置" /></label>
        <p v-if="localError || auth.error" class="login-error" role="alert"><AppIcon name="alert" :size="14" />{{ localError || auth.error }}</p>
        <button class="login-submit solid-button" type="submit" :disabled="submitting || !username.trim() || !password">
          <span>{{ submitting ? '正在登录…' : '登录' }}</span><AppIcon v-if="!submitting" name="arrow-up" :size="15" />
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-view { position: relative; display: grid; width: 100%; height: 100%; place-items: center; overflow: hidden; padding: 24px; background: var(--canvas); }
.theme-button { position: absolute; z-index: 3; top: max(15px, env(safe-area-inset-top)); right: 16px; }
.login-atmosphere { position: absolute; inset: 0; pointer-events: none; opacity: .75; }.login-atmosphere i { position: absolute; display: block; border: 1px solid var(--line); border-radius: 50%; }.login-atmosphere i:nth-child(1) { width: 520px; height: 520px; top: -360px; left: -180px; }.login-atmosphere i:nth-child(2) { width: 310px; height: 310px; right: -190px; bottom: -170px; }.login-atmosphere i:nth-child(3) { width: 3px; height: 3px; top: 22%; right: 18%; border: 0; background: var(--text-muted); box-shadow: -80px 160px 0 var(--line-strong), 90px 270px 0 var(--line-strong), -900px 340px 0 var(--line-strong); }
.login-panel { position: relative; z-index: 2; width: min(368px, 100%); animation: login-enter 360ms var(--ease-out) both; }.login-panel :deep(.brand-mark) { display: flex; justify-content: center; width: 100%; }
.login-copy { margin: 34px 0 22px; text-align: center; }.login-copy h1 { margin: 0; font-size: 18px; font-weight: 630; letter-spacing: -.03em; }
form { display: flex; flex-direction: column; gap: 13px; } label { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 10px; } label span { display: flex; justify-content: space-between; } label small { color: var(--text-muted); font-weight: 400; }
input { width: 100%; height: 43px; padding: 0 11px; border: 1px solid var(--line); border-radius: 11px; outline: 0; background: var(--surface-raised); color: var(--text-primary); font-size: 13px; transition: border-color 140ms ease, box-shadow 140ms ease; } input::placeholder { color: var(--text-muted); } input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.provider { margin-top: 1px; }.provider input { height: 37px; background: var(--surface-soft); font-size: 11px; }
.login-error { display: flex; align-items: flex-start; gap: 7px; margin: 0; padding: 8px 9px; border-radius: 9px; background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); font-size: 10px; line-height: 1.5; }
.login-submit { justify-content: space-between; width: 100%; height: 43px; margin-top: 3px; padding: 0 12px 0 15px; }.login-submit .app-icon { transform: rotate(45deg); }
@keyframes login-enter { from { opacity: 0; transform: translateY(10px); } }
@media (max-width: 480px) { .login-view { place-items: start center; padding: max(74px, calc(env(safe-area-inset-top) + 58px)) 22px 24px; overflow-y: auto; }.login-panel :deep(.brand-mark__plate) { width: 64px !important; height: 64px !important; }.login-copy { margin-top: 28px; } }
</style>

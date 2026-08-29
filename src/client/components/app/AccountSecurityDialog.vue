<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import AccountSecurityPanel from '@/components/app/AccountSecurityPanel.vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const auth = useAuthStore()

async function logout() {
  await auth.logout()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="layer" @mousedown.self="emit('close')">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="账号安全">
        <button class="icon-button close-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button>
        <AccountSecurityPanel :open="open" @saved="emit('close')" @logout="logout" />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.layer{position:fixed;z-index:285;inset:0;display:grid;place-items:center;padding:20px;background:var(--scrim);backdrop-filter:blur(6px)}
.dialog{position:relative;width:min(680px,100%);max-height:calc(100dvh - 40px);box-sizing:border-box;padding:24px;overflow:auto;border:1px solid var(--line);border-radius:18px;background:var(--surface-raised);box-shadow:var(--shadow-float)}
.dialog :deep(.panel-heading){padding-right:34px}
.close-button{position:absolute;z-index:1;top:18px;right:18px}
@media(max-width:620px){.layer{place-items:end center;padding:0}.dialog{width:100%;max-height:calc(100dvh - 12px);padding:20px 18px max(20px,env(safe-area-inset-bottom));border-radius:18px 18px 0 0}.close-button{top:14px;right:14px}}
</style>

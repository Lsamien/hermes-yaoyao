<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import SystemManagementPanel from '@/components/app/SystemManagementPanel.vue'

defineProps<{ open: boolean; upstreamReady?: boolean; upstreamError?: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="layer" @mousedown.self="emit('close')">
      <section class="system-management-dialog" role="dialog" aria-modal="true" aria-label="系统管理">
        <header>
          <div><small>ADMIN</small><h2>系统管理</h2></div>
          <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button>
        </header>
        <div class="system-management-dialog__panels">
          <SystemManagementPanel section="users" />
          <SystemManagementPanel
            section="connection"
            :upstream-ready="upstreamReady"
            :upstream-error="upstreamError"
          />
          <SystemManagementPanel section="push" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.layer {
  position: fixed;
  z-index: 280;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--scrim);
  backdrop-filter: blur(6px);
}
.system-management-dialog {
  width: min(620px, 100%);
  max-height: calc(100dvh - 40px);
  overflow: auto;
  padding: 19px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-float);
}
.system-management-dialog > header {
  display: flex;
  justify-content: space-between;
}
.system-management-dialog > header small {
  color: var(--text-muted);
  font-size: 9px;
}
.system-management-dialog h2 {
  margin: 3px 0 0;
  font-size: 19px;
}
.system-management-dialog__panels {
  display: grid;
  gap: 0;
}
@media (max-width: 600px) {
  .layer {
    place-items: end center;
    padding: 0;
  }
  .system-management-dialog {
    max-height: calc(100dvh - 12px);
    border-radius: 18px 18px 0 0;
    padding-bottom: max(18px, env(safe-area-inset-bottom));
  }
}
</style>

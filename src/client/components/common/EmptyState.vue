<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'

type EmptyIcon = 'chat' | 'groups' | 'files' | 'artifacts' | 'search' | 'alert'

withDefaults(defineProps<{
  icon?: EmptyIcon
  title: string
  description?: string
  actionLabel?: string
}>(), { icon: 'chat', description: '', actionLabel: '' })

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="empty-state">
    <div class="empty-state__mark"><AppIcon :name="icon" :size="23" /></div>
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <button v-if="actionLabel" class="solid-button" type="button" @click="emit('action')">{{ actionLabel }}</button>
  </div>
</template>

<style scoped>
.empty-state { display: flex; width: min(380px, calc(100% - 32px)); margin: auto; flex-direction: column; align-items: center; padding: 40px 20px; text-align: center; }
.empty-state__mark { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 17px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface-raised); color: var(--text-secondary); box-shadow: 0 12px 28px rgba(0,0,0,.05); }
h2 { margin: 0; font-size: 18px; font-weight: 630; letter-spacing: -.025em; } p { max-width: 310px; margin: 8px 0 20px; color: var(--text-muted); font-size: 12px; line-height: 1.65; }
</style>

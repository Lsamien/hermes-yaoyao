import { ref } from 'vue'
import { defineStore } from 'pinia'

export type AppSection = 'chat' | 'groups' | 'files' | 'artifacts'

export const useAppStore = defineStore('app', () => {
  const section = ref<AppSection>('chat')
  const mobileDrawerOpen = ref(false)
  const inspectorOpen = ref(false)

  function navigate(next: AppSection): void {
    section.value = next
    mobileDrawerOpen.value = false
  }

  return { section, mobileDrawerOpen, inspectorOpen, navigate }
})

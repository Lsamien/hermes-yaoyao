import { computed, onBeforeUnmount, ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemePreference = 'light' | 'dark' | 'system'

export const useThemeStore = defineStore('theme', () => {
  const saved = localStorage.getItem('hermes-yaoyao:theme')
  const theme = ref<ThemePreference>(saved === 'light' || saved === 'dark' ? saved : 'system')
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(media.matches)
  const onChange = (event: MediaQueryListEvent) => { systemDark.value = event.matches }
  media.addEventListener('change', onChange)
  onBeforeUnmount(() => media.removeEventListener('change', onChange))

  const resolvedTheme = computed<'light' | 'dark'>(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)

  function setTheme(value: ThemePreference): void {
    theme.value = value
    if (value === 'system') localStorage.removeItem('hermes-yaoyao:theme')
    else localStorage.setItem('hermes-yaoyao:theme', value)
  }

  function toggle(): void { setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark') }
  return { theme, resolvedTheme, setTheme, toggle }
})

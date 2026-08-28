<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Profile } from '@shared/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import BrandMark from '@/components/common/BrandMark.vue'
import NodePairingDialog from '@/components/app/NodePairingDialog.vue'
import SystemUpdateDialog from '@/components/app/SystemUpdateDialog.vue'
import SystemManagementDialog from '@/components/app/SystemManagementDialog.vue'
import AccountSecurityDialog from '@/components/app/AccountSecurityDialog.vue'
import YaoYaoSidebarIcon from '@/components/common/YaoYaoSidebarIcon.vue'

type NavItem = {
  key: 'chat' | 'groups' | 'files'
  label: string
  path: string
  icon: 'chat' | 'groups' | 'files'
}

const SIDEBAR_COLLAPSED_KEY = 'hermes-yaoyao:sidebar-collapsed'
const SIDEBAR_SEARCH_EVENT = 'hermes-yaoyao:sidebar-search'
const SIDEBAR_SEARCH_CLOSE_EVENT = 'hermes-yaoyao:sidebar-search-close'

const props = withDefaults(defineProps<{
  userName?: string
  pairingUserName?: string
  activeProfile?: Profile
  profiles?: Profile[]
  theme?: 'light' | 'dark'
  insecureTransport?: boolean
  sidebarTitle?: string
  sidebarSubtitle?: string
  sidebarContextTitle?: string
  sidebarFocusMode?: boolean
  inspectorOpen?: boolean
  inspectorCloseLabel?: string
  isAdmin?: boolean
  upstreamReady?: boolean
  upstreamError?: string
}>(), {
  userName: '',
  pairingUserName: '',
  activeProfile: undefined,
  profiles: () => [],
  theme: 'light',
  insecureTransport: false,
  sidebarTitle: '',
  sidebarSubtitle: '',
  sidebarContextTitle: '',
  sidebarFocusMode: false,
  inspectorOpen: false,
  inspectorCloseLabel: '关闭预览',
  isAdmin: false,
  upstreamReady: false,
  upstreamError: '',
})

const emit = defineEmits<{
  logout: []
  toggleTheme: []
  selectProfile: [profile: string]
  editProfile: []
  closeInspector: []
}>()

const route = useRoute()
const router = useRouter()
const mobileDrawerOpen = ref(false)
const profileMenuOpen = ref(false)
const sidebarCollapsed = ref(false)
const sidebarSearchOpen = ref(false)
const nodePairingOpen = ref(false)
const systemUpdateOpen = ref(false)
const systemManagementOpen = ref(false)
const accountSecurityOpen = ref(false)
const desktopSidebarContext = ref<HTMLElement | null>(null)
const mobileSidebarContext = ref<HTMLElement | null>(null)

function profileTitle(profile?: Profile): string {
  return profile?.agentName || profile?.displayName || profile?.name || '未选择 Agent'
}

const navItems: NavItem[] = [
  { key: 'chat', label: '对话', path: '/chat', icon: 'chat' },
  { key: 'groups', label: '团队', path: '/groups', icon: 'groups' },
  { key: 'files', label: '文件库', path: '/files', icon: 'files' },
]

// The active workspace is already represented by its main canvas and sidebar
// context. Keep this strip focused on destinations the user can switch to.
const featureNavItems = computed(() => navItems.filter(item => item.key !== activeNav.value.key
  && !(activeNav.value.key === 'groups' && item.key === 'files')))

const activeNav = computed(() => {
  const item = navItems.find(entry => route.path.startsWith(entry.path))
  return item ?? navItems[0]
})

const contextHeading = computed(() => ({
  chat: '历史记录',
  groups: '团队列表',
  files: '历史记录',
})[activeNav.value.key])

const hasPrimaryAction = computed(() => ['chat', 'groups', 'files'].includes(activeNav.value.key))

async function navigate(path: string) {
  mobileDrawerOpen.value = false
  await router.push(path)
}

function closeMenus(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.sidebar-account-switcher')) profileMenuOpen.value = false
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0') } catch { /* optional persistence */ }
}

function navIcon(key: NavItem['key']): 'chat' | 'folder' | 'people' {
  return key === 'groups' ? 'people' : key === 'files' ? 'folder' : 'chat'
}

async function openSidebarSearch(host: HTMLElement | null) {
  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '0') } catch { /* optional persistence */ }
    await nextTick()
  }
  sidebarSearchOpen.value = true
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_EVENT, { detail: { section: activeNav.value.key } }))
  await nextTick()
  host?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
}

async function closeSidebarSearch(host: HTMLElement | null, clear = false, restoreFocus = false) {
  const input = host?.querySelector<HTMLInputElement>('input[type="search"]')
  if (clear && input?.value) {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  sidebarSearchOpen.value = false
  document.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_CLOSE_EVENT))
  input?.blur()
  if (restoreFocus) {
    await nextTick()
    host?.closest('aside')?.querySelector<HTMLButtonElement>('.sidebar-search-trigger')?.focus()
  }
}

function handleSidebarInput(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.matches('input[type="search"]') && !input.value) void closeSidebarSearch(input.closest('.sidebar-context'))
}

function handleSidebarFocusout(event: FocusEvent) {
  const input = event.target as HTMLInputElement
  if (input.matches('input[type="search"]') && !input.value) void closeSidebarSearch(input.closest('.sidebar-context'))
}

function handleSidebarSearchClosed() { sidebarSearchOpen.value = false }

watch(() => route.fullPath, () => { mobileDrawerOpen.value = false })
watch(() => activeNav.value.key, () => {
  sidebarSearchOpen.value = false
  profileMenuOpen.value = false
})

onMounted(() => {
  try { sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { /* optional persistence */ }
  document.addEventListener('mousedown', closeMenus)
  document.addEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSidebarSearchClosed)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeMenus)
  document.removeEventListener(SIDEBAR_SEARCH_CLOSE_EVENT, handleSidebarSearchClosed)
})
</script>

<template>
  <div class="workspace-shell" :class="{ 'workspace-shell--collapsed': sidebarCollapsed, 'workspace-shell--sidebar-focused': sidebarFocusMode }">
    <header class="mobile-header">
      <button class="icon-button" type="button" aria-label="打开导航" @click="mobileDrawerOpen = true">
        <AppIcon name="menu" :size="20" />
      </button>
      <button class="mobile-brand" type="button" aria-label="返回对话" @click="navigate('/chat')">
        <BrandMark :size="28" compact />
      </button>
      <button class="icon-button" type="button" :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="emit('toggleTheme')">
        <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
      </button>
    </header>

    <aside
      class="desktop-sidebar rail"
      :class="{ 'desktop-sidebar--collapsed': sidebarCollapsed }"
      aria-label="主导航"
      :inert="mobileDrawerOpen"
    >
      <div class="sidebar-brand-row">
        <button class="rail__brand sidebar-brand" type="button" aria-label="返回对话" title="夭夭 Web" @click="navigate('/chat')">
          <BrandMark :size="sidebarCollapsed ? 26 : 32" :label="false" compact bare />
        </button>
      </div>
      <button
        class="sidebar-collapse"
        :class="{ 'sidebar-collapse--collapsed': sidebarCollapsed }"
        type="button"
        :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
        :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
        @click="toggleSidebar"
      >
        <AppIcon name="chevron-left" :size="18" />
      </button>

      <button
        v-if="activeNav.key !== 'files'"
        class="sidebar-search-trigger"
        :class="{ 'sidebar-search-trigger--searching': sidebarSearchOpen }"
        type="button"
        aria-label="搜索"
        title="搜索"
        :aria-expanded="sidebarSearchOpen"
        :aria-hidden="sidebarSearchOpen ? 'true' : undefined"
        :tabindex="sidebarSearchOpen ? -1 : 0"
        @click="openSidebarSearch(desktopSidebarContext)"
      >
        <YaoYaoSidebarIcon name="search" />
        <span>搜索</span>
      </button>

      <div v-if="hasPrimaryAction" class="sidebar-primary-action">
        <slot name="sidebar-action" />
      </div>

      <nav class="sidebar-feature-nav" aria-label="功能入口">
        <button
          v-for="item in featureNavItems"
          :key="item.key"
          type="button"
          :class="{ active: activeNav.key === item.key }"
          :aria-current="activeNav.key === item.key ? 'page' : undefined"
          :title="item.label"
          @click="navigate(item.path)"
        >
          <YaoYaoSidebarIcon :name="navIcon(item.key)" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section
        ref="desktopSidebarContext"
        class="sidebar-context"
        :class="{ 'sidebar-context--searching': sidebarSearchOpen }"
        @keydown.esc.capture="closeSidebarSearch(desktopSidebarContext, true, true)"
        @input.capture="handleSidebarInput"
        @focusout.capture="handleSidebarFocusout"
      >
        <slot name="sidebar-before-heading" />
        <header class="sidebar-context__heading">
          <strong>{{ sidebarContextTitle || contextHeading }}</strong>
          <span v-if="sidebarSubtitle">{{ sidebarSubtitle }}</span>
        </header>
        <div class="sidebar-context__body">
          <slot name="sidebar" />
        </div>
      </section>

      <div class="sidebar-footer">
        <div class="sidebar-account-switcher">
          <button class="sidebar-account-switcher__main" type="button" :title="`切换 Agent：${profileTitle(activeProfile)}`" @click="profileMenuOpen = !profileMenuOpen">
            <AgentAvatar :name="profileTitle(activeProfile)" :avatar="activeProfile?.agentAvatar || ''" :size="30" />
            <span class="account-copy">
              <strong>{{ profileTitle(activeProfile) }}</strong>
              <span>{{ activeProfile?.name || userName || '未选择 Agent' }}</span>
            </span>
            <AppIcon class="sidebar-account-switcher__chevron" name="chevron-down" :size="14" />
          </button>
          <button class="sidebar-account__utility" type="button" :title="theme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="emit('toggleTheme')">
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </button>
          <button v-if="isAdmin" class="sidebar-account__utility" type="button" title="手机与节点" aria-label="手机与节点" @click="nodePairingOpen = true">
            <AppIcon name="users" :size="17" />
          </button>
          <Transition name="menu-fade">
            <div v-if="profileMenuOpen" class="profile-menu">
              <button
                v-for="profile in profiles"
                :key="profile.name"
                type="button"
                :class="{ active: profile.name === activeProfile?.name }"
                @click="emit('selectProfile', profile.name); profileMenuOpen = false"
              >
                <AgentAvatar :name="profileTitle(profile)" :avatar="profile.agentAvatar || ''" :size="24" />
                <strong>{{ profileTitle(profile) }}</strong>
                <AppIcon v-if="profile.name === activeProfile?.name" name="check" :size="15" />
              </button>
              <button class="profile-menu__edit" type="button" :disabled="!activeProfile" @click="profileMenuOpen = false; emit('editProfile')"><AppIcon name="settings" :size="15" /><strong>编辑当前 Agent</strong></button>
              <button class="profile-menu__edit" type="button" @click="profileMenuOpen = false; accountSecurityOpen = true"><AppIcon name="settings" :size="15" /><strong>账号安全</strong></button>
              <button v-if="isAdmin" class="profile-menu__edit" type="button" @click="profileMenuOpen = false; systemManagementOpen = true"><AppIcon name="settings" :size="15" /><strong>系统管理</strong></button>
              <button v-if="isAdmin" class="profile-menu__update" type="button" @click="profileMenuOpen = false; systemUpdateOpen = true"><AppIcon name="download" :size="15" /><strong>系统更新</strong></button>
              <button class="profile-menu__logout" type="button" @click="profileMenuOpen = false; emit('logout')">
                <AppIcon name="logout" :size="15" /><strong>退出登录</strong>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </aside>

    <Transition name="drawer-fade">
      <button v-if="mobileDrawerOpen" class="drawer-scrim" type="button" aria-label="关闭导航" @click="mobileDrawerOpen = false" />
    </Transition>
    <aside
      class="mobile-drawer"
      :class="{ 'mobile-drawer--open': mobileDrawerOpen, 'mobile-drawer--focused': sidebarFocusMode }"
      aria-label="移动导航"
      :aria-hidden="!mobileDrawerOpen"
      :inert="!mobileDrawerOpen"
    >
      <div class="mobile-drawer__header">
        <button class="sidebar-brand" type="button" aria-label="返回对话" @click="navigate('/chat')">
          <BrandMark :size="32" compact />
        </button>
        <button class="icon-button" type="button" aria-label="关闭导航" @click="mobileDrawerOpen = false">
          <AppIcon name="close" />
        </button>
      </div>

      <button
        v-if="activeNav.key !== 'files'"
        class="sidebar-search-trigger"
        :class="{ 'sidebar-search-trigger--searching': sidebarSearchOpen }"
        type="button"
        aria-label="搜索"
        title="搜索"
        :aria-expanded="sidebarSearchOpen"
        :aria-hidden="sidebarSearchOpen ? 'true' : undefined"
        :tabindex="sidebarSearchOpen ? -1 : 0"
        @click="openSidebarSearch(mobileSidebarContext)"
      >
        <AppIcon name="search" :size="18" />
        <span>搜索</span>
      </button>

      <div v-if="hasPrimaryAction" class="sidebar-primary-action">
        <slot name="sidebar-action" />
      </div>

      <nav class="sidebar-feature-nav" aria-label="功能入口">
        <button
          v-for="item in featureNavItems"
          :key="item.key"
          type="button"
          :class="{ active: activeNav.key === item.key }"
          :aria-current="activeNav.key === item.key ? 'page' : undefined"
          @click="navigate(item.path)"
        >
          <AppIcon :name="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section
        ref="mobileSidebarContext"
        class="sidebar-context mobile-drawer__context"
        :class="{ 'sidebar-context--searching': sidebarSearchOpen }"
        @keydown.esc.capture="closeSidebarSearch(mobileSidebarContext, true, true)"
        @input.capture="handleSidebarInput"
        @focusout.capture="handleSidebarFocusout"
      >
        <slot name="sidebar-before-heading" />
        <header class="sidebar-context__heading">
          <strong>{{ sidebarContextTitle || contextHeading }}</strong>
          <span v-if="sidebarSubtitle">{{ sidebarSubtitle }}</span>
        </header>
        <div class="sidebar-context__body">
          <slot name="mobile-sidebar" />
        </div>
      </section>

      <div class="sidebar-footer mobile-drawer__footer">
        <div class="sidebar-account-switcher">
          <button class="sidebar-account-switcher__main" type="button" :title="`切换 Agent：${profileTitle(activeProfile)}`" @click="profileMenuOpen = !profileMenuOpen">
            <AgentAvatar :name="profileTitle(activeProfile)" :avatar="activeProfile?.agentAvatar || ''" :size="30" />
            <span class="account-copy">
              <strong>{{ profileTitle(activeProfile) }}</strong>
              <span>{{ activeProfile?.name || userName || '未选择 Agent' }}</span>
            </span>
            <AppIcon class="sidebar-account-switcher__chevron" name="chevron-down" :size="14" />
          </button>
          <button class="sidebar-account__utility" type="button" :title="theme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="emit('toggleTheme')">
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </button>
          <button v-if="isAdmin" class="sidebar-account__utility" type="button" title="手机与节点" aria-label="手机与节点" @click="nodePairingOpen = true; mobileDrawerOpen = false">
            <AppIcon name="users" :size="17" />
          </button>
          <Transition name="menu-fade">
            <div v-if="profileMenuOpen" class="profile-menu">
              <button
                v-for="profile in profiles"
                :key="profile.name"
                type="button"
                :class="{ active: profile.name === activeProfile?.name }"
                @click="emit('selectProfile', profile.name); profileMenuOpen = false"
              >
                <AgentAvatar :name="profileTitle(profile)" :avatar="profile.agentAvatar || ''" :size="24" />
                <strong>{{ profileTitle(profile) }}</strong>
                <AppIcon v-if="profile.name === activeProfile?.name" name="check" :size="15" />
              </button>
              <button class="profile-menu__edit" type="button" :disabled="!activeProfile" @click="profileMenuOpen = false; emit('editProfile')"><AppIcon name="settings" :size="15" /><strong>编辑当前 Agent</strong></button>
              <button class="profile-menu__edit" type="button" @click="profileMenuOpen = false; accountSecurityOpen = true; mobileDrawerOpen = false"><AppIcon name="settings" :size="15" /><strong>账号安全</strong></button>
              <button v-if="isAdmin" class="profile-menu__edit" type="button" @click="profileMenuOpen = false; systemManagementOpen = true; mobileDrawerOpen = false"><AppIcon name="settings" :size="15" /><strong>系统管理</strong></button>
              <button v-if="isAdmin" class="profile-menu__update" type="button" @click="profileMenuOpen = false; systemUpdateOpen = true; mobileDrawerOpen = false"><AppIcon name="download" :size="15" /><strong>系统更新</strong></button>
              <button class="profile-menu__logout" type="button" @click="profileMenuOpen = false; emit('logout')">
                <AppIcon name="logout" :size="15" /><strong>退出登录</strong>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </aside>

    <main class="workspace-main" :inert="mobileDrawerOpen">
      <slot />
    </main>

    <Transition name="inspector-slide">
      <aside v-if="inspectorOpen" class="workspace-inspector">
        <div class="workspace-inspector__close">
          <button class="icon-button" type="button" :aria-label="inspectorCloseLabel" :title="inspectorCloseLabel" @click="emit('closeInspector')">
            <AppIcon name="close" />
          </button>
        </div>
        <slot name="inspector" />
      </aside>
    </Transition>

    <NodePairingDialog :open="nodePairingOpen" :insecure-transport="insecureTransport" :user-name="pairingUserName || userName" @close="nodePairingOpen = false" />
    <SystemUpdateDialog :open="systemUpdateOpen" @close="systemUpdateOpen = false" />
    <SystemManagementDialog :open="systemManagementOpen" :upstream-ready="upstreamReady" :upstream-error="upstreamError" @close="systemManagementOpen = false" />
    <AccountSecurityDialog :open="accountSecurityOpen" @close="accountSecurityOpen = false" />
  </div>
</template>

<style scoped>
.workspace-shell {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--canvas);
  transition: grid-template-columns 180ms var(--ease-out);
}

.workspace-shell--collapsed { grid-template-columns: 68px minmax(0, 1fr) auto; }
.mobile-header, .mobile-drawer, .drawer-scrim { display: none; }

.desktop-sidebar {
  --sidebar-search-top: 58px;
  position: relative;
  z-index: 20;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-primary);
}

.sidebar-brand-row { display: flex; min-height: 58px; align-items: center; padding: 9px 20px 7px; }
.sidebar-brand { display: flex; min-width: 0; align-items: center; padding: 0; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
.sidebar-brand:hover { background: transparent; }
.sidebar-collapse, .sidebar-account__utility {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.sidebar-collapse:hover, .sidebar-account__utility:hover { background: var(--surface-hover); color: var(--text-primary); }
.sidebar-collapse { position: absolute; top: 12px; right: 11px; transition: transform 180ms var(--ease-out), color 140ms ease, background-color 140ms ease; }
.sidebar-collapse--collapsed { transform: rotate(180deg); }

.sidebar-search-trigger,
.sidebar-feature-nav button {
  display: flex;
  width: calc(100% - 20px);
  min-height: 36px;
  align-items: center;
  gap: 11px;
  margin-inline: 10px;
  padding: 0 11px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  font-weight: 580;
}
.sidebar-search-trigger:hover,
.sidebar-search-trigger[aria-expanded="true"],
.sidebar-feature-nav button:hover,
.sidebar-feature-nav button.active { background: var(--surface-soft); }
.sidebar-search-trigger[aria-expanded="true"] { box-shadow: 0 0 0 3px var(--focus-ring); }
.sidebar-search-trigger--searching { visibility: hidden; pointer-events: none; }

.desktop-sidebar .sidebar-context--searching :deep(.sidebar-search),
.desktop-sidebar .sidebar-context--searching :deep(.library-search),
.mobile-drawer .sidebar-context--searching :deep(.sidebar-search),
.mobile-drawer .sidebar-context--searching :deep(.library-search) {
  position: absolute;
  z-index: 40;
  top: var(--sidebar-search-top);
  left: 10px;
  width: calc(100% - 20px);
  min-height: 36px;
  margin: 0;
  background: var(--surface);
}


.sidebar-primary-action { margin: 3px 10px; }
.sidebar-primary-action :deep(button) {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  justify-content: flex-start;
  gap: 11px;
  padding: 0 11px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 580;
}
.sidebar-primary-action :deep(button:hover),
.sidebar-primary-action :deep(button:focus-visible) { background: var(--surface-soft); }
.sidebar-primary-action :deep(button:focus-visible) { outline: 0; box-shadow: inset 0 0 0 1px var(--line-strong); }
.sidebar-primary-action :deep(button:active) { background: var(--surface-hover); }
.sidebar-primary-action :deep(button > span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sidebar-feature-nav { display: flex; flex-direction: column; gap: 1px; padding: 0 0 9px; }
.sidebar-feature-nav button { margin-block: 0; }
.sidebar-feature-nav button.active { font-weight: 680; }

.sidebar-context { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.sidebar-context__heading { display: flex; min-height: 35px; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 20px 5px 21px; }
.sidebar-context__heading strong { font-size: 12px; font-weight: 680; }
.sidebar-context__heading span { overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-context__body { min-height: 0; flex: 1; overflow: hidden; }
.sidebar-context:not(.sidebar-context--searching) :deep(.library-search) { display: none; }
.sidebar-context__body :deep(.library-search) { margin-bottom: 10px; }
.sidebar-context__body :deep(.sidebar-list) { padding-inline: 10px; }
.sidebar-context__body :deep(.sidebar-item) { min-height: 42px; padding: 5px 9px; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--single-line) { min-height: 31px; padding: 1px 7px; }
.sidebar-context__body :deep(.sidebar-item--single-line .sidebar-item__row strong) { font-size: 11.5px; font-weight: 450; }
.sidebar-context__body :deep(.sidebar-item__icon) { width: 25px; height: 25px; flex-basis: 25px; border: 0; border-radius: 7px; background: transparent; }
.sidebar-context__body :deep(.sidebar-item__icon--avatar) { background: var(--surface-soft); color: var(--text-secondary); }
.sidebar-context__body :deep(.sidebar-item__row strong) { font-size: 12px; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--topic) { min-height: 28px; padding-block: 0; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--topic .sidebar-item__icon) { width: 17px; height: 17px; flex-basis: 17px; }
.sidebar-context__body :deep(.sidebar-item.sidebar-item--topic .sidebar-item__row strong) { font-size: 10.5px; font-weight: 450; }
.sidebar-context__body :deep(.library-sidebar) { padding-top: 1px; }
.sidebar-context__body :deep(.library-sidebar section) { margin-top: 2px; }

.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-search-trigger,
.workspace-shell--sidebar-focused .desktop-sidebar > .sidebar-primary-action,
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-feature-nav,
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-footer { display: none; }
.workspace-shell--sidebar-focused { grid-template-columns: 264px minmax(0, 1fr) auto; }
.workspace-shell--sidebar-focused .desktop-sidebar .sidebar-context,
.workspace-shell--sidebar-focused .desktop-sidebar--collapsed .sidebar-context { display: flex; flex: 1; }

.sidebar-footer { flex: 0 0 auto; padding: 7px 10px 10px; background: var(--surface); }
.sidebar-account-switcher { position: relative; z-index: 30; display: flex; min-height: 46px; align-items: center; gap: 6px; padding: 4px 7px; border-top: 1px solid var(--line); }
.sidebar-account-switcher__main { display: flex; min-width: 0; min-height: 38px; flex: 1; align-items: center; gap: 9px; padding: 4px 1px; border: 0; border-radius: 8px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.sidebar-account-switcher__main:hover { background: var(--surface-soft); }
.sidebar-account__avatar { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 50%; background: #c91e55; color: #fff; font-size: 12px; font-weight: 700; }
.sidebar-account-switcher__chevron { flex: 0 0 auto; color: var(--text-muted); }
.profile-menu { position: absolute; right: 0; bottom: calc(100% + 6px); left: 0; padding: 5px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
.profile-menu button { display: flex; width: 100%; min-height: 38px; align-items: center; gap: 9px; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: left; }
.profile-menu button:hover, .profile-menu button.active { background: var(--surface-hover); }
.profile-menu button > span:not(.agent-avatar) { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 8px; background: var(--surface-soft); color: var(--text-secondary); font-size: 10px; }
.profile-menu button strong { flex: 1; overflow: hidden; font-size: 12px; text-overflow: ellipsis; }
.profile-menu__edit { margin-top: 4px; border-top: 1px solid var(--line) !important; color: var(--text-secondary); }
.profile-menu__update { color: var(--text-secondary); }
.profile-menu__logout { margin-top: 4px; border-top: 1px solid var(--line) !important; color: var(--danger); }
.account-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.account-copy strong, .account-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-copy strong { font-size: 12px; font-weight: 650; }
.account-copy span { color: var(--text-muted); font-size: 10px; }

.desktop-sidebar--collapsed .sidebar-brand-row { padding-inline: 21px; }
.desktop-sidebar--collapsed .sidebar-brand { width: 26px; flex: 0 0 26px; overflow: hidden; }
.desktop-sidebar--collapsed .sidebar-collapse { position: static; width: 28px; height: 28px; flex: 0 0 28px; order: 1; align-self: center; margin-top: auto; margin-bottom: 5px; }
.desktop-sidebar--collapsed .sidebar-context { display: none; }
.desktop-sidebar--collapsed .sidebar-search-trigger { width: 42px; justify-content: center; margin-inline: auto; padding: 0; }
.desktop-sidebar--collapsed .sidebar-search-trigger span { display: none; }
.desktop-sidebar--collapsed .sidebar-primary-action { width: 42px; margin-inline: auto; }
.desktop-sidebar--collapsed .sidebar-primary-action :deep(button) { width: 42px; justify-content: center; padding: 0; }
.desktop-sidebar--collapsed .sidebar-primary-action :deep(button > span) { display: none; }
.desktop-sidebar--collapsed .sidebar-feature-nav { align-items: center; padding: 8px 0; }
.desktop-sidebar--collapsed .sidebar-feature-nav button { width: 42px; justify-content: center; margin-inline: 0; padding: 0; }
.desktop-sidebar--collapsed .sidebar-feature-nav button span,
.desktop-sidebar--collapsed .sidebar-account-switcher__chevron,
.desktop-sidebar--collapsed .account-copy { display: none; }
.desktop-sidebar--collapsed .sidebar-footer { display: flex; order: 2; margin-top: 0; flex-direction: column; align-items: center; padding: 0 8px 8px; }
.desktop-sidebar--collapsed .sidebar-account-switcher { width: 42px; flex-direction: column-reverse; gap: 3px; padding: 0; border-top: 0; }
.desktop-sidebar--collapsed .sidebar-account-switcher__main { width: 42px; min-height: 42px; flex: 0 0 42px; justify-content: center; padding: 0; }
.desktop-sidebar--collapsed .sidebar-account__utility { display: none; }
.desktop-sidebar--collapsed .profile-menu { right: auto; bottom: 0; left: calc(100% + 8px); width: 220px; }

.workspace-main { position: relative; display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: var(--canvas); }
.workspace-inspector { position: relative; width: min(390px, 34vw); min-width: 310px; min-height: 0; overflow: hidden; border-left: 1px solid var(--line); background: var(--surface); }
.workspace-inspector__close { position: absolute; z-index: 5; top: 10px; right: 10px; }

.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity 120ms ease, transform 120ms var(--ease-out); }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; transform: translateY(4px); }
.inspector-slide-enter-active, .inspector-slide-leave-active { overflow: hidden; transition: width 180ms var(--ease-out), opacity 150ms ease; }
.inspector-slide-enter-from, .inspector-slide-leave-to { width: 0; min-width: 0; opacity: 0; }

@media (max-width: 900px) {
  .workspace-shell, .workspace-shell--collapsed { grid-template-columns: minmax(0, 1fr); grid-template-rows: 52px minmax(0, 1fr); }
  .mobile-header { display: flex; z-index: 24; grid-row: 1; align-items: center; justify-content: space-between; padding: max(5px, env(safe-area-inset-top)) 10px 5px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(18px); }
  .mobile-brand { padding: 0; border: 0; background: transparent; cursor: pointer; }
  .desktop-sidebar { display: none; }
  .workspace-main { grid-row: 2; }
  .drawer-scrim { display: block; position: fixed; z-index: 50; inset: 0; padding: 0; border: 0; background: var(--scrim); backdrop-filter: blur(2px); }
  .mobile-drawer { --sidebar-search-top: calc(max(9px, env(safe-area-inset-top)) + 49px); display: flex; position: fixed; z-index: 51; inset: 0 auto 0 0; width: min(304px, 88vw); min-height: 0; flex-direction: column; overflow: hidden; padding: max(9px, env(safe-area-inset-top)) 0 max(9px, env(safe-area-inset-bottom)); background: var(--surface); box-shadow: var(--shadow-float); transform: translateX(-102%); transition: transform 190ms var(--ease-out); }
  .mobile-drawer--open { transform: translateX(0); }
  .mobile-drawer__header { display: flex; min-height: 49px; align-items: center; justify-content: space-between; padding: 0 14px 5px 12px; }
  .mobile-drawer__context { margin-top: 2px; }
  .mobile-drawer--focused { padding-block: max(9px, env(safe-area-inset-top)) max(9px, env(safe-area-inset-bottom)); }
  .mobile-drawer--focused > .sidebar-search-trigger,
  .mobile-drawer--focused > .sidebar-primary-action,
  .mobile-drawer--focused > .sidebar-feature-nav,
  .mobile-drawer--focused > .sidebar-footer { display: none; }
  .mobile-drawer--focused .mobile-drawer__context { margin-top: 0; flex: 1; }
  .mobile-drawer__context .sidebar-context__body :deep(.resource-sidebar) { min-height: 0; flex: 1; }
  .mobile-drawer__footer { padding-inline: 10px; }
  .workspace-inspector { position: fixed; z-index: 45; inset: 52px 0 0 auto; width: min(440px, 100vw); min-width: 0; box-shadow: var(--shadow-float); }
  .inspector-slide-enter-from, .inspector-slide-leave-to { width: min(440px, 100vw); transform: translateX(100%); }
}

.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity 160ms ease; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
</style>

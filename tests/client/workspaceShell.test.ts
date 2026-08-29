import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import type { Profile } from '@shared/types'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'

const profiles: Profile[] = [
  { name: 'default', agentName: '丫头', isDefault: true },
  { name: 'ops:blue/team', agentName: '运维 Agent', isDefault: false },
]

const SettingsCenterDialogStub = defineComponent({
  name: 'SettingsCenterDialog',
  emits: ['close'],
  props: {
    open: Boolean,
    initialPage: String,
  },
  template: '<div v-if="open" data-testid="settings-center" :data-page="initialPage"><button data-testid="close-settings" type="button" @click="$emit(\'close\')">close</button></div>',
})

async function mountShell() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: { template: '<div></div>' } },
      { path: '/groups', component: { template: '<div></div>' } },
      { path: '/files', component: { template: '<div></div>' } },
    ],
  })
  await router.push('/chat')
  await router.isReady()
  return mount(WorkspaceShell, {
    attachTo: document.body,
    props: {
      activeProfile: profiles[0],
      profiles,
      userName: 'owner',
      pairingUserName: 'owner',
      isAdmin: true,
      sidebarTitle: '历史记录',
    },
    global: {
      plugins: [router],
      stubs: {
        SettingsCenterDialog: SettingsCenterDialogStub,
        AgentAvatar: true,
        AppIcon: true,
        BrandMark: true,
        YaoYaoSidebarIcon: true,
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Workspace shell account controls', () => {
  it('keeps Agent switching focused and opens settings from its independent button', async () => {
    const wrapper = await mountShell()
    const desktop = wrapper.get('.desktop-sidebar')

    const agentTrigger = desktop.get('.sidebar-account-switcher__main')
    expect(agentTrigger.attributes('aria-haspopup')).toBe('listbox')
    expect(agentTrigger.attributes('aria-expanded')).toBe('false')
    await agentTrigger.trigger('click')
    expect(agentTrigger.attributes('aria-expanded')).toBe('true')
    const menu = desktop.get('.profile-menu')
    expect(menu.attributes('role')).toBe('listbox')
    expect(menu.text()).toContain('切换 Agent')
    expect(menu.text()).toContain('丫头')
    expect(menu.text()).toContain('运维 Agent')
    expect(menu.text()).not.toContain('Agent 设置')
    expect(menu.findAll('button')).toHaveLength(profiles.length)
    expect(menu.findAll('[role="option"]').map(option => option.attributes('aria-selected'))).toEqual(['true', 'false'])
    expect(menu.text()).not.toContain('账号安全')
    expect(menu.text()).not.toContain('系统管理')
    expect(menu.text()).not.toContain('系统更新')
    expect(menu.text()).not.toContain('退出登录')

    expect(document.activeElement).toBe(menu.find('[role="option"][aria-selected="true"]').element)
    await menu.trigger('keydown', { key: 'ArrowDown' })
    const targetProfile = menu.findAll<HTMLButtonElement>('button')
      .find(button => button.text().includes('运维 Agent'))!
    expect(document.activeElement).toBe(targetProfile.element)
    await targetProfile.trigger('click')
    expect(wrapper.emitted('selectProfile')).toEqual([['ops:blue/team']])
    expect(desktop.find('.profile-menu').exists()).toBe(false)

    const settingsTrigger = desktop.get<HTMLButtonElement>('.sidebar-settings-trigger')
    await settingsTrigger.trigger('click')
    const settings = wrapper.get('[data-testid="settings-center"]')
    expect(settings.attributes('data-page')).toBe('agent-identity')
    expect(desktop.find('.profile-menu').exists()).toBe(false)

    await wrapper.get('[data-testid="close-settings"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(settingsTrigger.element)

    const mobileNavigation = wrapper.get<HTMLButtonElement>('.mobile-header button[aria-label="打开导航"]')
    await mobileNavigation.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.mobile-header').attributes()).toHaveProperty('inert')
    expect(document.activeElement).toBe(wrapper.get('.mobile-drawer button[aria-label="关闭导航"]').element)
    await wrapper.get('.mobile-drawer .sidebar-settings-trigger').trigger('click')
    await wrapper.get('[data-testid="close-settings"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(mobileNavigation.element)

    wrapper.unmount()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SystemOverviewPanel from '@/components/app/SystemOverviewPanel.vue'

vi.mock('@/api/admin', () => ({ listUsers: vi.fn(async () => []) }))
vi.mock('@/api/push', () => ({ getPushSystemStatus: vi.fn(async () => ({ configured: false })) }))
vi.mock('@/api/pairing', () => ({ pairedDevices: vi.fn(() => new Promise(() => {})) }))
vi.mock('@/api/agentManagement', () => ({ getDuplexVoiceSettings: vi.fn(() => new Promise(() => {})) }))
vi.mock('@/api/systemUpdate', () => ({ systemUpdateStatus: vi.fn(async () => ({
  current: { webVersion: '0.2.29', pluginVersion: '1.7.3' }, versionsMatch: false, updateAvailable: false,
})) }))

describe('SystemOverviewPanel offline updates', () => {
  it('shows Web status and allows update navigation while upstream panels are stalled', async () => {
    const wrapper = mount(SystemOverviewPanel, { props: { upstreamReady: false }, global: { stubs: { AppIcon: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('Web 0.2.29 · 可独立升级与回滚')
    expect(wrapper.text()).not.toContain('已是最新版本')
    expect(wrapper.text()).not.toContain('插件 1.7.3')
    const update = wrapper.findAll('button').find(button => button.text().includes('更新与回滚'))!
    await update.trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['system-update']])
    wrapper.unmount()
  })
})

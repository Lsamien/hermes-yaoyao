import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { GroupAgent } from '@shared/types'
import CreateGroupDialog from '@/components/groups/CreateGroupDialog.vue'
import GroupManager from '@/components/groups/GroupManager.vue'

function agent(id: string, profile: string, displayName: string, isHost: boolean, replyWithoutMention: boolean): GroupAgent {
  return {
    id, roomId: 'room-1', profile, displayName, description: `${displayName} 的职责`, storedSessionId: null,
    lastContextMessageSeq: 0, enabled: true, replyWithoutMention, isHost,
    model: null, provider: null, reasoningEffort: null, fastMode: null,
    createdAt: 1, updatedAt: 1, status: 'idle',
  }
}

describe('group host controls', () => {
  it('keeps one independent host selection when creating a v5 room', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: ['yaoyao', 'yaoer'], hostEnabled: true },
      global: { stubs: { teleport: true } },
    })
    await nextTick()
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('主持人验收')
    const profileButtons = wrapper.findAll('.agent-picker > button')
    await profileButtons[1]!.trigger('click')
    const host = wrapper.get<HTMLSelectElement>('select[aria-label="主持人"]')
    await host.setValue('yaoer')
    await profileButtons[1]!.trigger('click')
    expect(host.element.value).toBe('yaoyao')
    await profileButtons[1]!.trigger('click')
    await host.setValue('yaoer')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="所有成员无需 @ 也回复"]').element.checked).toBe(true)
    await wrapper.get('.solid-button').trigger('click')

    expect(wrapper.emitted('create')?.[0]?.[0]).toEqual({
      name: '主持人验收', profiles: ['yaoyao', 'yaoer'], hostProfile: 'yaoer', autoReply: true, replyRounds: 3,
    })
    wrapper.unmount()
  })

  it('keeps the legacy v4 create UI and payload free of host fields', async () => {
    const wrapper = mount(CreateGroupDialog, {
      attachTo: document.body,
      props: { open: true, profiles: ['yaoyao'], hostEnabled: false },
      global: { stubs: { teleport: true } },
    })
    await nextTick()
    expect(wrapper.find('select[aria-label="主持人"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="启用自动回复"]').exists()).toBe(true)
    await wrapper.get('input[placeholder="例如：产品评审"]').setValue('v4 房间')
    await wrapper.get('.solid-button').trigger('click')
    expect(wrapper.emitted('create')?.[0]?.[0]).not.toHaveProperty('hostProfile')
    wrapper.unmount()
  })

  it('emits one host promotion and explains the independent auto-reply setting', async () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, true)
    const second = agent('agent-2', 'yaoer', '瑶儿', false, false)
    const wrapper = mount(GroupManager, {
      attachTo: document.body,
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [first.id, second.id], replyRounds: 3 },
        agents: [first, second],
        hostEnabled: true,
      },
    })
    const selector = wrapper.get<HTMLSelectElement>('select[aria-label="主持人"]')
    expect(selector.element.value).toBe('agent-1')
    expect(wrapper.findAll('.host-badge')).toHaveLength(1)
    await selector.setValue('agent-2')
    expect(wrapper.emitted('updateAgent')?.[0]).toEqual(['agent-2', { isHost: true }])

    await wrapper.setProps({ agents: [{ ...first, isHost: false }, { ...second, isHost: true }] })
    await wrapper.get('button[aria-label="设置瑶儿"]').trigger('click')
    await nextTick()
    const dialog = document.querySelector('[role="dialog"][aria-label="瑶儿 Agent 设置"]')
    expect(dialog?.textContent).toContain('主持人始终处理用户无 @ 消息')
    expect(dialog?.querySelector('input[aria-label="无需 @ 也回复"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('blocks removing a host when no enabled replacement exists and shows manager errors', () => {
    const first = agent('agent-1', 'yaoyao', '夭夭', true, true)
    const second = { ...agent('agent-2', 'yaoer', '瑶儿', false, false), enabled: false }
    const wrapper = mount(GroupManager, {
      props: {
        room: { id: 'room-1', name: '群聊', memberIds: [first.id, second.id], replyRounds: 3 },
        agents: [first, second],
        hostEnabled: true,
        managerError: '需要另一位已启用成员',
      },
    })

    const removeHost = wrapper.get<HTMLButtonElement>('button[aria-label="移除夭夭"]')
    expect(removeHost.element.disabled).toBe(true)
    expect(removeHost.attributes('title')).toContain('已启用成员')
    expect(wrapper.get('[role="alert"]').text()).toBe('需要另一位已启用成员')
  })
})

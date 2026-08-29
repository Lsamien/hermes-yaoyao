import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TopicTeamPickerDialog from '../../src/client/components/groups/TopicTeamPickerDialog.vue'

const rooms = [{
  id: 'room-a', name: '产品团队', cwd: '', createdAt: 1, updatedAt: 2, archived: false,
  agentCount: 3, unreadCount: 0, maxReplyRounds: 3, instructions: '负责产品设计与评审', orchestrationMode: 'host' as const,
  avatarMembers: [{ profile: 'product', nodeId: 'local', displayName: '产品负责人' }],
}, {
  id: 'room-b', name: '运维团队', cwd: '', createdAt: 1, updatedAt: 2, archived: false,
  agentCount: 2, unreadCount: 0, maxReplyRounds: 3,
}]

afterEach(() => { document.body.innerHTML = '' })

describe('TopicTeamPickerDialog', () => {
  it('lists teams and emits the selected team before topic creation', async () => {
    const wrapper = mount(TopicTeamPickerDialog, {
      props: { open: true, rooms, currentRoomId: 'room-a' },
      attachTo: document.body,
    })

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('选择团队')
    expect(document.body.textContent).toContain('产品团队')
    expect(document.body.textContent).toContain('运维团队')
    expect(document.body.textContent).toContain('当前')

    const avatars = [...document.querySelectorAll<HTMLElement>('.topic-team-picker__choose .team-avatar')]
    expect(avatars[0]?.style.width).toBe('34px')
    expect(avatars[0]?.style.height).toBe('34px')

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.topic-team-picker__choose')]
    buttons[1]?.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('select')).toEqual([['room-b']])
    wrapper.unmount()
  })

  it('shows team details without selecting or creating a topic', async () => {
    const wrapper = mount(TopicTeamPickerDialog, {
      props: { open: true, rooms, currentRoomId: 'room-a' },
      attachTo: document.body,
    })

    const details = document.querySelector<HTMLButtonElement>('[aria-label="查看产品团队详情"]')
    details?.click()
    await wrapper.vm.$nextTick()

    const panel = document.querySelector('[aria-label="产品团队团队详情"]')
    expect(panel?.textContent).toContain('负责产品设计与评审')
    expect(panel?.textContent).toContain('产品负责人')
    expect(panel?.textContent).toContain('管理员协调')
    expect(panel?.textContent).toContain('3 轮')
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('closes on Escape without selecting a team', async () => {
    const wrapper = mount(TopicTeamPickerDialog, { props: { open: true, rooms }, attachTo: document.body })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })
})

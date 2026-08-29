import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TopicTeamPickerDialog from '../../src/client/components/groups/TopicTeamPickerDialog.vue'

const rooms = [{
  id: 'room-a', name: '产品团队', cwd: '', createdAt: 1, updatedAt: 2, archived: false,
  agentCount: 3, unreadCount: 0, maxReplyRounds: 3,
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

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.topic-team-picker__list > button')]
    buttons[1]?.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('select')).toEqual([['room-b']])
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

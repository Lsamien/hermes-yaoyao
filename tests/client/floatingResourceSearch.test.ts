import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingResourceSearch from '../../src/client/components/app/FloatingResourceSearch.vue'

afterEach(() => { document.body.innerHTML = '' })

describe('FloatingResourceSearch', () => {
  it('keeps team and archived filters on the left while updating right-side results', async () => {
    const wrapper = mount(FloatingResourceSearch, {
      props: {
        section: 'groups',
        label: '搜索话题、团队或归档',
        split: true,
        items: [
          {
            id: 'search:all', title: '全部', subtitle: '1 个话题', section: '团队', icon: 'groups',
            children: [{ id: 'topic:r1:t1', title: '发布检查', subtitle: '测试团队：准备上线', section: '话题', avatar: '' }],
          },
          {
            id: 'room:r1', title: '测试团队', subtitle: '2 个 Agent', section: '团队', avatar: '',
            children: [{ id: 'topic:r1:t1', title: '团队内话题', subtitle: '测试团队：准备上线', section: '话题', avatar: '' }],
          },
          {
            id: 'search:archived', title: '已归档内容', subtitle: '1 个团队 · 1 个话题', section: '归档', icon: 'archive',
            children: [
              { id: 'archived-room:r2', title: '旧团队', subtitle: '2 个 Agent', section: '团队', avatar: '' },
              { id: 'archived-topic:r2:t2', title: '旧话题', subtitle: '旧团队：历史消息', section: '话题', avatar: '' },
            ],
          },
        ],
      },
      attachTo: document.body,
    })

    document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search', { detail: { section: 'groups' } }))
    await wrapper.vm.$nextTick()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('全部')
    expect(dialog?.textContent).toContain('团队')
    expect(dialog?.textContent).toContain('归档')
    expect(dialog?.textContent).toContain('话题')
    expect(dialog?.querySelectorAll('.floating-resource-search__navigation-heading')).toHaveLength(2)
    expect(dialog?.querySelector('.floating-resource-search__context')?.textContent).toContain('全部')
    expect(dialog?.textContent).toContain('发布检查')
    expect(wrapper.emitted('open')).toHaveLength(1)

    const team = [...document.querySelectorAll<HTMLButtonElement>('.floating-resource-search__navigation button')]
      .find(button => button.textContent?.trim() === '测试团队')
    team?.click()
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('团队内话题')
    expect(document.querySelector('[aria-label="返回搜索结果"]')).toBeNull()
    expect(wrapper.emitted('select')).toBeUndefined()

    const archived = [...document.querySelectorAll<HTMLButtonElement>('.floating-resource-search__navigation button')]
      .find(button => button.textContent?.includes('已归档内容'))
    archived?.click()
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('旧团队')
    expect(document.body.textContent).toContain('旧话题')
    expect(wrapper.emitted('select')).toBeUndefined()

    const archivedTopic = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(button => button.textContent?.includes('旧话题'))
    archivedTopic?.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('select')).toEqual([['archived-topic:r2:t2']])
    wrapper.unmount()
  })
})

it('keeps the query across archived categories and renders direct Agent portraits rather than a group cluster', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger); trigger.focus()
  const wrapper = mount(FloatingResourceSearch, { attachTo: document.body, props: {
    section: 'groups', label: '搜索聊天', tabbed: true,
    items: [
      {id:'open',title:'未归档',children:[{id:'a',title:'测试角色',avatarKind:'agent',avatar:'yaoyao-mascot:v1:circle:e78531:friendly'}]},
      {id:'archive',title:'已归档',children:[{id:'b',title:'测试归档',avatarKind:'agent',avatar:'yaoyao-mascot:v1:square:377fe6:friendly'}]},
    ],
  } })
  document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search', {detail:{section:'groups'}}))
  await wrapper.vm.$nextTick()
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
  input.value = '测试'; input.dispatchEvent(new Event('input', {bubbles:true}))
  await wrapper.vm.$nextTick()
  document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="已归档"]')!.click()
  await wrapper.vm.$nextTick()
  expect(input.value).toBe('测试')
  expect(document.querySelector('[role="option"]')?.textContent).toContain('测试归档')
  expect(document.querySelector('[role="dialog"] .agent-avatar')).not.toBeNull()
  expect(document.querySelector('[role="dialog"] .team-avatar')).toBeNull()
  document.querySelector<HTMLButtonElement>('[aria-label="关闭搜索"]')!.click()
  await wrapper.vm.$nextTick()
  expect(document.activeElement).toBe(trigger)
  wrapper.unmount()
})

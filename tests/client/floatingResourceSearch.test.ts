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

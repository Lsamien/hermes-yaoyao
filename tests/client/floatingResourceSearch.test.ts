import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingResourceSearch from '../../src/client/components/app/FloatingResourceSearch.vue'

afterEach(() => { document.body.innerHTML = '' })

describe('FloatingResourceSearch', () => {
  it('groups team, archived, and topic results and emits the selected entry', async () => {
    const wrapper = mount(FloatingResourceSearch, {
      props: {
        section: 'groups',
        label: '搜索话题、团队或归档',
        items: [
          { id: 'room:r1', title: '测试团队', subtitle: '2 个 Agent', section: '团队', avatar: '' },
          { id: 'search:archived', title: '已归档内容', subtitle: '查看已归档团队和话题', section: '已归档', icon: 'archive' },
          { id: 'topic:r1:t1', title: '发布检查', subtitle: '测试团队：准备上线', section: '话题', avatar: '', topic: true },
        ],
      },
      attachTo: document.body,
    })

    document.dispatchEvent(new CustomEvent('hermes-yaoyao:sidebar-search', { detail: { section: 'groups' } }))
    await wrapper.vm.$nextTick()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('团队')
    expect(dialog?.textContent).toContain('已归档')
    expect(dialog?.textContent).toContain('话题')
    expect(dialog?.querySelectorAll('.floating-resource-search__section')).toHaveLength(3)
    expect(dialog?.querySelectorAll('.team-avatar')).toHaveLength(2)

    const archived = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(button => button.textContent?.includes('已归档内容'))
    archived?.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('select')).toEqual([['search:archived']])
    wrapper.unmount()
  })
})

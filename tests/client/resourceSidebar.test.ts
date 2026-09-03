import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'

describe('ResourceSidebar', () => {
  it('uses a neutral group placeholder without inventing members', () => {
    const wrapper = mount(ResourceSidebar, {
      props: {
        items: [
          { id: 'topic:room-1:topic-1', title: '话题一', topic: true, avatar: '', avatarFallbackKey: 'room-1' },
          { id: 'topic:room-1:topic-2', title: '话题二', topic: true, avatar: '', avatarFallbackKey: 'room-1' },
        ],
      },
    })

    const groups = wrapper.findAll('.team-avatar')
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      expect(group.findAll('.team-avatar__member')).toHaveLength(0)
      expect(group.find('.app-icon').exists()).toBe(true)
    }
    wrapper.unmount()
  })
})

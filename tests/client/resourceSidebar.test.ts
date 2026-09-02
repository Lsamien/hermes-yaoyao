import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'

describe('ResourceSidebar', () => {
  it('keeps fallback avatars stable across topics from the same team', () => {
    const wrapper = mount(ResourceSidebar, {
      props: {
        items: [
          { id: 'topic:room-1:topic-1', title: '话题一', topic: true, avatar: '', avatarFallbackKey: 'room-1' },
          { id: 'topic:room-1:topic-2', title: '话题二', topic: true, avatar: '', avatarFallbackKey: 'room-1' },
        ],
      },
    })

    const signatures = wrapper.findAll('.team-avatar').map(team => team.findAll('.agent-avatar').map(agent => {
      const shape = agent.find('.agent-avatar__body').element.firstElementChild?.tagName
      const color = agent.find('stop[offset="0.5"]').attributes('stop-color')
      return `${shape}:${color}`
    }))
    expect(signatures).toHaveLength(2)
    expect(signatures[0]).toHaveLength(3)
    expect(signatures[1]).toEqual(signatures[0])
  })
})

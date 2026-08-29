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

    const sources = wrapper.findAll<HTMLImageElement>('.team-avatar__image').map(image => image.attributes('src'))
    expect(sources).toHaveLength(2)
    expect(new Set(sources).size).toBe(1)
  })
})

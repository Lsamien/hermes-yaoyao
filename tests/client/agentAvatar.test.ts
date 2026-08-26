import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'

const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('AgentAvatar', () => {
  it('marks real images so caller backgrounds cannot show through transparent pixels', () => {
    const wrapper = mount(AgentAvatar, { props: { name: '丫头', avatar: transparentPng } })

    expect(wrapper.classes()).toContain('agent-avatar--image')
    expect(wrapper.find('img').attributes('src')).toBe(transparentPng)
  })

  it('keeps the caller background available for the text fallback', () => {
    const wrapper = mount(AgentAvatar, { props: { name: '丫头' } })

    expect(wrapper.classes()).not.toContain('agent-avatar--image')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('丫')
  })

  it('keeps a group-message image transparent when MessageTimeline adds its fallback class', () => {
    const wrapper = mount(MessageTimeline, {
      attachTo: document.body,
      props: {
        messages: [{ id: 'assistant-1', role: 'assistant', profile: 'default', author: '丫头', content: '收到，测试正常。' }],
        agentAvatars: { default: transparentPng },
      },
    })
    const avatar = wrapper.get('.message__avatar')

    expect(avatar.classes()).toEqual(expect.arrayContaining(['agent-avatar--image', 'message__avatar']))
    expect(getComputedStyle(avatar.element).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    wrapper.unmount()
  })
})

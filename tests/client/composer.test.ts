import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ComposerShell from '@/components/composer/ComposerShell.vue'

describe('composer availability', () => {
  it('keeps the group-chat send action available while an Agent is running', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'group', streaming: true } })
    expect(wrapper.find('[aria-label="发送消息"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="停止生成"]').exists()).toBe(false)
  })

  it('keeps the ordinary-chat interrupt action while its server run is active', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'chat', streaming: true } })
    expect(wrapper.find('[aria-label="停止生成"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="发送消息"]').exists()).toBe(false)
  })

  it('places an accessible blue fast-mode toggle beside the model control', () => {
    const wrapper = mount(ComposerShell, { props: { mode: 'chat', modelLabel: 'gpt-5.6-terra', fastMode: true } })
    const model = wrapper.get('.composer-tool--model')
    const fast = wrapper.get('.composer-fast-mode')
    expect(model.element.nextElementSibling).toBe(fast.element)
    expect(fast.attributes('aria-pressed')).toBe('true')
    expect(fast.classes()).toContain('active')
    fast.trigger('click')
    expect(wrapper.emitted('fastModeToggle')?.[0]).toEqual([false])
  })
})

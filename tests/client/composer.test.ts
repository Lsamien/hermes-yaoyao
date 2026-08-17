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
})

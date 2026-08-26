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

  it('keeps named group activity directly above the input after a reference', () => {
    const wrapper = mount(ComposerShell, {
      props: {
        mode: 'group',
        activityText: '夭夭正在输入…',
        reference: { id: 'message-1', author: '夭夭', content: '上一条消息' },
      },
    })
    const reference = wrapper.get('.composer-reference')
    const activity = wrapper.get('.composer-activity-slot')
    const shell = wrapper.get('.composer-shell')
    expect(reference.element.nextElementSibling).toBe(activity.element)
    expect(activity.element.nextElementSibling).toBe(shell.element)
    expect(activity.get('[role="status"]').text()).toBe('夭夭正在输入…')
  })

  it('adds attachments when randomUUID is unavailable in an HTTP browser', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })
    try {
      const wrapper = mount(ComposerShell)
      const input = wrapper.get<HTMLInputElement>('.composer-file-input')
      const file = new File(['兼容内容'], '兼容.txt', { type: 'text/plain', lastModified: 123 })
      Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })

      await input.trigger('change')

      expect(wrapper.get('.composer-attachment strong').text()).toBe('兼容.txt')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      wrapper.unmount()
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor)
      else Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
    }
  })
})

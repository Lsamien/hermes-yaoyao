import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
})

describe('MarkdownContent code copy', () => {
  it('copies code through the compatibility fallback and confirms success', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('NotAllowedError') }) },
    })
    let selectedText = ''
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        selectedText = (document.activeElement as HTMLTextAreaElement | null)?.value ?? ''
        return true
      }),
    })
    const wrapper = mount(MarkdownContent, {
      attachTo: document.body,
      props: { content: '```bash\necho "复制成功"\n```' },
    })
    await nextTick()

    const button = wrapper.find<HTMLButtonElement>('.code-copy')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await nextTick()

    expect(selectedText).toBe('echo "复制成功"\n')
    expect(button.text()).toBe('已复制')
    wrapper.unmount()
  })
})

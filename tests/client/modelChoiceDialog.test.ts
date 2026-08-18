import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ModelChoiceDialog from '@/components/composer/ModelChoiceDialog.vue'

const options = [
  { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra', provider: 'openai', supportsReasoning: true, isDefault: true },
  { id: 'gpt-5.5', name: 'GPT 5.5', provider: 'openai' },
  { id: 'claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic' },
]

afterEach(() => { document.body.innerHTML = '' })

describe('ModelChoiceDialog', () => {
  it('groups and filters models while preserving the selected state', async () => {
    const wrapper = mount(ModelChoiceDialog, { attachTo: document.body, props: { open: true, options, selectedId: 'openai:gpt-5.6-terra' } })
    await nextTick()
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="model-dialog-title"]')
    expect(dialog?.textContent).toContain('OpenAI')
    expect(dialog?.textContent).toContain('Anthropic')
    expect(dialog?.querySelector('.model-dialog__item--active')?.textContent).toContain('gpt-5.6-terra')

    const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索模型名称或 ID"]')!
    input.value = 'claude'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(dialog?.textContent).toContain('Claude Sonnet')
    expect(dialog?.textContent).not.toContain('gpt-5.5')

    document.querySelector<HTMLButtonElement>('.model-dialog__item')!.click()
    expect(wrapper.emitted('select')?.[0]).toEqual(['anthropic:claude-sonnet'])
    wrapper.unmount()
  })

  it('closes with Escape when no model switch is running', () => {
    const wrapper = mount(ModelChoiceDialog, { attachTo: document.body, props: { open: true, options } })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})

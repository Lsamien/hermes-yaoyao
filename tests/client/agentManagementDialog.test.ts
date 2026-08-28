import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import AgentIdentityDialog from '@/components/app/AgentIdentityDialog.vue'
import { deleteModelService, listModelServices, saveDuplexVoiceSettings, saveLegacyModelService, saveModelService, validateModelService } from '@/api/agentManagement'

vi.mock('@/api/agentManagement', () => ({
  listModelServices: vi.fn(async () => ({ endpoints: [], current: {} })),
  listLegacyModelServices: vi.fn(async () => [{ id: 'custom:tingly', name: 'tingly', base_url: 'http://tingly.test/v1', model: 'omni', models: ['omni'], discover_models: true, has_api_key: true, can_edit_api_key: true, is_current: true, source: 'legacy' }]),
  listModelCatalog: vi.fn(async () => [
    { slug: 'opencode-free', name: 'OpenCode Free', models: ['free-a'], isCurrent: false },
    { slug: 'custom:tingly', name: 'tingly', models: ['omni'], isCurrent: true },
  ]),
  saveLegacyModelService: vi.fn(async () => undefined),
  saveModelService: vi.fn(async () => ({ endpoints: [], current: {} })),
  validateModelService: vi.fn(async () => ({ ok: true, reachable: true, message: '', models: ['model-a', 'model-b'] })),
  activateModelService: vi.fn(async () => undefined),
  deleteModelService: vi.fn(async () => undefined),
  getDuplexVoiceSettings: vi.fn(async () => ({ hasApiKey: true, voices: [{ id: 'voice-a', name: '音色 A' }], currentVoiceId: 'voice-a', updatedAt: 1 })),
  saveDuplexVoiceSettings: vi.fn(async input => ({ hasApiKey: true, ...input, updatedAt: 2 })),
}))

const profile = { name: 'default', displayName: '丫头', isDefault: true }
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.clearAllMocks() })

describe('Agent management dialog', () => {
  it('keeps non-admin users on identity management only', async () => {
    const wrapper = mount(AgentIdentityDialog, { attachTo: document.body, props: { open: true, profile, isAdmin: false } })
    await nextTick()
    expect(document.querySelector('[aria-label="Agent 管理"]')?.textContent).toContain('Bots 头像')
    expect(document.querySelector('.management-tabs')).toBeNull()
    expect(document.body.textContent).not.toContain('模型服务')
    wrapper.unmount()
  })

  it('shows admin model and global duplex voice panels', async () => {
    const wrapper = mount(AgentIdentityDialog, { attachTo: document.body, props: { open: true, profile, isAdmin: true } })
    await nextTick()
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.management-tabs button')]
    expect(tabs.map(tab => tab.textContent)).toEqual(['身份', '模型服务', '双流语音'])

    tabs[1]!.click(); await flushPromises()
    expect(document.body.textContent).toContain('9119 Provider 与模型')
    expect(document.body.textContent).toContain('OpenCode Free')
    expect(document.body.textContent).toContain('custom:tingly')
    expect(document.body.textContent).toContain('只读')

    document.querySelectorAll<HTMLButtonElement>('.management-tabs button')[2]!.click(); await nextTick(); await nextTick()
    expect(document.body.textContent).toContain('整个 yaoyao 安装共享的全局设置')
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.placeholder).toContain('留空保持不变')
    wrapper.unmount()
  })

  it('discovers and saves a model service without overwriting an unchanged secret', async () => {
    const wrapper = mount(AgentIdentityDialog, { attachTo: document.body, props: { open: true, profile, isAdmin: true } })
    await nextTick()
    document.querySelectorAll<HTMLButtonElement>('.management-tabs button')[1]!.click(); await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('新增服务'))!.click()
    await nextTick()
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.service-editor input:not([type="checkbox"])')]
    for (const [input, value] of [[inputs[0], 'Local'], [inputs[1], 'http://127.0.0.1:9000/v1'], [inputs[2], 'model-a']] as const) {
      input!.value = value; input!.dispatchEvent(new Event('input'))
    }
    ;[...document.querySelectorAll<HTMLButtonElement>('.service-editor button')].find(button => button.textContent?.includes('测试连接'))!.click()
    await nextTick(); await nextTick()
    expect(validateModelService).toHaveBeenCalledOnce()
    expect(document.querySelector<HTMLTextAreaElement>('.service-editor textarea')?.value).toContain('model-b')
    ;[...document.querySelectorAll<HTMLButtonElement>('.service-editor button')].find(button => button.textContent?.includes('保存模型服务'))!.click()
    await nextTick(); await nextTick()
    expect(saveModelService).toHaveBeenCalledOnce()
    expect(vi.mocked(saveModelService).mock.calls[0]?.[1]).not.toHaveProperty('api_key')
    wrapper.unmount()
  })

  it('edits an existing legacy custom provider and replaces its visible model list', async () => {
    const wrapper = mount(AgentIdentityDialog, { attachTo: document.body, props: { open: true, profile, isAdmin: true } })
    await nextTick()
    document.querySelectorAll<HTMLButtonElement>('.management-tabs button')[1]!.click(); await flushPromises()
    const legacyCard = [...document.querySelectorAll<HTMLElement>('.service-card')].find(card => card.textContent?.includes('custom:tingly'))!
    legacyCard.querySelector<HTMLButtonElement>('button')!.click(); await nextTick()
    const modelInput = document.querySelectorAll<HTMLInputElement>('.service-editor input:not([type="checkbox"])')[2]!
    modelInput.value = 'omni-2'; modelInput.dispatchEvent(new Event('input'))
    const models = document.querySelector<HTMLTextAreaElement>('.service-editor textarea')!
    models.value = 'omni\nomni-2'; models.dispatchEvent(new Event('input'))
    document.querySelector<HTMLFormElement>('.service-editor')!.dispatchEvent(new Event('submit'))
    await nextTick(); await nextTick()
    expect(saveLegacyModelService).toHaveBeenCalledWith('default', 'custom:tingly', expect.objectContaining({ model: 'omni-2', models: ['omni', 'omni-2'] }))
    wrapper.unmount()
  })

  it('confirms model deletion and rejects duplicate duplex voice ids', async () => {
    vi.mocked(listModelServices).mockResolvedValueOnce({ endpoints: [{ id: 'local', name: 'Local', base_url: 'http://127.0.0.1:9000/v1', model: 'model-a', models: ['model-a'], discover_models: true, has_api_key: true, is_current: false }], current: { provider: '', model: '', base_url: '' } })
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const wrapper = mount(AgentIdentityDialog, { attachTo: document.body, props: { open: true, profile, isAdmin: true } })
    await nextTick()
    document.querySelectorAll<HTMLButtonElement>('.management-tabs button')[1]!.click(); await flushPromises()
    const deleteButton = [...document.querySelectorAll<HTMLButtonElement>('.service-card button')].find(button => button.textContent === '删除')!
    deleteButton.click(); await nextTick()
    expect(deleteModelService).not.toHaveBeenCalled()
    deleteButton.click(); await nextTick(); await nextTick()
    expect(deleteModelService).toHaveBeenCalledWith('default', 'local')

    vi.mocked(saveDuplexVoiceSettings).mockClear()
    document.querySelectorAll<HTMLButtonElement>('.management-tabs button')[2]!.click(); await nextTick(); await nextTick()
    ;[...document.querySelectorAll<HTMLButtonElement>('.voice-list-heading button')][0]!.click(); await nextTick()
    const idInputs = [...document.querySelectorAll<HTMLInputElement>('.voice-row label:first-child input')]
    idInputs[1]!.value = idInputs[0]!.value; idInputs[1]!.dispatchEvent(new Event('input'))
    document.querySelector<HTMLFormElement>('.voice-panel form')!.dispatchEvent(new Event('submit'))
    await nextTick()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('音色 ID 重复')
    expect(saveDuplexVoiceSettings).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

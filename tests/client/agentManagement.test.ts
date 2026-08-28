import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateModelService,
  deleteModelService,
  getDuplexVoiceSettings,
  listLegacyModelServices,
  listModelCatalog,
  listModelServices,
  saveDuplexVoiceSettings,
  saveLegacyModelService,
  saveModelService,
  validateModelService,
} from '@/api/agentManagement'
import { setApiCsrfToken } from '@/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
  setApiCsrfToken('')
})

describe('Agent management client protocol', () => {
  it('uses profile-scoped admin routes and preserves omitted model secrets', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return Response.json({ endpoints: [], current: {}, ok: true, reachable: true, message: '', models: [] })
    }))
    setApiCsrfToken('csrf-agent-management')
    const input = { name: 'Local', base_url: 'http://127.0.0.1:9000/v1', model: 'local-model', discover_models: true, make_default: false }

    await listModelServices('worker / 中文')
    await listModelCatalog('worker / 中文')
    await listLegacyModelServices('worker / 中文')
    await saveModelService('worker / 中文', input)
    await saveLegacyModelService('worker / 中文', 'custom:tingly', input)
    await validateModelService(input)
    await activateModelService('worker / 中文', 'local/model')
    await deleteModelService('worker / 中文', 'local/model')

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/admin/model-services?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/models?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/admin/legacy-model-services?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/admin/model-services?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/admin/legacy-model-services/custom%3Atingly?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/admin/model-services/validate',
      '/api/app/admin/model-services/local%2Fmodel/activate?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
      '/api/app/admin/model-services/local%2Fmodel?profile=worker%20%2F%20%E4%B8%AD%E6%96%87',
    ])
    expect(JSON.parse(String(calls[3]!.init?.body))).not.toHaveProperty('api_key')
    expect(new Headers(calls[3]!.init?.headers).get('X-CSRF-Token')).toBe('csrf-agent-management')
    expect(calls[7]!.init?.method).toBe('DELETE')
  })

  it('never includes an unchanged duplex API key', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return Response.json({ hasApiKey: true, voices: [{ id: 'voice-1', name: 'Voice' }], currentVoiceId: 'voice-1', updatedAt: 1 })
    }))
    setApiCsrfToken('csrf-voice')
    await getDuplexVoiceSettings()
    await saveDuplexVoiceSettings({ voices: [{ id: 'voice-1', name: 'Voice' }], currentVoiceId: 'voice-1' })

    expect(calls.map(call => call.path)).toEqual(['/api/app/admin/duplex-voice', '/api/app/admin/duplex-voice'])
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ voices: [{ id: 'voice-1', name: 'Voice' }], currentVoiceId: 'voice-1' })
  })
})

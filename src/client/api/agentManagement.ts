import type { JsonValue } from '@shared/types'
import { apiRequest } from './client'

export interface CustomModelService {
  id: string
  name: string
  base_url: string
  model: string
  models: string[]
  context_length?: number
  discover_models: boolean
  has_api_key: boolean
  api_key_preview?: string
  is_current: boolean
  source?: string
}

export interface CustomModelServicesResponse {
  endpoints: CustomModelService[]
  current: { provider: string; model: string; base_url: string }
  ok?: boolean
  id?: string
}

export interface CustomModelServiceInput {
  id?: string
  name: string
  base_url: string
  model: string
  api_key?: string
  context_length?: number
  discover_models: boolean
  make_default: boolean
  models?: string[]
}

export interface ModelServiceValidation {
  ok: boolean
  reachable: boolean
  message: string
  models: string[]
}

export interface ModelCatalogProvider {
  slug: string
  name: string
  models: string[]
  isCurrent: boolean
}

export interface LegacyModelService extends CustomModelService {
  source: 'legacy'
  can_edit_api_key: boolean
}

export interface DuplexVoice {
  id: string
  name: string
}

export interface DuplexVoiceSettings {
  hasApiKey: boolean
  voices: DuplexVoice[]
  currentVoiceId: string
  updatedAt: number
}

function profileQuery(profile: string): string {
  return `?profile=${encodeURIComponent(profile)}`
}

export function listModelServices(profile: string): Promise<CustomModelServicesResponse> {
  return apiRequest(`/api/app/admin/model-services${profileQuery(profile)}`)
}

export async function listModelCatalog(profile: string): Promise<ModelCatalogProvider[]> {
  const payload = await apiRequest<{ providers?: unknown[] }>(`/api/app/models${profileQuery(profile)}`)
  return (payload.providers || []).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const provider = raw as Record<string, unknown>
    const slug = typeof provider.slug === 'string' ? provider.slug.trim() : ''
    if (!slug) return []
    return [{
      slug,
      name: typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim() : slug,
      models: Array.isArray(provider.models) ? provider.models.map(String).map(item => item.trim()).filter(Boolean) : [],
      isCurrent: provider.is_current === true,
    }]
  })
}

export async function listLegacyModelServices(profile: string): Promise<LegacyModelService[]> {
  const response = await apiRequest<{ items?: LegacyModelService[] }>(`/api/app/admin/legacy-model-services${profileQuery(profile)}`)
  return response.items || []
}

export function saveLegacyModelService(profile: string, id: string, input: CustomModelServiceInput): Promise<void> {
  return apiRequest(`/api/app/admin/legacy-model-services/${encodeURIComponent(id)}${profileQuery(profile)}`, {
    method: 'PUT', body: input as unknown as JsonValue,
  })
}

export function saveModelService(profile: string, input: CustomModelServiceInput): Promise<CustomModelServicesResponse> {
  return apiRequest(`/api/app/admin/model-services${profileQuery(profile)}`, {
    method: 'POST', body: input as unknown as JsonValue,
  })
}

export function validateModelService(input: CustomModelServiceInput): Promise<ModelServiceValidation> {
  return apiRequest('/api/app/admin/model-services/validate', {
    method: 'POST', body: input as unknown as JsonValue, timeoutMs: 15_000,
  })
}

export function activateModelService(profile: string, id: string): Promise<void> {
  return apiRequest(`/api/app/admin/model-services/${encodeURIComponent(id)}/activate${profileQuery(profile)}`, {
    method: 'POST', body: {},
  })
}

export function deleteModelService(profile: string, id: string): Promise<void> {
  return apiRequest(`/api/app/admin/model-services/${encodeURIComponent(id)}${profileQuery(profile)}`, {
    method: 'DELETE', body: {},
  })
}

export function getDuplexVoiceSettings(): Promise<DuplexVoiceSettings> {
  return apiRequest('/api/app/admin/duplex-voice')
}

export function saveDuplexVoiceSettings(input: {
  apiKey?: string
  voices: DuplexVoice[]
  currentVoiceId: string
}): Promise<DuplexVoiceSettings> {
  return apiRequest('/api/app/admin/duplex-voice', {
    method: 'PUT', body: input as unknown as JsonValue,
  })
}

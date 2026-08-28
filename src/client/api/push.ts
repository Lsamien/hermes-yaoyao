import { apiRequest } from './client'
import { bool, number, record, string, values } from '@/utils/normalize'

export interface PushCapabilities {
  protocolVersion: number
  enabled: boolean
  topic?: string
  previewMode?: string
  events: string[]
  maxSummaryCharacters: number
}

export type APNsEnvironment = 'development' | 'production'
export type PushConfigSource = 'none' | 'file' | 'environment'

export interface PushConfigWarning {
  code: string
  message: string
  actualMode?: string
  recommendedMode?: string
}

export interface PushSystemConfigInput {
  keyFile: string
  keyId: string
  teamId: string
  topic: string
  environments: APNsEnvironment[]
}

export interface PushSystemStatus {
  configured: boolean
  healthy: boolean
  topic?: string
  registrationCount: number
  pendingCount: number
  lastSuccessAt?: number
  lastError?: string
  source: PushConfigSource
  editable: boolean
  managementAvailable: boolean
  keyFile?: string
  keyId?: string
  teamId?: string
  environments: APNsEnvironment[]
  warnings: PushConfigWarning[]
}

function normalizeEnvironment(value: unknown): APNsEnvironment | undefined {
  return value === 'development' || value === 'production' ? value : undefined
}

function normalizePushSystemStatus(value: unknown): PushSystemStatus {
  const payload = record(value)
  const rawSource = string(payload.source ?? payload.configurationSource ?? payload.configuration_source)
  const source: PushConfigSource = rawSource === 'file' || rawSource === 'environment' ? rawSource : 'none'
  const managementAvailable = rawSource === 'none' || rawSource === 'file' || rawSource === 'environment'
    ? true
    : bool(payload.managementAvailable ?? payload.management_available, false)
  const environments = values(payload.environments ?? payload.environment)
    .map(normalizeEnvironment)
    .filter((environment): environment is APNsEnvironment => Boolean(environment))
  const warnings = values(payload.warnings).flatMap((value): PushConfigWarning[] => {
    if (typeof value === 'string' && value.trim()) return [{ code: 'warning', message: value.trim() }]
    const warning = record(value)
    const message = string(warning.message).trim()
    if (!message) return []
    return [{
      code: string(warning.code, 'warning'),
      message,
      actualMode: string(warning.actualMode ?? warning.actual_mode) || undefined,
      recommendedMode: string(warning.recommendedMode ?? warning.recommended_mode) || undefined,
    }]
  })
  return {
    configured: bool(payload.configured),
    healthy: bool(payload.healthy),
    topic: string(payload.topic) || undefined,
    registrationCount: number(payload.registrationCount ?? payload.registration_count),
    pendingCount: number(payload.pendingCount ?? payload.pending_count),
    lastSuccessAt: number(payload.lastSuccessAt ?? payload.last_success_at) || undefined,
    lastError: string(
      payload.lastError ?? payload.last_error ?? payload.configurationError ?? payload.configuration_error,
    ) || undefined,
    source,
    editable: managementAvailable && bool(payload.editable),
    managementAvailable,
    keyFile: string(payload.keyFile ?? payload.key_file) || undefined,
    keyId: string(payload.keyId ?? payload.key_id) || undefined,
    teamId: string(payload.teamId ?? payload.team_id) || undefined,
    environments,
    warnings,
  }
}

export async function getPushCapabilities(): Promise<PushCapabilities> {
  const payload = record(await apiRequest<unknown>('/api/app/push/v1/capabilities'))
  return {
    protocolVersion: number(payload.protocolVersion ?? payload.protocol_version),
    enabled: bool(payload.enabled),
    topic: string(payload.topic) || undefined,
    previewMode: string(payload.previewMode ?? payload.preview_mode) || undefined,
    events: values(payload.events).map(String).filter(Boolean),
    maxSummaryCharacters: number(
      payload.maxSummaryCharacters ?? payload.maximumSummaryCharacters ?? payload.max_summary_characters,
      180,
    ),
  }
}

export async function getGroupPushSubscriptions(): Promise<Set<string>> {
  const payload = record(await apiRequest<unknown>('/api/app/push/v1/group-subscriptions'))
  const roomIds = values(payload.roomIds ?? payload.room_ids ?? payload.subscriptions ?? payload.items)
    .map(value => typeof value === 'string' ? value : string(record(value).roomId ?? record(value).room_id))
    .filter(Boolean)
  return new Set(roomIds)
}

export async function setGroupPushSubscription(roomId: string, enabled: boolean): Promise<boolean> {
  const payload = record(await apiRequest<unknown>(`/api/app/push/v1/group-subscriptions/${encodeURIComponent(roomId)}`, {
    method: 'PUT', body: { enabled },
  }))
  const subscription = record(payload.subscription)
  return typeof payload.enabled === 'boolean'
    ? payload.enabled
    : typeof subscription.enabled === 'boolean' ? subscription.enabled : enabled
}

export async function getPushSystemStatus(): Promise<PushSystemStatus> {
  return normalizePushSystemStatus(await apiRequest<unknown>('/api/app/system/push-status'))
}

export async function savePushSystemConfig(input: PushSystemConfigInput): Promise<PushSystemStatus> {
  return normalizePushSystemStatus(await apiRequest<unknown>('/api/app/system/push-config', {
    method: 'PUT',
    body: {
      keyFile: input.keyFile,
      keyId: input.keyId,
      teamId: input.teamId,
      topic: input.topic,
      environments: input.environments,
    },
    timeoutMs: 45_000,
  }))
}

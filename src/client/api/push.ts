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

export interface PushSystemStatus {
  configured: boolean
  healthy: boolean
  topic?: string
  registrationCount: number
  pendingCount: number
  lastSuccessAt?: number
  lastError?: string
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
  const payload = record(await apiRequest<unknown>('/api/app/system/push-status'))
  return {
    configured: bool(payload.configured),
    healthy: bool(payload.healthy),
    topic: string(payload.topic) || undefined,
    registrationCount: number(payload.registrationCount ?? payload.registration_count),
    pendingCount: number(payload.pendingCount ?? payload.pending_count),
    lastSuccessAt: number(payload.lastSuccessAt ?? payload.last_success_at) || undefined,
    lastError: string(payload.lastError ?? payload.last_error) || undefined,
  }
}

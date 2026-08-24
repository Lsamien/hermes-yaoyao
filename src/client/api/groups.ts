import type {
  GroupAgent, GroupCapabilities, GroupInteraction, GroupMessagePage, GroupRoomDetail, GroupRoomPage, GroupRun, GroupTopicPage, GroupTopicSummary, JsonValue, UploadReference,
} from '@shared/types'
import { apiRequest, apiUrl, unwrapData } from './client'
import {
  normalizeGroupAgent, normalizeGroupCapabilities, normalizeGroupInteraction, normalizeGroupMessage,
  normalizeGroupRoom, normalizeGroupRoomDetail, normalizeGroupRun, normalizeGroupTopic, record, values,
} from '@/utils/normalize'
import { createUuid } from '@/utils/id'

const BASE = '/api/app/groups'

function requestId(): string { return createUuid() }

export async function getGroupCapabilities(): Promise<GroupCapabilities> {
  return normalizeGroupCapabilities(unwrapData(await apiRequest<unknown>(`${BASE}/capabilities`)))
}

export async function getGroupRooms(cursor?: string, limit = 50, archived = false): Promise<GroupRoomPage> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl(`${BASE}/rooms`, { cursor, limit: Math.max(1, Math.min(100, limit)), archived })))
  const source = record(payload)
  return {
    items: values(source.items ?? source.rooms ?? payload).map(normalizeGroupRoom).filter(room => room.id),
    nextCursor: typeof source.nextCursor === 'string' ? source.nextCursor : typeof source.next_cursor === 'string' ? source.next_cursor : null,
  }
}

export async function getGroupRoom(roomId: string): Promise<GroupRoomDetail> {
  return normalizeGroupRoomDetail(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}`)))
}

export async function getGroupTopics(roomId: string, cursor?: string, limit = 50, archived = false): Promise<GroupTopicPage> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl(`${BASE}/rooms/${encodeURIComponent(roomId)}/topics`, {
    cursor, limit: Math.max(1, Math.min(100, limit)), archived,
  })))
  const source = record(payload)
  return {
    items: values(source.items ?? source.topics ?? payload).map(normalizeGroupTopic).filter(topic => topic.id && topic.roomId),
    nextCursor: typeof source.nextCursor === 'string' ? source.nextCursor : typeof source.next_cursor === 'string' ? source.next_cursor : null,
  }
}

export async function getPinnedGroupTopics(limit = 100): Promise<GroupTopicPage> {
  const payload = unwrapData(await apiRequest<unknown>(apiUrl(`${BASE}/topics/pinned`, { limit: Math.max(1, Math.min(100, limit)) })))
  const source = record(payload)
  return { items: values(source.items ?? source.topics ?? payload).map(normalizeGroupTopic).filter(topic => topic.id && topic.roomId), nextCursor: null }
}

export async function updateGroupTopic(roomId: string, topicId: string, input: { title?: string; pinned?: boolean }): Promise<GroupTopicSummary> {
  return normalizeGroupTopic(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/topics/${encodeURIComponent(topicId)}`, {
    method: 'PATCH', body: { requestId: requestId(), ...input } as JsonValue,
  })))
}

export async function archiveGroupTopic(roomId: string, topicId: string): Promise<GroupTopicSummary> {
  return normalizeGroupTopic(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/topics/${encodeURIComponent(topicId)}`, {
    method: 'DELETE', body: { requestId: requestId() } as JsonValue,
  })))
}

export async function restoreGroupTopic(roomId: string, topicId: string): Promise<GroupTopicSummary> {
  return normalizeGroupTopic(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/topics/${encodeURIComponent(topicId)}/restore`, {
    method: 'POST', body: { requestId: requestId() } as JsonValue,
  })))
}

export async function markGroupTopicRead(roomId: string, topicId: string, throughSeq: number): Promise<void> {
  await apiRequest(`${BASE}/rooms/${encodeURIComponent(roomId)}/topics/${encodeURIComponent(topicId)}/read`, {
    method: 'PATCH', body: { requestId: requestId(), throughSeq } as JsonValue,
  })
}

export interface AgentSeed {
  profile: string
  displayName: string
  description?: string
  replyWithoutMention?: boolean
  isHost?: boolean
  model?: string | null
  provider?: string | null
  reasoningEffort?: string | null
  fastMode?: boolean | null
}

export async function createGroupRoom(input: { name: string; cwd?: string; agents: AgentSeed[]; maxReplyRounds?: number; orchestrationMode?: 'free' | 'host' }): Promise<GroupRoomDetail> {
  return normalizeGroupRoomDetail(unwrapData(await apiRequest<unknown>(`${BASE}/rooms`, {
    method: 'POST', body: { requestId: requestId(), cwd: '', maxReplyRounds: 3, ...input } as unknown as JsonValue,
  })))
}

export async function updateGroupRoom(roomId: string, input: { name?: string; cwd?: string; maxReplyRounds?: number; orchestrationMode?: 'free' | 'host' }): Promise<GroupRoomDetail> {
  return normalizeGroupRoomDetail(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH', body: { requestId: requestId(), ...input } as JsonValue,
  })))
}

export async function archiveGroupRoom(roomId: string): Promise<GroupRoomDetail> {
  return normalizeGroupRoomDetail(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE', body: { requestId: requestId() },
  })))
}

export async function restoreGroupRoom(roomId: string): Promise<GroupRoomDetail> {
  return normalizeGroupRoomDetail(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/restore`, {
    method: 'POST', body: { requestId: requestId() } as JsonValue,
  })))
}

export async function addGroupAgent(roomId: string, input: AgentSeed): Promise<GroupAgent> {
  return normalizeGroupAgent(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/agents`, {
    method: 'POST', body: { requestId: requestId(), description: '', replyWithoutMention: false, ...input } as JsonValue,
  })))
}

export async function updateGroupAgent(roomId: string, agentId: string, input: Partial<Omit<AgentSeed, 'profile'>> & { enabled?: boolean }): Promise<GroupAgent> {
  return normalizeGroupAgent(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH', body: { requestId: requestId(), ...input } as JsonValue,
  })))
}

export async function removeGroupAgent(roomId: string, agentId: string): Promise<GroupAgent> {
  return normalizeGroupAgent(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE', body: { requestId: requestId() },
  })))
}

export async function interruptGroupAgent(roomId: string, agentId: string): Promise<unknown> {
  return unwrapData(await apiRequest(`${BASE}/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/interrupt`, {
    method: 'POST', body: { requestId: requestId() },
  }))
}

export async function getGroupMessages(roomId: string, options: { topicId?: string; beforeSeq?: number; afterSeq?: number; limit?: number } = {}): Promise<GroupMessagePage> {
  if (options.beforeSeq && options.afterSeq) throw new Error('beforeSeq 与 afterSeq 不能同时使用')
  const payload = unwrapData(await apiRequest<unknown>(apiUrl(`${BASE}/rooms/${encodeURIComponent(roomId)}/messages`, {
    topicId: options.topicId, beforeSeq: options.beforeSeq, afterSeq: options.afterSeq, limit: Math.max(1, Math.min(100, options.limit ?? 100)),
  })))
  const source = record(payload)
  return { items: values(source.items ?? source.messages ?? payload).map(normalizeGroupMessage).filter(message => message.id) }
}

export async function sendGroupMessage(
  roomId: string,
  content: string,
  mentionAgentIds: string[],
  clientMessageId: string,
  topicId?: string,
  uploadIds: string[] = [],
  stableRequestId = requestId(),
): Promise<{ message: ReturnType<typeof normalizeGroupMessage>; runs: GroupRun[] }> {
  const payload = record(unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST', body: { requestId: stableRequestId, clientMessageId, topicId, content, mentionAgentIds, uploadIds } as JsonValue,
  })))
  return { message: normalizeGroupMessage(payload.message), runs: values(payload.runs).map(normalizeGroupRun).filter(run => run.id) }
}

export async function approveGroupInteraction(roomId: string, interactionId: string, choice: 'once' | 'session' | 'always' | 'deny'): Promise<GroupInteraction | unknown> {
  const payload = unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/interactions/${encodeURIComponent(interactionId)}/approval`, {
    method: 'POST', body: { requestId: requestId(), choice, permanent: choice === 'always' },
  }))
  const source = record(payload)
  return source.interaction ? normalizeGroupInteraction(source.interaction) : payload
}

export async function clarifyGroupInteraction(roomId: string, interactionId: string, response: string): Promise<GroupInteraction | unknown> {
  const payload = unwrapData(await apiRequest<unknown>(`${BASE}/rooms/${encodeURIComponent(roomId)}/interactions/${encodeURIComponent(interactionId)}/clarification`, {
    method: 'POST', body: { requestId: requestId(), response },
  }))
  const source = record(payload)
  return source.interaction ? normalizeGroupInteraction(source.interaction) : payload
}

export async function uploadGroupFiles(roomId: string, files: File[]): Promise<UploadReference[]> {
  const form = new FormData()
  form.set('roomId', roomId)
  for (const file of files) form.append('files', file, file.name)
  const payload = unwrapData(await apiRequest<unknown>('/api/app/group-uploads', {
    method: 'POST', body: form, timeoutMs: 120_000,
  }))
  const source = record(payload)
  return values(source.files ?? source.items ?? source.uploads ?? payload).map(value => {
    const item = record(value)
    return {
      id: String(item.id ?? ''), name: String(item.name ?? item.filename ?? ''),
      mimeType: String(item.mimeType ?? item.mime_type ?? 'application/octet-stream'),
      size: Number(item.size ?? 0), markdown: typeof item.markdown === 'string' ? item.markdown : undefined,
      refText: typeof item.refText === 'string' ? item.refText : typeof item.ref_text === 'string' ? item.ref_text : undefined,
    }
  }).filter(item => item.id && item.name)
}

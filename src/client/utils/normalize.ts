import type {
  ChatAttachment,
  ChatMessage,
  CurrentUser,
  FileKind,
  FileLibraryItem,
  GroupAgent,
  GroupCapabilities,
  GroupInteraction,
  GroupMessage,
  GroupRoomDetail,
  GroupRoomSummary,
  JsonValue,
  ModelOption,
  Profile,
  SessionSummary,
  ToolCall,
} from '@shared/types'

export type UnknownRecord = Record<string, unknown>

export function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function string(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

export function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return fallback
}

export function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pick(source: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key]
  return undefined
}

export function normalizeUser(value: unknown): CurrentUser {
  const source = record(value)
  const id = string(pick(source, 'id', 'user_id', 'userId')) || string(pick(source, 'email', 'username')) || 'local'
  return {
    id,
    username: string(pick(source, 'username', 'display_name', 'displayName', 'email', 'user_id', 'userId'), id),
    displayName: string(pick(source, 'display_name', 'displayName')) || undefined,
    email: string(source.email) || undefined,
    provider: string(source.provider) || undefined,
    role: string(source.role) || undefined,
  }
}

export function normalizeProfile(value: unknown): Profile {
  const source = record(value)
  const name = string(pick(source, 'name', 'profile', 'id'), 'default')
  return {
    name,
    agentName: string(pick(source, 'agentName', 'agent_name')) || undefined,
    displayName: string(pick(source, 'display_name', 'displayName', 'alias', 'description')) || undefined,
    description: string(source.description) || undefined,
    isDefault: bool(pick(source, 'is_default', 'isDefault', 'active')),
    model: string(source.model) || undefined,
    provider: string(source.provider) || undefined,
    gatewayRunning: source.gateway_running === undefined && source.gatewayRunning === undefined
      ? undefined
      : bool(pick(source, 'gateway_running', 'gatewayRunning')),
    avatar: string(source.avatar) || undefined,
  }
}

export function normalizeModel(value: unknown): ModelOption {
  const source = record(value)
  const provider = string(source.provider)
  const id = string(pick(source, 'id', 'model', 'value'))
  return {
    id,
    name: string(pick(source, 'name', 'display_name', 'displayName'), id),
    provider,
    supportsReasoning: source.supports_reasoning === undefined && source.supportsReasoning === undefined
      ? undefined
      : bool(pick(source, 'supports_reasoning', 'supportsReasoning')),
    reasoningEfforts: values(pick(source, 'reasoning_efforts', 'reasoningEfforts')).map(value => string(value)).filter(Boolean),
    isDefault: bool(pick(source, 'is_default', 'isDefault')),
  }
}

export function normalizeSession(value: unknown, fallbackProfile?: string): SessionSummary {
  const source = record(value)
  const startedAt = number(pick(source, 'started_at', 'startedAt', 'created_at', 'createdAt'))
  const updatedAt = number(pick(source, 'last_active', 'lastActive', 'updated_at', 'updatedAt'), startedAt)
  const id = string(pick(source, 'id', 'session_id', 'sessionId', 'stored_session_id', 'storedSessionId'))
  return {
    id,
    profile: string(source.profile, fallbackProfile) || undefined,
    source: string(source.source, 'cli'),
    title: string(source.title, '未命名会话'),
    preview: string(source.preview) || undefined,
    model: string(source.model) || undefined,
    provider: string(source.provider) || undefined,
    agent: string(source.agent) || undefined,
    messageCount: number(pick(source, 'message_count', 'messageCount')),
    toolCallCount: number(pick(source, 'tool_call_count', 'toolCallCount')),
    inputTokens: number(pick(source, 'input_tokens', 'inputTokens')) || undefined,
    outputTokens: number(pick(source, 'output_tokens', 'outputTokens')) || undefined,
    startedAt,
    updatedAt,
    endedAt: pick(source, 'ended_at', 'endedAt') == null ? null : number(pick(source, 'ended_at', 'endedAt')),
    parentSessionId: string(pick(source, 'parent_session_id', 'parentSessionId')) || null,
    forkPointMessageId: string(pick(source, 'fork_point_message_id', 'forkPointMessageId')) || null,
    workspace: string(source.workspace) || null,
    archived: bool(pick(source, 'is_archived', 'isArchived', 'archived')),
    pinned: bool(pick(source, 'is_pinned', 'isPinned', 'pinned')),
  }
}

function normalizeToolCall(value: unknown, index: number): ToolCall {
  const source = record(value)
  const functionCall = record(source.function)
  const error = string(source.error)
  const result = pick(source, 'result', 'output') as JsonValue | undefined
  return {
    id: string(pick(source, 'id', 'tool_call_id', 'toolCallId', 'tool_id'), `tool-${index}`),
    name: string(pick(source, 'name', 'tool_name', 'toolName') ?? functionCall.name, '工具'),
    status: error ? 'failed' : result !== undefined ? 'completed' : 'running',
    arguments: (pick(source, 'arguments', 'args', 'context') ?? functionCall.arguments) as JsonValue | undefined,
    result,
    preview: string(pick(source, 'preview', 'summary', 'args_text')) || undefined,
    error: error || undefined,
    durationSeconds: number(pick(source, 'duration_seconds', 'durationSeconds', 'duration_s')) || undefined,
  }
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string') return value as JsonValue | undefined
  try { return JSON.parse(value) as JsonValue } catch { return undefined }
}

export function normalizeAttachment(value: unknown, index = 0): ChatAttachment {
  const source = record(value)
  const mimeType = string(pick(source, 'mime_type', 'mimeType', 'media_type', 'mediaType'), 'application/octet-stream')
  const name = string(pick(source, 'name', 'filename'), `附件 ${index + 1}`)
  return {
    id: string(source.id, `${name}:${index}`),
    name,
    mimeType,
    size: number(source.size),
    path: string(source.path) || undefined,
    url: string(source.url) || undefined,
    kind: mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' ? 'pdf' : 'file',
  }
}

function attachmentMime(name: string): { mimeType: string; kind: ChatAttachment['kind'] } {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase() || ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff'].includes(extension)) {
    return { mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`, kind: 'image' }
  }
  if (extension === 'pdf') return { mimeType: 'application/pdf', kind: 'pdf' }
  return { mimeType: 'application/octet-stream', kind: 'file' }
}

function persistedAttachmentUrl(path: string): string | undefined {
  if (path.startsWith('/')) return path
  const segments = path.split('/')
  if (segments[0] !== 'attachments' || segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined
  return `/${segments.map(encodeURIComponent).join('/')}`
}

function extractPersistedAttachments(content: string): { content: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = []
  const cleaned = content.replace(
    /\[用户附加\s*(文件|图片|PDF)\s*：\s*([^\]\r\n]+)\]\s*(?:\r?\n)?@file:\s*(`[^`\r\n]+`|'[^'\r\n]+'|"[^"\r\n]+"|(?:\\?\/)[^\r\n]+)/g,
    (_match, _type: string, rawName: string, rawPath: string) => {
      const name = rawName.trim()
      const path = rawPath.trim().replace(/\\\//g, '/').replace(/^[`'"]|[`'"]$/g, '')
      const url = persistedAttachmentUrl(path)
      if (!url) return _match
      const media = attachmentMime(name)
      attachments.push({ id: `persisted:${path}`, name, path, url, size: 0, ...media })
      return ''
    },
  ).replace(/\n{3,}/g, '\n\n').trim()
  return { content: cleaned, attachments }
}

export function normalizeChatMessage(value: unknown, sessionId: string, fallbackProfile?: string): ChatMessage {
  const source = record(value)
  const contentValue = pick(source, 'content', 'text', 'output')
  let content = typeof contentValue === 'string' ? contentValue : ''
  let attachments: ChatAttachment[] = values(pick(source, 'attachments', 'files')).map(normalizeAttachment)
  if (Array.isArray(contentValue)) {
    const textBlocks: string[] = []
    const attachmentBlocks: ChatAttachment[] = []
    contentValue.forEach((blockValue, index) => {
      const block = record(blockValue)
      const type = string(block.type)
      if (type === 'text') textBlocks.push(string(block.text))
      if (type === 'image' || type === 'file') attachmentBlocks.push(normalizeAttachment(block, index))
    })
    content = textBlocks.filter(Boolean).join('\n\n')
    attachments = [...attachments, ...attachmentBlocks]
  }
  const roleValue = string(source.role, 'assistant')
  const role = ['user', 'assistant', 'tool', 'system'].includes(roleValue) ? roleValue as ChatMessage['role'] : 'system'
  if (role === 'user' && content.includes('@file:')) {
    const persisted = extractPersistedAttachments(content)
    content = persisted.content
    const known = new Set(attachments.map(item => item.path || item.url || item.name))
    attachments.push(...persisted.attachments.filter(item => !known.has(item.path || item.url || item.name)))
  }
  const id = string(pick(source, 'id', 'message_id', 'messageId')) || `history-${sessionId}-${number(source.timestamp)}-${Math.random()}`
  const status = string(pick(source, 'status', 'finish_reason', 'finishReason'))
  return {
    id,
    serverMessageId: id,
    clientMessageId: string(pick(source, 'client_message_id', 'clientMessageId')) || undefined,
    sessionId,
    profile: string(source.profile, fallbackProfile) || undefined,
    role,
    content,
    reasoning: string(pick(source, 'reasoning', 'thinking', 'reasoning_content', 'reasoningContent')) || undefined,
    timestamp: number(pick(source, 'timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt'), Date.now() / 1000),
    sequence: number(pick(source, 'seq', 'sequence')) || undefined,
    stage: status === 'error' || source.error ? 'failed' : 'settled',
    error: string(source.error) || undefined,
    attachments: attachments.length ? attachments : undefined,
    toolCalls: values(typeof pick(source, 'tool_calls', 'toolCalls', 'tools') === 'string'
      ? (() => { try { return JSON.parse(String(pick(source, 'tool_calls', 'toolCalls', 'tools'))) } catch { return [] } })()
      : pick(source, 'tool_calls', 'toolCalls', 'tools')).map(normalizeToolCall),
    toolCallId: string(pick(source, 'tool_call_id', 'toolCallId')) || undefined,
    toolName: string(pick(source, 'tool_name', 'toolName')) || undefined,
    displayKind: string(pick(source, 'display_kind', 'displayKind')) || undefined,
    displayMetadata: parseJsonValue(pick(source, 'display_metadata', 'displayMetadata')),
    raw: value as JsonValue,
  }
}

export function normalizeGroupCapabilities(value: unknown): GroupCapabilities {
  const source = record(value)
  const limits = record(source.limits)
  return {
    protocolVersion: number(pick(source, 'protocolVersion', 'protocol_version')),
    journalEpoch: string(pick(source, 'journalEpoch', 'journal_epoch')),
    latestCursor: number(pick(source, 'latestCursor', 'latest_cursor')),
    limits: {
      maxAgentsPerRoom: number(pick(limits, 'maxAgentsPerRoom', 'max_agents_per_room'), 8),
      maxMessageBytes: number(pick(limits, 'maxMessageBytes', 'max_message_bytes'), 64 * 1024),
      maxToolStateBytes: number(pick(limits, 'maxToolStateBytes', 'max_tool_state_bytes')) || undefined,
      maxInteractionPayloadBytes: number(pick(limits, 'maxInteractionPayloadBytes', 'max_interaction_payload_bytes')) || undefined,
      maxMessagePageSize: number(pick(limits, 'maxMessagePageSize', 'max_message_page_size'), 100),
      maxEventBatchSize: number(pick(limits, 'maxEventBatchSize', 'max_event_batch_size')) || undefined,
      maxAgentDepth: number(pick(limits, 'maxAgentDepth', 'max_agent_depth')) || undefined,
      maxRoomConcurrency: number(pick(limits, 'maxRoomConcurrency', 'max_room_concurrency')) || undefined,
      maxPluginConcurrency: number(pick(limits, 'maxPluginConcurrency', 'max_plugin_concurrency')) || undefined,
      defaultMaxReplyRounds: number(pick(limits, 'defaultMaxReplyRounds', 'default_max_reply_rounds'), 3),
      unlimitedReplyRoundsValue: number(pick(limits, 'unlimitedReplyRoundsValue', 'unlimited_reply_rounds_value'), -1),
      maxAgentDisplayNameLength: number(pick(limits, 'maxAgentDisplayNameLength', 'max_agent_display_name_length'), 100),
    },
    eventTypes: values(pick(source, 'eventTypes', 'event_types')).map(value => string(value)).filter(Boolean),
  }
}

export function normalizeGroupAgent(value: unknown): GroupAgent {
  const source = record(value)
  const status = string(source.status, 'unknown') as GroupAgent['status']
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    profile: string(source.profile), displayName: string(pick(source, 'displayName', 'display_name'), string(source.profile)),
    description: string(source.description), storedSessionId: string(pick(source, 'storedSessionId', 'stored_session_id')) || null,
    lastContextMessageSeq: number(pick(source, 'lastContextMessageSeq', 'last_context_message_seq')),
    enabled: bool(source.enabled, true), replyWithoutMention: bool(pick(source, 'replyWithoutMention', 'reply_without_mention')),
    createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
    status: ['idle', 'queued', 'running', 'awaiting_input'].includes(status) ? status : 'unknown',
  }
}

export function normalizeGroupMessage(value: unknown): GroupMessage {
  const source = record(value)
  const senderKind = string(pick(source, 'senderKind', 'sender_kind'), 'unknown') as GroupMessage['senderKind']
  const status = string(source.status, 'unknown') as GroupMessage['status']
  return {
    seq: number(source.seq), id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    senderKind: ['human', 'agent', 'system'].includes(senderKind) ? senderKind : 'unknown',
    senderId: string(pick(source, 'senderId', 'sender_id')), senderName: string(pick(source, 'senderName', 'sender_name')),
    rootMessageId: string(pick(source, 'rootMessageId', 'root_message_id')), replyToMessageId: string(pick(source, 'replyToMessageId', 'reply_to_message_id')) || null,
    clientMessageId: string(pick(source, 'clientMessageId', 'client_message_id')) || null,
    content: string(source.content), reasoning: string(source.reasoning), toolState: values(pick(source, 'toolState', 'tool_state')) as JsonValue[],
    status: ['queued', 'streaming', 'completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown',
    error: string(source.error), createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
  }
}

export function normalizeGroupInteraction(value: unknown): GroupInteraction {
  const source = record(value)
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')), agentId: string(pick(source, 'agentId', 'agent_id')),
    runId: string(pick(source, 'runId', 'run_id')), kind: string(source.kind, 'unknown') as GroupInteraction['kind'],
    payload: (source.payload ?? null) as JsonValue, status: string(source.status, 'unknown') as GroupInteraction['status'],
    createdAt: number(pick(source, 'createdAt', 'created_at')), resolvedAt: pick(source, 'resolvedAt', 'resolved_at') == null ? null : number(pick(source, 'resolvedAt', 'resolved_at')),
  }
}

export function normalizeGroupRoom(value: unknown): GroupRoomSummary {
  const source = record(value)
  const rawAgents = source.agents
  return {
    id: string(source.id), name: string(source.name, '未命名群聊'), cwd: string(source.cwd),
    createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
    archived: bool(source.archived), agentCount: Array.isArray(rawAgents) ? rawAgents.length : number(pick(source, 'agentCount', 'agent_count')),
    lastMessage: source.lastMessage || source.last_message ? normalizeGroupMessage(pick(source, 'lastMessage', 'last_message')) : null,
    unreadCount: number(pick(source, 'unreadCount', 'unread_count')), maxReplyRounds: number(pick(source, 'maxReplyRounds', 'max_reply_rounds'), 3),
  }
}

export function normalizeGroupRoomDetail(value: unknown): GroupRoomDetail {
  const source = record(value)
  const summary = normalizeGroupRoom(source)
  return {
    id: summary.id, name: summary.name, cwd: summary.cwd, createdAt: summary.createdAt, updatedAt: summary.updatedAt,
    archived: summary.archived, maxReplyRounds: summary.maxReplyRounds,
    agents: values(source.agents).map(normalizeGroupAgent), runs: values(source.runs).map(run => record(run) as unknown as GroupRoomDetail['runs'][number]),
    pendingInteractions: values(pick(source, 'pendingInteractions', 'pending_interactions')).map(normalizeGroupInteraction),
    latestCursor: number(pick(source, 'latestCursor', 'latest_cursor')),
  }
}

export function inferFileKind(mimeType: string, name: string): FileKind {
  const mime = mimeType.toLowerCase().split(';')[0]
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|rtf|pages|numbers|key)$/i.test(name)) return 'document'
  return 'other'
}

export function normalizeFile(value: unknown, fallbackProfile?: string): FileLibraryItem {
  const source = record(value)
  const id = string(pick(source, 'id', 'fileId', 'file_id'))
  const mimeType = string(pick(source, 'mimeType', 'mime_type'), 'application/octet-stream')
  const name = string(source.name)
  const origins = values(source.origins).map(item => {
    const origin = record(item)
    return {
      id: origin.id as number | string | undefined,
      profile: string(origin.profile) || fallbackProfile || undefined,
      sessionId: string(pick(origin, 'sessionId', 'session_id')) || undefined,
      sessionTitle: string(pick(origin, 'sessionTitle', 'session_title')) || undefined,
      messageId: string(pick(origin, 'messageId', 'message_id')) || undefined,
      authorKind: string(pick(origin, 'authorKind', 'author_kind')) as FileLibraryItem['origins'][number]['authorKind'] || undefined,
      authorName: string(pick(origin, 'authorName', 'author_name')) || undefined,
      observedAt: number(pick(origin, 'observedAt', 'observed_at')) || undefined,
      originalPath: string(pick(origin, 'originalPath', 'original_path')) || undefined,
      referencePath: string(pick(origin, 'referencePath', 'reference_path')) || undefined,
    }
  })
  const profile = origins.find(origin => origin.profile)?.profile
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return {
    id, path: string(source.path), name, extension: string(pick(source, 'extension', 'extensionName', 'extension_name')),
    mimeType, size: number(source.size), modifiedAt: number(pick(source, 'modifiedAt', 'modified_at')),
    exists: bool(source.exists, true), availability: string(source.availability) as FileLibraryItem['availability'] || undefined,
    archiveStatus: string(pick(source, 'archiveStatus', 'archive_status')) || undefined,
    firstSeenAt: number(pick(source, 'firstSeenAt', 'first_seen_at')) || undefined,
    lastSeenAt: number(pick(source, 'lastSeenAt', 'last_seen_at')) || undefined,
    messageTimestamp: pick(source, 'messageTimestamp', 'message_timestamp') == null ? null : number(pick(source, 'messageTimestamp', 'message_timestamp')),
    origins, kind: inferFileKind(mimeType, name),
    previewUrl: string(pick(source, 'previewUrl', 'preview_url'))
      || `/api/app/files/${encodeURIComponent(id)}/preview${profileQuery}`,
    downloadUrl: string(pick(source, 'downloadUrl', 'download_url'))
      || `/api/app/files/${encodeURIComponent(id)}/download${profileQuery}`,
  }
}

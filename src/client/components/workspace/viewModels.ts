import type {
  ApprovalRequest,
  ChatMessage,
  ClarificationRequest,
  ConversationArtifact,
  FileLibraryItem,
  GroupAgent,
  GroupInteraction,
  GroupMessage,
  GroupRoomDetail,
  GroupRoomSummary,
  SessionSummary,
  ToolCall,
} from '@shared/types'
import type { SidebarItem } from '@/components/app/types'
import type { UiAgent, UiRoom } from '@/components/groups/types'
import type { UiLibraryItem } from '@/components/library/types'
import type { UiInteraction, UiMessage, UiMessageAttachment, UiToolCall } from '@/components/messages/types'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function formatRelative(value: number): string {
  const ms = value < 10_000_000_000 ? value * 1000 : value
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时`
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function historySection(value: number, pinned = false): string | undefined {
  if (pinned) return '已置顶'
  const ms = value < 10_000_000_000 ? value * 1000 : value
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (ms >= today.getTime()) return '今天'
  if (ms >= yesterday.getTime()) return '昨天'
  return '更早'
}

export function sessionSidebarItem(session: SessionSummary, unread = 0, agentName = ''): SidebarItem {
  return {
    id: session.id,
    title: session.title || '未命名会话',
    subtitle: session.preview || `${session.messageCount} 条消息`,
    meta: agentName || session.agent || formatRelative(session.updatedAt),
    section: historySection(session.updatedAt, session.pinned),
    icon: 'chat',
    pinned: session.pinned,
    unread,
  }
}

function toolToUi(tool: ToolCall): UiToolCall {
  const status: UiToolCall['status'] = tool.status === 'completed' ? 'success' : tool.status === 'failed' ? 'error' : tool.status
  return {
    id: tool.id,
    name: tool.name,
    status,
    input: tool.arguments,
    output: tool.error || tool.result || tool.preview,
    durationMs: tool.durationSeconds ? Math.round(tool.durationSeconds * 1000) : undefined,
  }
}

function toolResult(message: ChatMessage): unknown {
  const raw = record(message.raw)
  if (raw.result !== undefined) return raw.result
  if (raw.output !== undefined && typeof raw.output !== 'string') return raw.output
  try { return JSON.parse(message.content) } catch { return message.content || undefined }
}

export function chatMessageToUi(message: ChatMessage, agentNameFor?: (profile?: string) => string | undefined): UiMessage {
  const attachments: UiMessageAttachment[] | undefined = message.attachments?.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind === 'image' ? 'image' : 'file',
    url: attachment.url,
    size: attachment.size,
  }))
  return {
    id: message.id,
    role: message.role,
    author: message.role === 'assistant' ? agentNameFor?.(message.profile) || message.profile : undefined,
    content: message.content,
    reasoning: message.reasoning,
    createdAt: message.timestamp < 10_000_000_000 ? message.timestamp * 1000 : message.timestamp,
    status: message.isStreaming ? 'streaming' : message.stage,
    error: message.error,
    attachments,
    tools: message.toolCalls?.map(toolToUi),
    profile: message.profile,
  }
}

/** Render only user and agent prose; tool result rows belong under their call. */
export function chatMessagesToUi(messages: ChatMessage[], agentNameFor?: (profile?: string) => string | undefined): UiMessage[] {
  const result: UiMessage[] = []
  const toolOwners = new Map<string, UiMessage>()
  let lastAssistant: UiMessage | undefined

  for (const message of messages) {
    if (message.role === 'tool') {
      const owner = (message.toolCallId && toolOwners.get(message.toolCallId)) || lastAssistant
      if (!owner) continue
      const id = message.toolCallId || message.id
      const tools = [...(owner.tools ?? [])]
      const index = tools.findIndex(tool => tool.id === id)
      const patch: UiToolCall = {
        id,
        name: message.toolName || tools[index]?.name || '工具',
        status: message.error ? 'error' : 'success',
        input: tools[index]?.input,
        output: message.error || toolResult(message),
      }
      if (index >= 0) tools[index] = { ...tools[index], ...patch }
      else tools.push(patch)
      owner.tools = tools
      if (message.toolCallId) toolOwners.set(message.toolCallId, owner)
      continue
    }
    // Gateway system rows are transport/protocol detail rather than chat
    // content. Keep the canvas focused on the user and participating agents.
    if (message.role === 'system') continue
    const ui = chatMessageToUi(message, agentNameFor)
    result.push(ui)
    if (message.role === 'assistant') {
      lastAssistant = ui
      for (const tool of ui.tools ?? []) toolOwners.set(tool.id, ui)
    }
  }
  return result
}

export function chatInteraction(approval?: ApprovalRequest, clarification?: ClarificationRequest): UiInteraction | null {
  if (approval) return {
    id: approval.id,
    kind: 'approval',
    title: approval.toolName ? `允许 ${approval.toolName}` : '允许这项操作',
    prompt: approval.message || 'Agent 请求执行一项需要确认的操作。',
    options: approval.choices,
    detail: JSON.stringify(approval.payload, null, 2),
  }
  if (clarification) return {
    id: clarification.id,
    kind: 'clarification',
    prompt: clarification.question,
    options: clarification.choices,
    detail: JSON.stringify(clarification.payload, null, 2),
  }
  return null
}

export function roomSidebarItem(room: GroupRoomSummary): SidebarItem {
  return {
    id: room.id,
    title: room.name || '未命名群聊',
    subtitle: room.lastMessage?.content || `${room.agentCount} 个 Agent`,
    meta: formatRelative(room.updatedAt),
    section: historySection(room.updatedAt),
    unread: room.unreadCount,
    icon: 'groups',
  }
}

export function groupMessageToUi(message: GroupMessage): UiMessage {
  const tools = (message.toolState || []).map((entry, index) => {
    const value = record(entry)
    const rawStatus = string(value.status, 'success')
    const status: UiToolCall['status'] = rawStatus === 'completed' ? 'success' : rawStatus === 'failed' ? 'error' : ['running', 'pending', 'success', 'error'].includes(rawStatus) ? rawStatus as UiToolCall['status'] : 'success'
    return { id: string(value.id, `${message.id}:tool:${index}`), name: string(value.name ?? value.tool, '工具调用'), status, input: value.input ?? value.arguments, output: value.output ?? value.result }
  })
  return {
    id: message.id,
    role: message.senderKind === 'human' ? 'user' : message.senderKind === 'agent' ? 'assistant' : 'system',
    author: message.senderName,
    content: message.content,
    reasoning: message.reasoning,
    createdAt: message.createdAt < 10_000_000_000 ? message.createdAt * 1000 : message.createdAt,
    status: message.status === 'completed' ? 'settled' : message.status === 'queued' ? 'pending' : message.status === 'streaming' ? 'streaming' : message.status === 'failed' ? 'failed' : message.status === 'unknown' ? 'unknown-receipt' : 'settled',
    error: message.error,
    tools,
  }
}

export function groupInteraction(interaction?: GroupInteraction): UiInteraction | null {
  if (!interaction || interaction.status !== 'pending') return null
  const payload = record(interaction.payload)
  const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === 'string') : undefined
  return {
    id: interaction.id,
    kind: interaction.kind === 'clarification' ? 'clarification' : 'approval',
    title: string(payload.title || payload.tool_name),
    prompt: string(payload.question || payload.message || payload.prompt, interaction.kind === 'clarification' ? 'Agent 需要补充信息' : 'Agent 请求执行操作'),
    options: choices,
    detail: JSON.stringify(payload, null, 2),
  }
}

export function agentToUi(agent: GroupAgent): UiAgent {
  return {
    id: agent.id,
    name: agent.displayName || agent.profile,
    profile: agent.profile,
    enabled: agent.enabled,
    autoReply: agent.replyWithoutMention,
    status: agent.status === 'running' || agent.status === 'queued' ? 'working' : agent.status === 'unknown' ? 'offline' : 'idle',
  }
}

export function roomToUi(room: GroupRoomDetail): UiRoom {
  return { id: room.id, name: room.name, archived: room.archived, memberIds: room.agents.map(agent => agent.id), replyRounds: room.maxReplyRounds }
}

export function fileToUi(item: FileLibraryItem): UiLibraryItem {
  const kind: UiLibraryItem['kind'] = item.kind === 'document'
    ? item.mimeType === 'application/pdf' ? 'pdf' : /text|json|xml|javascript|typescript|css|html/.test(item.mimeType) ? 'text' : 'document'
    : item.kind === 'other' ? 'file' : item.kind
  const origin = item.origins.at(-1)
  return {
    id: item.id,
    name: item.name,
    kind,
    mimeType: item.mimeType,
    size: item.size,
    updatedAt: item.modifiedAt < 10_000_000_000 ? item.modifiedAt * 1000 : item.modifiedAt,
    previewUrl: item.previewUrl,
    downloadUrl: item.downloadUrl,
    sourceLabel: origin?.sessionTitle || origin?.authorName || origin?.profile,
    sourceSessionId: origin?.sessionId,
    sourceMessageId: origin?.messageId,
    sourceProfile: origin?.profile,
  }
}

export function artifactToUi(item: ConversationArtifact): UiLibraryItem {
  const raw = item.attachment
  const kind: UiLibraryItem['kind'] = item.kind === 'link' ? 'link' : item.kind === 'image' ? 'image' : raw?.mimeType === 'application/pdf' ? 'pdf' : 'file'
  return {
    id: item.id,
    name: item.label || item.value.split('/').at(-1) || '产物',
    title: item.label,
    kind,
    mimeType: item.mimeType || raw?.mimeType,
    size: raw?.size,
    createdAt: item.timestamp < 10_000_000_000 ? item.timestamp * 1000 : item.timestamp,
    previewUrl: raw?.url || item.value,
    downloadUrl: raw?.url || (item.kind === 'file' ? item.value : undefined),
    sourceLabel: item.sessionTitle,
    sourceSessionId: item.sessionId,
    sourceMessageId: item.messageId,
    sourceProfile: item.profile,
  }
}

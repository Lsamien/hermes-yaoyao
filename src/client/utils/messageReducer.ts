import type {
  ApprovalRequest, ChatMessage, ChatRouteState, ChatUsage, ClarificationRequest, JsonValue, RpcEventFrame, ToolCall,
} from '@shared/types'
import { createId } from './id'
import { bool, number, record, string } from './normalize'

type MergePosition = 'append' | 'prepend' | 'snapshot'

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left.id && right.id && left.id === right.id) return true
  return Boolean(left.clientMessageId && right.clientMessageId && left.clientMessageId === right.clientMessageId)
}

function mergeOne(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  return {
    ...previous,
    ...incoming,
    id: incoming.serverMessageId || incoming.stage === 'settled' ? incoming.id : previous.id,
    clientMessageId: incoming.clientMessageId ?? previous.clientMessageId,
    serverMessageId: incoming.serverMessageId ?? previous.serverMessageId,
    content: incoming.content || previous.content,
    reasoning: incoming.reasoning ?? previous.reasoning,
    attachments: incoming.attachments?.length ? incoming.attachments : previous.attachments,
    toolCalls: incoming.toolCalls?.length ? incoming.toolCalls : previous.toolCalls,
  }
}

/** Merge only by server/client identity. Repeated text is always retained. */
export function mergeChatMessages(existing: ChatMessage[], incoming: ChatMessage[], position: MergePosition = 'append'): ChatMessage[] {
  const base = position === 'prepend' || position === 'snapshot' ? [...incoming, ...existing] : [...existing, ...incoming]
  const result: ChatMessage[] = []
  for (const message of base) {
    const index = result.findIndex(candidate => sameMessage(candidate, message))
    if (index < 0) result.push(message)
    else result[index] = mergeOne(result[index], message)
  }
  return result
}

function payloadRecord(event: RpcEventFrame['params']): Record<string, unknown> {
  return record(event.payload)
}

function eventSessionId(event: RpcEventFrame['params'], fallback: string): string {
  const payload = payloadRecord(event)
  return string(event.session_id ?? payload.session_id ?? payload.sessionId, fallback)
}

function eventMessageId(payload: Record<string, unknown>, fallback: string): string {
  return string(payload.message_id ?? payload.messageId ?? payload.id ?? payload.run_id ?? payload.runId, fallback)
}

function lastStreamingAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
}

function toolFromEvent(payload: Record<string, unknown>, status: ToolCall['status']): ToolCall {
  return {
    id: string(payload.tool_call_id ?? payload.toolCallId ?? payload.tool_id ?? payload.id, createId('tool')),
    name: string(payload.name ?? payload.tool_name, '工具'),
    status,
    arguments: (payload.arguments ?? payload.args ?? payload.context) as JsonValue | undefined,
    result: (payload.result ?? payload.output) as JsonValue | undefined,
    preview: string(payload.preview ?? payload.summary ?? payload.args_text) || undefined,
    error: string(payload.error) || undefined,
    durationSeconds: number(payload.duration_seconds ?? payload.duration_s) || undefined,
  }
}

function normalizeUsage(payload: Record<string, unknown>): ChatUsage | undefined {
  const raw = record(payload.usage ?? payload)
  if (!Object.keys(raw).length) return undefined
  return {
    inputTokens: number(raw.input_tokens ?? raw.input ?? raw.prompt) || undefined,
    outputTokens: number(raw.output_tokens ?? raw.output ?? raw.completion) || undefined,
    totalTokens: number(raw.total_tokens ?? raw.total) || undefined,
    contextTokens: number(raw.context_tokens ?? raw.context_used ?? raw.current_tokens ?? raw.used) || undefined,
    contextLimit: number(raw.context_limit ?? raw.context_max ?? raw.max_tokens ?? raw.limit) || undefined,
    percentUsed: number(raw.percent_used ?? raw.context_percent ?? raw.percentage) || undefined,
    raw: raw as JsonValue,
  }
}

function updateStreamingMessage(
  state: ChatRouteState,
  payload: Record<string, unknown>,
  mode: 'start' | 'delta' | 'reasoning' | 'complete' | 'failed',
): ChatMessage[] {
  const current = lastStreamingAssistant(state.messages)
  const fallbackId = current?.id ?? `stream:${state.route.profile}:${state.route.sessionId}`
  const id = eventMessageId(payload, fallbackId)
  const existing = state.messages.find(message => message.id === id) ?? current
  const delta = string(payload.delta ?? payload.text_delta ?? payload.content_delta)
  const full = string(payload.output ?? payload.text ?? payload.content)
  let content = existing?.content ?? ''
  let reasoning = existing?.reasoning
  if (mode === 'delta') content += delta || full
  if (mode === 'complete') content = bool(payload.authoritative_output) && full ? full : full || content
  if (mode === 'reasoning') reasoning = `${reasoning ?? ''}${delta || full}`
  const message: ChatMessage = {
    id,
    serverMessageId: id.startsWith('stream:') ? undefined : id,
    sessionId: state.route.sessionId,
    profile: state.route.profile,
    role: 'assistant',
    content,
    reasoning,
    timestamp: number(payload.timestamp ?? payload.created_at, existing?.timestamp ?? Date.now() / 1000),
    stage: mode === 'complete' ? 'settled' : mode === 'failed' ? 'failed' : 'streaming',
    isStreaming: !['complete', 'failed'].includes(mode),
    error: mode === 'failed' ? string(payload.error ?? payload.message, '运行失败') : undefined,
    toolCalls: existing?.toolCalls,
    raw: payload as JsonValue,
  }
  return mergeChatMessages(state.messages, [message])
}

export function applyChatEvent(state: ChatRouteState, event: RpcEventFrame['params']): ChatRouteState {
  if (event.type === 'gateway.ready') return state
  const payload = payloadRecord(event)
  if (eventSessionId(event, state.route.sessionId) !== state.route.sessionId) return state
  const next: ChatRouteState = { ...state, error: undefined }
  switch (event.type) {
    case 'message.start':
    case 'run.started':
      next.messages = updateStreamingMessage(state, payload, 'start')
      next.isStreaming = true
      next.isQueued = false
      break
    case 'message.delta':
    case 'content.delta':
    case 'assistant.delta':
      next.messages = updateStreamingMessage(state, payload, 'delta')
      next.isStreaming = true
      break
    case 'reasoning.delta':
      next.messages = updateStreamingMessage(state, payload, 'reasoning')
      next.isStreaming = true
      break
    case 'thinking.delta':
    case 'status.update':
      next.liveStatus = string(payload.text ?? payload.message ?? payload.status) || undefined
      break
    case 'message.complete':
    case 'run.completed': {
      const terminalStatus = string(payload.status).trim().toLowerCase()
      const failed = terminalStatus === 'error' || terminalStatus === 'failed' || Boolean(payload.error)
      next.messages = updateStreamingMessage(state, payload, failed ? 'failed' : 'complete')
      next.isStreaming = false
      next.isQueued = false
      next.liveStatus = undefined
      next.usage = normalizeUsage(payload) ?? next.usage
      if (failed) next.error = string(payload.error ?? payload.text ?? payload.message, '运行失败')
      break
    }
    case 'error':
    case 'run.failed':
      next.messages = updateStreamingMessage(state, payload, 'failed')
      next.isStreaming = false
      next.isQueued = false
      next.error = string(payload.error ?? payload.message, '运行失败')
      break
    case 'run.queued':
      next.isQueued = true
      break
    case 'run.steered':
    case 'submission.acknowledged':
      next.isQueued = false
      break
    case 'session.usage':
    case 'usage.update':
    case 'context.update':
      next.usage = normalizeUsage(payload)
      break
    case 'tool.start':
    case 'tool.progress':
    case 'tool.started':
    case 'tool.generating': {
      const current = lastStreamingAssistant(next.messages)
      if (!current) break
      const tool = toolFromEvent(payload, 'running')
      const tools = [...(current.toolCalls ?? [])]
      const index = tools.findIndex(item => item.id === tool.id)
      if (index >= 0) tools[index] = { ...tools[index], ...tool }
      else tools.push(tool)
      next.messages = mergeChatMessages(next.messages, [{ ...current, toolCalls: tools }])
      break
    }
    case 'tool.complete':
    case 'tool.completed':
    case 'tool.failed': {
      const current = lastStreamingAssistant(next.messages) ?? [...next.messages].reverse().find(message => message.role === 'assistant')
      if (!current) break
      const tool = toolFromEvent(payload, event.type === 'tool.failed' || payload.error ? 'failed' : 'completed')
      const tools = [...(current.toolCalls ?? [])]
      const index = tools.findIndex(item => item.id === tool.id)
      if (index >= 0) tools[index] = { ...tools[index], ...tool }
      else tools.push(tool)
      next.messages = mergeChatMessages(next.messages, [{ ...current, toolCalls: tools }])
      break
    }
    case 'approval.request':
    case 'approval.requested': {
      const id = string(payload.request_id ?? payload.requestId ?? payload.id)
      if (id) next.pendingApproval = {
        id, sessionId: state.route.sessionId, message: string(payload.message ?? payload.prompt) || undefined,
        toolName: string(payload.tool_name ?? payload.tool) || undefined,
        choices: Array.isArray(payload.choices) ? payload.choices.map(String) : undefined,
        payload: payload as Record<string, JsonValue>,
      } satisfies ApprovalRequest
      break
    }
    case 'approval.resolved':
      next.pendingApproval = undefined
      break
    case 'clarify.request':
    case 'clarify.requested': {
      const id = string(payload.request_id ?? payload.requestId ?? payload.id)
      if (id) next.pendingClarification = {
        id, sessionId: state.route.sessionId, question: string(payload.question ?? payload.message ?? payload.prompt, '需要补充信息'),
        choices: Array.isArray(payload.choices) ? payload.choices.map(String) : undefined,
        payload: payload as Record<string, JsonValue>,
      } satisfies ClarificationRequest
      break
    }
    case 'clarify.expire':
    case 'clarify.resolved':
      next.pendingClarification = undefined
      break
  }
  return next
}

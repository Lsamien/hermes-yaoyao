export type UiToolCall = {
  id: string
  name: string
  status: 'running' | 'success' | 'error' | 'pending'
  input?: unknown
  output?: unknown
  durationMs?: number
}

export type UiMessageAttachment = {
  id: string
  name: string
  kind?: 'image' | 'video' | 'audio' | 'file'
  url?: string
  size?: number
}

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  author?: string
  content: string
  reasoning?: string
  createdAt?: string | number | Date
  status?: 'preparing' | 'attached' | 'pending' | 'accepted' | 'streaming' | 'settled' | 'failed' | 'unknown-receipt'
  error?: string
  attachments?: UiMessageAttachment[]
  tools?: UiToolCall[]
  profile?: string
  timelineKind?: 'delegation-complete' | 'system'
  timelineMetadata?: Record<string, unknown>
}

export type UiInteraction = {
  id: string
  kind: 'approval' | 'clarification'
  title?: string
  prompt: string
  options?: string[]
  detail?: string
}

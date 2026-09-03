/** Application-owned identities. Hermes profile/session IDs never identify a chat. */
export interface WorkspaceAgent {
  id: string
  name: string
  avatar: string
  instructions: string
  nodeId: string
  profile: string
  archived: boolean
  revision: number
  createdAt: number
  updatedAt: number
}
export interface WorkspaceMemberRole {
  name: string
  description: string
}
export interface WorkspaceConversation {
  id: string
  kind: 'direct' | 'group'
  name: string
  avatar: string
  memberIds: string[]
  memberRoles?: Record<string, WorkspaceMemberRole>
  instructions: string
  administratorId: string
  mode: 'host' | 'free'
  autoReplyIds: string[]
  maxReplyRounds: number
  archived: boolean
  pinned: boolean
  readSeq: number
  lastSeq: number
  lastMessageAt?: number
  preview: string
  activeRunId?: string
  activeAgentId?: string
  activeRunStatus?: WorkspaceRun['status']
  createdAt: number
  updatedAt: number
}
export interface WorkspaceFile {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: number
  sourcePath?: string
  conversationId?: string
  messageId?: string
  profile?: string
  sender: 'user' | 'agent'
}
export interface WorkspaceMessage {
  id: string
  conversationId: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  agentId?: string
  agentName?: string
  content: string
  reasoning: string
  runId?: string
  status: 'queued' | 'streaming' | 'complete' | 'failed' | 'interrupted' | 'uncertain'
  attachments: WorkspaceFile[]
  tools: Array<Record<string, unknown>>
  createdAt: number
}
export interface WorkspaceRun {
  id: string
  conversationId: string
  messageId: string
  mentionIds: string[]
  activeAgentId?: string
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'interrupted' | 'uncertain'
  round: number
  error?: string
  createdAt: number
  updatedAt: number
}
export interface WorkspaceInteraction {
  id: string
  conversationId: string
  runId: string
  agentId: string
  kind: 'approval' | 'clarification'
  message: string
  choices: string[]
  resolved: boolean
}
export interface WorkspaceEvent {
  seq: number
  type: string
  conversationId?: string
  data: unknown
}
export interface WorkspaceSource {
  nodeId: string
  profile: string
  name: string
}

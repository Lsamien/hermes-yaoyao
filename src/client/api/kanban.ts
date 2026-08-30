import type { JsonValue } from '@shared/types'
import { apiRequest, apiUrl, unwrapData } from './client'

const BASE = '/api/app/kanban'

export interface KanbanStatus {
  available: boolean
  version?: string
  reason?: string
}

export interface KanbanBoardMeta {
  slug: string
  name?: string | null
  description?: string | null
  icon?: string | null
  color?: string | null
  total?: number
  counts?: Record<string, number>
  is_current?: boolean
  default_workdir?: string | null
  default_workspace_kind?: string | null
  project_id?: string | null
  project_name?: string | null
}

export interface KanbanBoardsResponse {
  boards: KanbanBoardMeta[]
  current: string
}

export interface KanbanTask {
  id: string
  title: string
  body?: string | null
  result?: string | null
  status: string
  assignee?: string | null
  tenant?: string | null
  priority?: number
  created_by?: string | null
  created_at?: number
  started_at?: number | null
  completed_at?: number | null
  latest_summary?: string | null
  comment_count?: number
  model_override?: string | null
  provider_override?: string | null
  reasoning_effort?: string | null
  workspace_kind?: string | null
  workspace_path?: string | null
  branch_name?: string | null
  link_counts?: { parents: number; children: number }
  progress?: { done: number; total: number } | null
  warnings?: { count: number; highest_severity?: string | null } | null
  diagnostics?: KanbanDiagnostic[]
}

export interface KanbanColumn {
  name: string
  tasks: KanbanTask[]
}

export interface KanbanBoardSnapshot {
  columns: KanbanColumn[]
  tenants: string[]
  assignees: string[]
  latest_event_id: number
  now: number
}

export interface KanbanProfile {
  name: string
  is_default: boolean
  description?: string
  description_auto?: boolean
  model?: string
  provider?: string
}

export interface KanbanComment {
  id: string | number
  task_id?: string
  author: string
  body: string
  created_at: number
}

export interface KanbanEvent {
  id: number
  task_id?: string
  run_id?: string | number | null
  kind: string
  payload?: JsonValue | string | null
  created_at: number
}

export interface KanbanRun {
  id: string | number
  task_id?: string
  profile?: string | null
  status: string
  outcome?: string | null
  summary?: string | null
  error?: string | null
  metadata?: JsonValue | string | null
  worker_pid?: number | null
  started_at?: number | null
  ended_at?: number | null
  last_heartbeat_at?: number | null
}

export interface KanbanDiagnostic {
  kind: string
  severity: 'warning' | 'error' | 'critical' | string
  title: string
  detail: string
  count?: number
  last_seen_at?: number
}

export interface KanbanTaskDetail {
  task: KanbanTask
  comments: KanbanComment[]
  events: KanbanEvent[]
  links: { parents: string[]; children: string[] }
  child_results?: Array<{ id: string; title: string; status: string; latest_summary?: string | null; result?: string | null }>
  runs: KanbanRun[]
}

export interface CreateKanbanBoardInput {
  slug: string
  name?: string
  description?: string
}

export interface CreateKanbanTaskInput {
  title: string
  body?: string
  assignee?: string
  tenant?: string
  priority?: number
  workspace_kind?: 'scratch' | 'worktree' | 'dir'
  workspace_path?: string
  parents?: string[]
  triage?: boolean
}

export type UpdateKanbanTaskInput = Partial<Pick<KanbanTask,
  'title' | 'body' | 'assignee' | 'priority' | 'result' | 'model_override' | 'provider_override' | 'reasoning_effort'>> & {
  status?: string
  block_reason?: string
  summary?: string
  clear_model_override?: boolean
  clear_reasoning_effort?: boolean
}

function boardPath(path: string, board: string, query: Record<string, string | number | boolean | undefined> = {}): string {
  return apiUrl(`${BASE}${path}`, { ...query, board })
}

export async function getKanbanStatus(): Promise<KanbanStatus> {
  return unwrapData(await apiRequest<KanbanStatus>(`${BASE}/status`))
}

export async function listKanbanBoards(): Promise<KanbanBoardsResponse> {
  return unwrapData(await apiRequest<KanbanBoardsResponse>(`${BASE}/boards`))
}

export async function createKanbanBoard(input: CreateKanbanBoardInput): Promise<{ board: KanbanBoardMeta; current: string }> {
  return unwrapData(await apiRequest(`${BASE}/boards`, {
    method: 'POST',
    body: { ...input, switch: false },
  }))
}

export async function getKanbanBoard(board: string, includeArchived = false): Promise<KanbanBoardSnapshot> {
  return unwrapData(await apiRequest<KanbanBoardSnapshot>(boardPath('/board', board, {
    include_archived: includeArchived,
  })))
}

export async function listKanbanProfiles(): Promise<KanbanProfile[]> {
  const payload = unwrapData(await apiRequest<{ profiles: KanbanProfile[] }>(`${BASE}/profiles`))
  return Array.isArray(payload.profiles) ? payload.profiles : []
}

export async function getKanbanTask(board: string, id: string): Promise<KanbanTaskDetail> {
  return unwrapData(await apiRequest<KanbanTaskDetail>(boardPath(`/tasks/${encodeURIComponent(id)}`, board)))
}

export async function createKanbanTask(board: string, input: CreateKanbanTaskInput): Promise<{ task: KanbanTask | null; warning?: string }> {
  return unwrapData(await apiRequest(boardPath('/tasks', board), {
    method: 'POST', body: input as unknown as JsonValue,
  }))
}

export async function updateKanbanTask(board: string, id: string, input: UpdateKanbanTaskInput): Promise<{ task: KanbanTask | null }> {
  return unwrapData(await apiRequest(boardPath(`/tasks/${encodeURIComponent(id)}`, board), {
    method: 'PATCH', body: input as unknown as JsonValue,
  }))
}

export async function deleteKanbanTask(board: string, id: string): Promise<void> {
  await apiRequest(boardPath(`/tasks/${encodeURIComponent(id)}`, board), { method: 'DELETE', body: {} })
}

export async function addKanbanComment(board: string, id: string, comment: { body: string }): Promise<void> {
  await apiRequest(boardPath(`/tasks/${encodeURIComponent(id)}/comments`, board), {
    method: 'POST', body: comment,
  })
}

export async function dispatchKanban(board: string): Promise<unknown> {
  return unwrapData(await apiRequest(boardPath('/dispatch', board), { method: 'POST', body: {} }))
}

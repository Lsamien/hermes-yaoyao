import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  addKanbanComment,
  createKanbanBoard as createBoardApi,
  createKanbanTask as createTaskApi,
  deleteKanbanTask as deleteTaskApi,
  dispatchKanban,
  getKanbanBoard,
  getKanbanStatus,
  getKanbanTask,
  listKanbanBoards,
  listKanbanProfiles,
  updateKanbanTask,
  type CreateKanbanBoardInput,
  type CreateKanbanTaskInput,
  type KanbanBoardMeta,
  type KanbanBoardSnapshot,
  type KanbanProfile,
  type KanbanTask,
  type KanbanTaskDetail,
  type UpdateKanbanTaskInput,
} from '@/api/kanban'
import { ApiError } from '@/api/client'
import { useAuthStore } from './auth'

export type KanbanAvailability = 'checking' | 'available' | 'unsupported' | 'unavailable'

const BOARD_SELECTION_PREFIX = 'hermes-yaoyao:kanban-board:'
const POLL_INTERVAL_MS = 5_000
const MUTABLE_STATUSES = new Set(['triage', 'todo', 'ready', 'blocked', 'done'])

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '看板请求失败'
}

export const useKanbanStore = defineStore('kanban', () => {
  const auth = useAuthStore()
  const availability = ref<KanbanAvailability>('checking')
  const pluginVersion = ref('')
  const boards = ref<KanbanBoardMeta[]>([])
  const currentBoardSlug = ref('')
  const selectedBoardSlug = ref('')
  const snapshot = shallowRef<KanbanBoardSnapshot>()
  const profiles = ref<KanbanProfile[]>([])
  const selectedTaskId = ref('')
  const selectedTask = shallowRef<KanbanTaskDetail>()
  const includeArchived = ref(false)
  const search = ref('')
  const assignee = ref('')
  const tenant = ref('')
  const isLoading = ref(false)
  const isTaskLoading = ref(false)
  const isMutating = ref(false)
  const error = ref('')
  const taskError = ref('')
  const lastUpdatedAt = ref(0)

  let pollTimer: number | undefined
  let generation = 0
  let boardRefresh: Promise<void> | undefined
  let boardRefreshGeneration = -1
  let boardRequestRevision = 0
  let taskRequestRevision = 0

  const canEdit = computed(() => auth.user?.role === 'admin')
  const selectedBoard = computed(() => boards.value.find(board => board.slug === selectedBoardSlug.value))
  const allTasks = computed(() => snapshot.value?.columns.flatMap(column => column.tasks) ?? [])
  const filteredColumns = computed(() => {
    const needle = search.value.trim().toLocaleLowerCase()
    return (snapshot.value?.columns ?? []).map(column => ({
      ...column,
      tasks: column.tasks.filter(task => (
        (!needle || `${task.title} ${task.body ?? ''} ${task.latest_summary ?? ''} ${task.id}`.toLocaleLowerCase().includes(needle))
        && (!assignee.value || task.assignee === assignee.value)
        && (!tenant.value || task.tenant === tenant.value)
      )),
    }))
  })

  function selectionKey(): string {
    return `${BOARD_SELECTION_PREFIX}${auth.user?.id || 'local'}`
  }

  function persistedSelection(): string {
    try { return localStorage.getItem(selectionKey())?.trim() ?? '' } catch { return '' }
  }

  function persistSelection(value: string): void {
    try { localStorage.setItem(selectionKey(), value) } catch { /* optional persistence */ }
  }

  function requireEditor(): void {
    if (!canEdit.value) throw new ApiError('看板编辑仅限管理员', 403, 'admin_required')
  }

  function requireMutableStatus(status: string): void {
    if (!MUTABLE_STATUSES.has(status)) {
      throw new ApiError('该状态由 Kanban 系统维护，客户端不能直接写入', 400, 'invalid_kanban_status')
    }
  }

  function cancelledMutation(): ApiError {
    return new ApiError('账号或看板上下文已变化，请重试', 0, 'REQUEST_ABORTED')
  }

  async function initialize(): Promise<void> {
    const expected = ++generation
    stopPolling()
    availability.value = 'checking'
    isLoading.value = true
    error.value = ''
    try {
      const status = await getKanbanStatus()
      if (expected !== generation) return
      pluginVersion.value = status.version || ''
      if (!status.available) {
        availability.value = 'unsupported'
        error.value = status.reason || '9119 尚未安装或启用 Kanban 插件'
        boards.value = []
        snapshot.value = undefined
        return
      }
      const [boardResult, profileResult] = await Promise.all([
        listKanbanBoards(),
        listKanbanProfiles(),
      ])
      if (expected !== generation) return
      availability.value = 'available'
      boards.value = boardResult.boards
      profiles.value = profileResult
      currentBoardSlug.value = boardResult.current
      const remembered = persistedSelection()
      selectedBoardSlug.value = boards.value.some(board => board.slug === remembered)
        ? remembered
        : boards.value.some(board => board.slug === boardResult.current)
          ? boardResult.current
          : boards.value[0]?.slug || ''
      if (selectedBoardSlug.value) await refreshBoard(false, true)
      if (expected !== generation) return
      startPolling()
    } catch (cause) {
      if (expected !== generation) return
      availability.value = 'unavailable'
      error.value = errorMessage(cause)
    } finally {
      if (expected === generation) isLoading.value = false
    }
  }

  async function refreshBoards(): Promise<void> {
    const expected = generation
    const result = await listKanbanBoards()
    if (expected !== generation) return
    boards.value = result.boards
    currentBoardSlug.value = result.current
    if (!boards.value.some(board => board.slug === selectedBoardSlug.value)) {
      selectedBoardSlug.value = boards.value.some(board => board.slug === result.current)
        ? result.current : boards.value[0]?.slug || ''
    }
  }

  async function refreshBoard(silent = false, forceAfterPending = false): Promise<void> {
    if (boardRefresh && boardRefreshGeneration === generation) {
      if (!forceAfterPending) return boardRefresh
      await boardRefresh
    }
    const slug = selectedBoardSlug.value
    if (!slug) return
    const expected = generation
    const revision = ++boardRequestRevision
    if (!silent) isLoading.value = true
    const operation = (async () => {
      try {
        const next = await getKanbanBoard(slug, includeArchived.value)
        if (expected !== generation || revision !== boardRequestRevision || selectedBoardSlug.value !== slug) return
        snapshot.value = next
        lastUpdatedAt.value = Date.now()
        error.value = ''
      } catch (cause) {
        if (expected === generation && revision === boardRequestRevision
          && selectedBoardSlug.value === slug) error.value = errorMessage(cause)
      } finally {
        if (!silent && expected === generation) isLoading.value = false
      }
    })()
    let tracked: Promise<void>
    tracked = operation.finally(() => {
      if (boardRefresh === tracked) {
        boardRefresh = undefined
        boardRefreshGeneration = -1
      }
    })
    boardRefresh = tracked
    boardRefreshGeneration = expected
    return tracked
  }

  async function selectBoard(slug: string): Promise<void> {
    if (slug === selectedBoardSlug.value || !boards.value.some(board => board.slug === slug)) return
    selectedBoardSlug.value = slug
    selectedTaskId.value = ''
    selectedTask.value = undefined
    taskError.value = ''
    snapshot.value = undefined
    persistSelection(slug)
    await refreshBoard(false, true)
  }

  async function selectTask(id: string): Promise<void> {
    selectedTaskId.value = id
    selectedTask.value = undefined
    taskError.value = ''
    await refreshTask(false)
  }

  function closeTask(): void {
    taskRequestRevision += 1
    selectedTaskId.value = ''
    selectedTask.value = undefined
    taskError.value = ''
  }

  async function refreshTask(silent = true): Promise<void> {
    const id = selectedTaskId.value
    const slug = selectedBoardSlug.value
    if (!id || !slug) return
    const expected = generation
    const revision = ++taskRequestRevision
    if (!silent) isTaskLoading.value = true
    try {
      const detail = await getKanbanTask(slug, id)
      if (expected !== generation || revision !== taskRequestRevision
        || selectedTaskId.value !== id || selectedBoardSlug.value !== slug) return
      selectedTask.value = detail
      taskError.value = ''
    } catch (cause) {
      if (expected === generation && revision === taskRequestRevision
        && selectedTaskId.value === id) taskError.value = errorMessage(cause)
    } finally {
      if (expected === generation && revision === taskRequestRevision) isTaskLoading.value = false
    }
  }

  async function authoritativeRefresh(taskId = selectedTaskId.value): Promise<void> {
    await Promise.all([
      refreshBoard(true, true),
      taskId && taskId === selectedTaskId.value ? refreshTask(true) : Promise.resolve(),
    ])
  }

  async function withMutation<T>(
    run: () => Promise<T>,
    taskId = selectedTaskId.value,
    allowBoardChange = false,
  ): Promise<T> {
    requireEditor()
    const expected = generation
    const expectedBoard = selectedBoardSlug.value
    isMutating.value = true
    error.value = ''
    try {
      const result = await run()
      if (expected !== generation || (!allowBoardChange && selectedBoardSlug.value !== expectedBoard)) {
        throw cancelledMutation()
      }
      boardRequestRevision += 1
      taskRequestRevision += 1
      await authoritativeRefresh(taskId)
      if (expected !== generation || (!allowBoardChange && selectedBoardSlug.value !== expectedBoard)) {
        throw cancelledMutation()
      }
      return result
    } catch (cause) {
      if (expected === generation && !(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
        error.value = errorMessage(cause)
      }
      throw cause
    } finally {
      if (expected === generation) isMutating.value = false
    }
  }

  async function createBoard(input: CreateKanbanBoardInput): Promise<KanbanBoardMeta> {
    const expected = generation
    return withMutation(async () => {
      const result = await createBoardApi(input)
      if (expected !== generation) throw cancelledMutation()
      await refreshBoards()
      if (expected !== generation) throw cancelledMutation()
      selectedBoardSlug.value = result.board.slug
      persistSelection(result.board.slug)
      const nextSnapshot = await getKanbanBoard(result.board.slug, includeArchived.value)
      if (expected !== generation) throw cancelledMutation()
      snapshot.value = nextSnapshot
      return result.board
    }, '', true)
  }

  async function createTask(input: CreateKanbanTaskInput, targetStatus = 'ready'): Promise<KanbanTask | null> {
    requireMutableStatus(targetStatus)
    const slug = selectedBoardSlug.value
    if (!slug) throw new Error('尚未选择看板')
    return withMutation(async () => {
      const created = await createTaskApi(slug, { ...input, triage: targetStatus === 'triage' })
      if (created.task && created.task.status !== targetStatus) {
        const moved = await updateKanbanTask(slug, created.task.id, { status: targetStatus })
        return moved.task
      }
      return created.task
    }, '')
  }

  async function moveTask(task: KanbanTask, status: string): Promise<void> {
    if (status === task.status) return
    requireMutableStatus(status)
    const slug = selectedBoardSlug.value
    await withMutation(async () => {
      await updateKanbanTask(slug, task.id, { status })
    }, task.id)
  }

  async function updateTask(input: UpdateKanbanTaskInput): Promise<void> {
    if (input.status !== undefined) requireMutableStatus(input.status)
    const id = selectedTaskId.value
    const slug = selectedBoardSlug.value
    if (!id || !slug) return
    await withMutation(async () => { await updateKanbanTask(slug, id, input) }, id)
  }

  async function deleteTask(id = selectedTaskId.value): Promise<void> {
    const slug = selectedBoardSlug.value
    if (!id || !slug) return
    await withMutation(async () => { await deleteTaskApi(slug, id) }, '')
    if (selectedTaskId.value === id) closeTask()
  }

  async function comment(body: string): Promise<void> {
    const id = selectedTaskId.value
    const slug = selectedBoardSlug.value
    if (!id || !slug || !body.trim()) return
    await withMutation(async () => {
      await addKanbanComment(slug, id, {
        body: body.trim(),
      })
    }, id)
  }

  async function dispatch(): Promise<unknown> {
    const slug = selectedBoardSlug.value
    if (!slug) return
    return withMutation(() => dispatchKanban(slug), selectedTaskId.value)
  }

  async function setIncludeArchived(value: boolean): Promise<void> {
    includeArchived.value = value
    await refreshBoard(false, true)
  }

  function startPolling(): void {
    stopPolling()
    pollTimer = window.setInterval(() => {
      if (availability.value !== 'available' || document.visibilityState === 'hidden') return
      void refreshBoard(true)
      if (selectedTaskId.value) void refreshTask(true)
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) window.clearInterval(pollTimer)
    pollTimer = undefined
  }

  function reset(): void {
    generation += 1
    boardRequestRevision += 1
    taskRequestRevision += 1
    stopPolling()
    availability.value = 'checking'
    pluginVersion.value = ''
    boards.value = []
    currentBoardSlug.value = ''
    selectedBoardSlug.value = ''
    snapshot.value = undefined
    profiles.value = []
    selectedTaskId.value = ''
    selectedTask.value = undefined
    includeArchived.value = false
    search.value = ''
    assignee.value = ''
    tenant.value = ''
    isLoading.value = false
    isTaskLoading.value = false
    isMutating.value = false
    error.value = ''
    taskError.value = ''
    lastUpdatedAt.value = 0
  }

  watch(
    () => `${auth.isAuthenticated ? 'authenticated' : 'anonymous'}:${auth.user?.id || ''}`,
    (identity, previous) => { if (identity !== previous) reset() },
  )

  return {
    availability, pluginVersion, boards, currentBoardSlug, selectedBoardSlug, selectedBoard, snapshot, profiles,
    selectedTaskId, selectedTask, includeArchived, search, assignee, tenant, isLoading, isTaskLoading, isMutating,
    error, taskError, lastUpdatedAt, canEdit, allTasks, filteredColumns,
    initialize, refreshBoards, refreshBoard, selectBoard, selectTask, closeTask, refreshTask, createBoard, createTask,
    moveTask, updateTask, deleteTask, comment, dispatch, setIncludeArchived, startPolling, stopPolling, reset,
  }
})

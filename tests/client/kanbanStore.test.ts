import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { setApiCsrfToken } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useKanbanStore } from '@/stores/kanban'

const boardPayload = () => ({
  columns: [
    { name: 'todo', tasks: [{ id: 'task-a', title: '移动端验收', body: 'iOS 与 Web', status: 'todo', assignee: 'yaoyao', tenant: 'mobile', priority: 2, created_at: 1 }] },
    { name: 'ready', tasks: [{ id: 'task-b', title: '服务端核对', status: 'ready', assignee: 'ops', tenant: 'backend', created_at: 2 }] },
  ],
  tenants: ['backend', 'mobile'],
  assignees: ['ops', 'yaoyao'],
  latest_event_id: 2,
  now: 3,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.useFakeTimers()
  setApiCsrfToken('csrf-kanban-store')
})

afterEach(() => {
  useKanbanStore().stopPolling()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setApiCsrfToken('')
})

describe('Kanban store', () => {
  it('loads and switches boards, filters locally, and authoritatively refreshes after a write', async () => {
    const calls: Array<{ path: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ path, method })
      if (path.endsWith('/status')) return Response.json({ available: true, version: '1.0.0' })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', name: '默认', total: 2 }, { slug: 'mobile', name: '移动端', total: 2 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [{ name: 'yaoyao', is_default: true }, { name: 'ops', is_default: false }] })
      if (path.includes('/board?')) return Response.json(boardPayload())
      if (path.includes('/tasks?') && method === 'POST') return Response.json({ task: { id: 'task-new', title: '新任务', status: 'ready' } })
      return Response.json({ ok: true })
    }))
    const auth = useAuthStore()
    auth.status = 'authenticated'
    auth.user = { id: 'admin-a', username: 'admin', role: 'admin' }
    const store = useKanbanStore()

    await store.initialize()
    await store.selectBoard('mobile')
    expect(store.availability).toBe('available')
    expect(store.selectedBoardSlug).toBe('mobile')
    expect(store.allTasks.map(task => task.id)).toEqual(['task-a', 'task-b'])
    expect(calls.filter(call => call.path.includes('/board?')).at(-1)?.path).toContain('board=mobile')

    store.search = 'iOS'
    store.assignee = 'yaoyao'
    store.tenant = 'mobile'
    expect(store.filteredColumns.flatMap(column => column.tasks).map(task => task.id)).toEqual(['task-a'])

    const beforeRejectedTargets = calls.length
    await expect(store.createTask({ title: '非法状态' }, 'running')).rejects.toMatchObject({ code: 'invalid_kanban_status' })
    await expect(store.moveTask(store.allTasks[0]!, 'review')).rejects.toMatchObject({ code: 'invalid_kanban_status' })
    expect(calls).toHaveLength(beforeRejectedTargets)

    await store.createTask({ title: '新任务' })
    expect(calls.filter(call => call.path.includes('/tasks?') && call.method === 'POST')).toHaveLength(1)
    expect(calls.filter(call => call.path.includes('/board?')).length).toBeGreaterThanOrEqual(2)
  })

  it('allows regular users to read but rejects every mutation before making a request', async () => {
    const calls: Array<{ path: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? 'GET' })
      if (path.endsWith('/status')) return Response.json({ available: true })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', total: 2 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [] })
      if (path.includes('/board?')) return Response.json(boardPayload())
      return Response.json({ ok: true })
    }))
    const auth = useAuthStore()
    auth.status = 'authenticated'
    auth.user = { id: 'reader', username: 'reader', role: 'user' }
    const store = useKanbanStore()
    await store.initialize()

    expect(store.canEdit).toBe(false)
    await expect(store.moveTask(store.allTasks[0]!, 'ready')).rejects.toMatchObject({ status: 403, code: 'admin_required' })
    expect(calls.some(call => call.method === 'PATCH')).toBe(false)
  })

  it('forces a post-mutation board read after an older poll and discards stale task detail responses', async () => {
    const staleBoard = deferred<Response>()
    const freshBoard = deferred<Response>()
    const staleTask = deferred<Response>()
    let boardReads = 0
    let taskReads = 0
    let writes = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path.endsWith('/status')) return Response.json({ available: true })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', total: 1 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [] })
      if (path.includes('/board?')) {
        boardReads += 1
        if (boardReads === 2) return staleBoard.promise
        if (boardReads >= 3) return freshBoard.promise
        return Response.json({
          columns: [{ name: 'todo', tasks: [{ id: 'task-a', title: '竞态任务', status: 'todo' }] }, { name: 'ready', tasks: [] }],
          tenants: [], assignees: [], latest_event_id: boardReads, now: boardReads,
        })
      }
      if (path.includes('/tasks/task-a?') && method === 'GET') {
        taskReads += 1
        if (taskReads === 1) return staleTask.promise
        return Response.json({ task: { id: 'task-a', title: '新详情', status: 'ready' }, comments: [], events: [], links: { parents: [], children: [] }, runs: [] })
      }
      if (path.includes('/tasks/task-a?') && method === 'PATCH') {
        writes += 1
        return Response.json({ task: { id: 'task-a', title: '竞态任务', status: 'ready' } })
      }
      return Response.json({ ok: true })
    }))
    const auth = useAuthStore()
    auth.status = 'authenticated'
    auth.user = { id: 'admin-race', username: 'admin', role: 'admin' }
    const store = useKanbanStore()
    await store.initialize()

    const oldPoll = store.refreshBoard(true)
    await vi.waitFor(() => expect(boardReads).toBe(2))
    const mutation = store.moveTask(store.allTasks[0]!, 'ready')
    await vi.waitFor(() => expect(writes).toBe(1))
    staleBoard.resolve(Response.json({
      columns: [{ name: 'todo', tasks: [{ id: 'task-a', title: '旧轮询不应回写', status: 'todo' }] }, { name: 'ready', tasks: [] }],
      tenants: [], assignees: [], latest_event_id: 1, now: 1,
    }))
    await vi.waitFor(() => expect(boardReads).toBe(3))
    expect(store.allTasks[0]?.title).toBe('竞态任务')
    freshBoard.resolve(Response.json({
      columns: [{ name: 'todo', tasks: [] }, { name: 'ready', tasks: [{ id: 'task-a', title: '竞态任务', status: 'ready' }] }],
      tenants: [], assignees: [], latest_event_id: 3, now: 3,
    }))
    await Promise.all([oldPoll, mutation])
    expect(boardReads).toBe(3)
    expect(store.allTasks[0]?.status).toBe('ready')

    const oldDetail = store.selectTask('task-a')
    await vi.waitFor(() => expect(taskReads).toBe(1))
    const newDetail = store.refreshTask(true)
    await newDetail
    expect(store.selectedTask?.task.title).toBe('新详情')
    expect(store.isTaskLoading).toBe(false)
    staleTask.resolve(Response.json({ task: { id: 'task-a', title: '旧详情', status: 'todo' }, comments: [], events: [], links: { parents: [], children: [] }, runs: [] }))
    await oldDetail
    expect(store.selectedTask?.task.title).toBe('新详情')
  })

  it('invalidates pending work and clears account-scoped state when the authenticated user changes', async () => {
    const oldTask = deferred<Response>()
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/status')) return Response.json({ available: true, version: '1.0.0' })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', total: 1 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [{ name: 'yaoyao', is_default: true }] })
      if (path.includes('/board?')) return Response.json({ columns: [{ name: 'todo', tasks: [{ id: 'task-a', title: '账号 A', status: 'todo' }] }], tenants: ['a'], assignees: ['yaoyao'], latest_event_id: 1, now: 1 })
      if (path.includes('/tasks/task-a?')) {
        taskReads += 1
        return oldTask.promise
      }
      return Response.json({ ok: true })
    }))
    const auth = useAuthStore()
    auth.status = 'authenticated'
    auth.user = { id: 'user-a', username: 'a', role: 'admin' }
    const store = useKanbanStore()
    await store.initialize()
    const pending = store.selectTask('task-a')
    await vi.waitFor(() => expect(taskReads).toBe(1))

    auth.user = { id: 'user-b', username: 'b', role: 'admin' }
    await nextTick()
    oldTask.resolve(Response.json({ task: { id: 'task-a', title: '不应回写', status: 'todo' }, comments: [], events: [], links: { parents: [], children: [] }, runs: [] }))
    await pending

    expect(store.boards).toEqual([])
    expect(store.profiles).toEqual([])
    expect(store.selectedBoardSlug).toBe('')
    expect(store.selectedTask).toBeUndefined()
    expect(store.search).toBe('')
    expect(store.pluginVersion).toBe('')
  })

  it('does not let a completed create-board request repopulate state after reset', async () => {
    const createResponse = deferred<Response>()
    let createCalls = 0
    let boardReads = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path.endsWith('/status')) return Response.json({ available: true })
      if (path.endsWith('/boards') && method === 'GET') return Response.json({ boards: [{ slug: 'default', total: 0 }], current: 'default' })
      if (path.endsWith('/boards') && method === 'POST') {
        createCalls += 1
        return createResponse.promise
      }
      if (path.endsWith('/profiles')) return Response.json({ profiles: [] })
      if (path.includes('/board?')) {
        boardReads += 1
        return Response.json({ columns: [], tenants: [], assignees: [], latest_event_id: 0, now: 1 })
      }
      return Response.json({ ok: true })
    }))
    const auth = useAuthStore()
    auth.status = 'authenticated'
    auth.user = { id: 'admin-create-race', username: 'admin', role: 'admin' }
    const store = useKanbanStore()
    await store.initialize()
    expect(boardReads).toBe(1)

    const pending = store.createBoard({ slug: 'stale-board', name: '旧账号看板' })
    await vi.waitFor(() => expect(createCalls).toBe(1))
    store.reset()
    createResponse.resolve(Response.json({ board: { slug: 'stale-board', name: '旧账号看板' }, current: 'default' }))
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })

    expect(store.boards).toEqual([])
    expect(store.selectedBoardSlug).toBe('')
    expect(store.snapshot).toBeUndefined()
    expect(store.isMutating).toBe(false)
    expect(boardReads).toBe(1)
  })
})

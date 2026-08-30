import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addKanbanComment,
  createKanbanBoard,
  createKanbanTask,
  deleteKanbanTask,
  dispatchKanban,
  getKanbanBoard,
  getKanbanStatus,
  getKanbanTask,
  listKanbanBoards,
  listKanbanProfiles,
  updateKanbanTask,
} from '@/api/kanban'
import { setApiCsrfToken } from '@/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
  setApiCsrfToken('')
})

describe('Kanban Web client protocol', () => {
  it('keeps every browser request under the CSRF-protected app alias and scopes board reads', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      if (path.endsWith('/status')) return Response.json({ available: true, version: '1.0.0' })
      if (path.endsWith('/boards')) return Response.json({ boards: [], current: 'default', board: { slug: 'mobile-release' } })
      if (path.includes('/board?')) return Response.json({ columns: [], tenants: [], assignees: [], latest_event_id: 0, now: 1 })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [] })
      if (path.includes('/tasks/task%20%2F%20one?')) return Response.json({ task: { id: 'task / one', title: 'Task', status: 'todo' }, comments: [], events: [], links: { parents: [], children: [] }, runs: [] })
      return Response.json({ ok: true, task: { id: 'task / one', title: 'Task', status: 'ready' }, spawned: [] })
    }))
    setApiCsrfToken('csrf-kanban')

    await getKanbanStatus()
    await listKanbanBoards()
    await getKanbanBoard('mobile / 中文', true)
    await listKanbanProfiles()
    await getKanbanTask('mobile / 中文', 'task / one')
    await createKanbanBoard({ slug: 'mobile-release', name: '移动发布' })
    await createKanbanTask('mobile / 中文', { title: '实现看板', assignee: 'yaoyao' })
    await updateKanbanTask('mobile / 中文', 'task / one', { status: 'ready' })
    await addKanbanComment('mobile / 中文', 'task / one', { body: '请继续' })
    await dispatchKanban('mobile / 中文')
    await deleteKanbanTask('mobile / 中文', 'task / one')

    expect(calls.map(call => call.path)).toEqual([
      '/api/app/kanban/status',
      '/api/app/kanban/boards',
      '/api/app/kanban/board?include_archived=true&board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/profiles',
      '/api/app/kanban/tasks/task%20%2F%20one?board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/boards',
      '/api/app/kanban/tasks?board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/tasks/task%20%2F%20one?board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/tasks/task%20%2F%20one/comments?board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/dispatch?board=mobile+%2F+%E4%B8%AD%E6%96%87',
      '/api/app/kanban/tasks/task%20%2F%20one?board=mobile+%2F+%E4%B8%AD%E6%96%87',
    ])
    const mutations = calls.filter(call => !['GET', 'HEAD'].includes((call.init?.method ?? 'GET').toUpperCase()))
    expect(mutations.every(call => new Headers(call.init?.headers).get('X-CSRF-Token') === 'csrf-kanban')).toBe(true)
    expect(JSON.parse(String(calls[5]!.init?.body))).toMatchObject({ slug: 'mobile-release', switch: false })
    expect(calls.some(call => call.path.includes('/switch'))).toBe(false)
  })
})

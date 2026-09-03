// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime, mentionedAgents } from '../../src/server/workspaceRuntime'
import { WorkspaceNodes } from '../../src/server/workspaceGateway'
import { UploadStore } from '../../src/server/uploads'
import type {
  WorkspaceConversation,
  WorkspaceRun,
  WorkspaceMessage,
  WorkspaceInteraction,
} from '../../src/shared/workspace'

let home: string,
  store: WorkspaceStore,
  uploads: UploadStore,
  runtime: WorkspaceRuntime,
  server: WebSocketServer
let requests: Array<{ method: string; params: Record<string, any> }>,
  reply: (socket: WebSocket, params: Record<string, any>) => void
let nodes: WorkspaceNodes
let recoveryHistory: Array<{ role: string; content: string }>
const owner = 'first-user',
  other = 'second-user'
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-workspace-test-'))
  store = new WorkspaceStore(home)
  uploads = new UploadStore(home)
  requests = []
  recoveryHistory = []
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as { port: number }
  const target = {
    url: new URL(`http://127.0.0.1:${address.port}`),
    client: { directAgent: undefined },
    session: {
      webSocketCredential: async () => ({ name: 'ticket', value: 'test' }),
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify({ messages: recoveryHistory })),
      }),
    },
  }
  nodes = { target: () => target } as unknown as WorkspaceNodes
  runtime = new WorkspaceRuntime(store, nodes, uploads)
  reply = (socket, p) =>
    setTimeout(
      () =>
        socket.send(
          JSON.stringify({
            method: 'event',
            params: {
              type: 'message.complete',
              session_id: p.session_id,
              payload: { text: '完成', status: 'complete' },
            },
          }),
        ),
      5,
    )
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready' } }))
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      requests.push(frame)
      const respond = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result }))
      if (frame.method === 'session.create')
        respond({
          session_id: randomUUID(),
          stored_session_id: randomUUID(),
          info: { profile_name: frame.params.profile },
          running: false,
        })
      else if (frame.method === 'session.resume')
        respond({
          session_id: randomUUID(),
          stored_session_id: frame.params.session_id,
          running: false,
          info: { profile_name: frame.params.profile },
        })
      else if (frame.method === 'prompt.submit') {
        respond({ status: 'streaming' })
        reply(socket, frame.params)
      } else if (frame.method === 'session.usage') respond({ context_used: 400, context_max: 1000 })
      else respond({ ok: true, status: 'interrupted' })
    })
  })
})
afterEach(async () => {
  runtime.close()
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  uploads.close()
  store.close()
  rmSync(home, { recursive: true, force: true })
})
function agent(name: string, user = owner) {
  return store.createAgent(user, { name, profile: 'default', instructions: `规则：你是${name}` })
}
function direct(id: string, user = owner) {
  return store
    .list<WorkspaceConversation>(user, 'conversation')
    .find((c) => c.kind === 'direct' && c.memberIds[0] === id)!
}
async function finished(id: string) {
  await vi.waitFor(() =>
    expect(store.require<WorkspaceRun>(owner, 'run', id).status).toBe('complete'),
  )
  return store.require<WorkspaceRun>(owner, 'run', id)
}
describe('Web-owned workspace', () => {
  it('persists a visible failure when a fixed member loses its source node',async()=>{
    const a=agent('不可用成员'),c=direct(a.id)
    runtime.close()
    runtime=new WorkspaceRuntime(store,{target:()=>{throw new Error('基础节点不可用')}} as unknown as WorkspaceNodes,uploads)
    const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'执行任务'})
    await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('failed'))
    expect(store.messages(owner,c.id).at(-1)).toMatchObject({role:'system',status:'failed',content:'执行失败：基础节点不可用'})
    expect(store.require<WorkspaceConversation>(owner,'conversation',c.id).activeRunId).toBeUndefined()
  })
  it('interprets a reply against its launch-time roster when names or mode change mid-turn', async () => {
    const a = agent('管理员'),
      b = agent('执行者')
    const c = store.createGroup(owner, {
      name: '配置更新',
      memberIds: [a.id, b.id],
      administratorId: a.id,
      maxReplyRounds: 3,
    })
    let count = 0
    reply = (socket, p) => {
      let text = '已完成'
      if (count++ === 0) {
        store.updateAgent(owner, b.id, { name: '新名字', instructions: '新规则' })
        store.updateConversation(owner, c.id, { mode: 'free', administratorId: b.id })
        text = '请继续 @执行者'
      }
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: { type: 'message.complete', session_id: p.session_id, payload: { text } },
            }),
          ),
        5,
      )
    }
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '开始' }).id)
    expect(
      store
        .messages(owner, c.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.agentId),
    ).toEqual([a.id, b.id])
    expect(requests.filter((r) => r.method === 'prompt.submit').at(-1)!.params.text).toContain(
      '新规则',
    )
  })
  it('rejects unscoped and foreign-session completion events', async () => {
    const a = agent('会话隔离'),
      c = direct(a.id)
    reply = (socket, p) => {
      for (const session_id of [undefined, 'another-session'])
        socket.send(
          JSON.stringify({
            method: 'event',
            params: { type: 'message.complete', session_id, payload: { text: '别人的结果' } },
          }),
        )
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: {
                type: 'message.complete',
                session_id: p.session_id,
                payload: { text: '本轮结果' },
              },
            }),
          ),
        15,
      )
    }
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '执行' })
    await finished(run.id)
    expect(store.messages(owner, c.id).at(-1)?.content).toBe('本轮结果')
    expect(store.get<{ percent: number }>(owner, 'context', c.id)?.percent).toBe(40)
  })
  it('resumes a persisted uncertain run by inspecting history, without resending the prompt', async () => {
    const a = agent('恢复测试'),
      c = direct(a.id)
    reply = (socket, p) => {
      recoveryHistory = [
        { role: 'user', content: p.text },
        { role: 'assistant', content: '已经执行完成' },
      ]
      socket.terminate()
    }
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '修改一次' })
    await vi.waitFor(() =>
      expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('uncertain'),
    )
    runtime.close()
    runtime = new WorkspaceRuntime(store, nodes, uploads)
    await runtime.reconcile(owner, run.id)
    await finished(run.id)
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    expect(store.messages(owner, c.id).map((m) => m.content)).toEqual(['修改一次', '已经执行完成'])
  })
  it('routes approvals and clarifications to the owning run and ignores optional push failures', async () => {
    const a = agent('交互测试'),
      c = direct(a.id)
    runtime.onNotify = () => {
      throw new Error('push storage unavailable')
    }
    let kind = 'approval'
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const f = JSON.parse(String(data))
        if (['approval.respond', 'clarify.respond'].includes(f.method))
          socket.send(
            JSON.stringify({
              method: 'event',
              params: {
                type: 'message.complete',
                session_id: f.params.session_id,
                payload: { text: '确认后完成' },
              },
            }),
          )
      }),
    )
    reply = (socket, p) =>
      socket.send(
        JSON.stringify({
          method: 'event',
          params: {
            type: `${kind}.request`,
            session_id: p.session_id,
            payload: { request_id: 'upstream-interaction', message: '请确认' },
          },
        }),
      )
    for (kind of ['approval', 'clarify']) {
      const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '继续' })
      await vi.waitFor(() =>
        expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('waiting'),
      )
      const interaction = store
        .list<WorkspaceInteraction>(owner, 'interaction')
        .find((i) => !i.resolved)!
      await expect(runtime.respond(other, interaction.id, 'once')).rejects.toThrow('记录不存在')
      await runtime.respond(owner, interaction.id, kind === 'approval' ? 'once' : '补充说明')
      await finished(run.id)
      expect(
        store.require<WorkspaceInteraction>(owner, 'interaction', interaction.id).resolved,
      ).toBe(true)
    }
    expect(
      requests
        .filter((r) => r.method === 'approval.respond' || r.method === 'clarify.respond')
        .map((r) => r.params.request_id),
    ).toEqual(['upstream-interaction', 'upstream-interaction'])
  })
  it('creates one direct chat without importing a native profile session', () => {
    const a = agent('编辑')
    expect(direct(a.id).kind).toBe('direct')
    expect(store.list(other, 'agent')).toEqual([])
    expect(() => store.require(other, 'conversation', direct(a.id).id)).toThrow('记录不存在')
    expect(requests).toEqual([])
  })
  it('keeps membership immutable and validates member ownership', () => {
    const a = agent('甲'),
      b = agent('乙'),
      foreign = agent('外部', other)
    const c = store.createGroup(owner, {
      name: '团队',
      memberIds: [a.id, b.id],
      administratorId: a.id,
    })
    expect(() => store.updateConversation(owner, c.id, { memberIds: [b.id] })).toThrow()
    expect(() =>
      store.createGroup(owner, {
        name: '越权',
        memberIds: [a.id, foreign.id],
        administratorId: a.id,
      }),
    ).toThrow()
    store.updateAgent(owner, b.id, { archived: true })
    expect(store.require<WorkspaceConversation>(owner, 'conversation', c.id).memberIds).toEqual([
      a.id,
      b.id,
    ])
    expect(() =>
      store.createGroup(owner, { name: '新群', memberIds: [a.id, b.id], administratorId: a.id }),
    ).toThrow('已归档')
  })
  it('dispatches a request exactly once across retries and rejects payload reuse', async () => {
    const a = agent('编辑'),
      c = direct(a.id),
      requestId = randomUUID(),
      payload = { requestId, content: '检查代码' }
    const run = runtime.send(owner, c.id, payload)
    expect(runtime.send(owner, c.id, payload).id).toBe(run.id)
    expect(() => runtime.send(owner, c.id, { ...payload, content: '另一件事' })).toThrow('请求编号')
    await finished(run.id)
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    expect(store.messages(owner, c.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
  it('isolates roles over the same profile and applies edited rules on the next turn', async () => {
    const a = agent('编辑'),
      b = agent('审查'),
      ca = direct(a.id),
      cb = direct(b.id)
    const first = runtime.send(owner, ca.id, { requestId: randomUUID(), content: '编辑任务' })
    const second = runtime.send(owner, cb.id, { requestId: randomUUID(), content: '审查任务' })
    await Promise.all([finished(first.id), finished(second.id)])
    expect(requests.filter((r) => r.method === 'session.create')).toHaveLength(2)
    expect(store.messages(owner, ca.id).some((m) => m.content === '审查任务')).toBe(false)
    store.updateAgent(owner, a.id, { instructions: '最新规则：先给证据' })
    await finished(runtime.send(owner, ca.id, { requestId: randomUUID(), content: '继续' }).id)
    expect(requests.filter((r) => r.method === 'prompt.submit').at(-1)!.params.text).toContain(
      '最新规则：先给证据',
    )
    expect(requests.some((r) => r.method === 'profiles.configure')).toBe(false)
    expect(
      requests
        .filter((r) => r.method === 'session.create')
        .every((r) => r.params.hidden && r.params.source === 'yaoyao_workspace'),
    ).toBe(true)
  })
  it('executes bounded administrator delegation and keeps group sessions separate from direct chat', async () => {
    const a = agent('管理员'),
      b = agent('开发者'),
      c = store.createGroup(owner, {
        name: '开发',
        memberIds: [a.id, b.id],
        administratorId: a.id,
        maxReplyRounds: 3,
      })
    let turns = 0
    reply = (socket, p) => {
      const text = turns++ === 0 ? '请协作 @开发者' : '任务完成'
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: { type: 'message.complete', session_id: p.session_id, payload: { text } },
            }),
          ),
        5,
      )
    }
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '实现功能' }).id)
    expect(
      store
        .messages(owner, c.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.agentId),
    ).toEqual([a.id, b.id, a.id])
    expect(store.messages(owner, direct(a.id).id)).toHaveLength(0)
    expect(turns).toBe(3)
  })
  it('does not trigger delegation from quoted text or code blocks', () => {
    const a = agent('甲'),
      b = agent('乙')
    expect(mentionedAgents('> @乙\n```\n@甲\n```\n`@all`', [a, b])).toEqual([])
    expect(mentionedAgents('请处理 @乙。', [a, b])).toEqual([b.id])
  })
  it('keeps uncertain submissions blocked instead of executing tools twice', async () => {
    const a = agent('执行者'),
      c = direct(a.id)
    reply = (socket) => socket.terminate()
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '修改文件' })
    await vi.waitFor(() =>
      expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('uncertain'),
    )
    expect(() => runtime.send(owner, c.id, { requestId: randomUUID(), content: '重试' })).toThrow(
      '当前回复',
    )
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    await runtime.stop(owner, run.id)
    expect(
      store.require<WorkspaceConversation>(owner, 'conversation', c.id).activeRunId,
    ).toBeUndefined()
  })
  it('publishes durable ordered events only after commit and rolls back failed transactions', () => {
    const a = agent('甲'),
      c = direct(a.id),
      cursor = store.cursor(owner)
    expect(() =>
      store.atomic(() => {
        store.event(owner, 'test', {})
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    expect(store.cursor(owner)).toBe(cursor)
    store.updateAgent(owner, a.id, { name: '乙' })
    expect(store.events(owner, cursor).map((e) => e.type)).toEqual([
      'agent.changed',
      'conversation.changed',
    ])
    expect(store.events(other, 0)).toEqual([])
    expect(store.require<WorkspaceConversation>(owner, 'conversation', c.id).name).toBe('乙')
  })
})

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { WorkspaceStore, parse } from './workspaceStore.js'
import { WorkspaceNodes, WorkspaceGateway, type GatewayFrame } from './workspaceGateway.js'
import { HttpError } from './errors.js'
import { UploadStore } from './uploads.js'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun,
  WorkspaceInteraction,
} from '../shared/workspace.js'

type Run = WorkspaceRun & {
  queue: string[]
  next: string[]
  hostReturn: boolean
  currentMessageId?: string
  turnConfiguration?: {
    mode: 'host' | 'free'
    administratorId: string
    members: Array<Pick<Agent, 'id' | 'name'>>
  }
}
export interface WorkspaceBinding {
  id: string
  nodeId: string
  profile: string
  storedId: string
  runtimeId: string
  aliases: string[]
  runId: string
  messageId: string
}
interface LiveTurn {
  gateway: WorkspaceGateway
  runtimeId: string
  runId: string
  agentId: string
  done(error?: Error): void
}
export const sendInput = z
  .object({
    requestId: z.string().uuid(),
    content: z.string().max(65_536).default(''),
    mentionIds: z.array(z.string().uuid()).max(8).default([]),
    fileIds: z.array(z.string().uuid()).max(8).default([]),
  })
  .strict()
  .refine((b) => b.content.trim() || b.fileIds.length, '请输入消息或添加附件')
export function mentionedAgents(text: string, agents: Array<Pick<Agent, 'id' | 'name'>>): string[] {
  const plain = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n')
  if (/(?:^|\s)@all(?=$|[\s，。,:：!！?？])/i.test(plain)) return agents.map((a) => a.id)
  return agents
    .filter((a) => {
      const escaped = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s，。,:：!！?？])`, 'u').test(plain)
    })
    .map((a) => a.id)
}
export class WorkspaceRuntime {
  private live = new Map<string, LiveTurn>()
  private executing = new Set<string>()
  private closing = false
  onMessage: (owner: string, message: Message) => Promise<void> = async () => {}
  onNotify: (
    owner: string,
    c: Conversation,
    run: Run,
    message?: Message,
    interaction?: WorkspaceInteraction,
  ) => void = () => {}
  private notify(
    owner: string,
    c: Conversation,
    run: Run,
    message?: Message,
    interaction?: WorkspaceInteraction,
  ): void {
    try {
      this.onNotify(owner, c, run, message, interaction)
    } catch {
      /* Optional push failures never change the durable execution result. */
    }
  }
  constructor(
    readonly store: WorkspaceStore,
    readonly nodes: WorkspaceNodes,
    readonly uploads: UploadStore,
    readonly userActive: (owner: string) => boolean = () => true,
  ) {
    // An admitted but unacknowledged turn may already have executed a tool.
    for (const owner of store.owners())
      for (const run of store.list<Run>(owner, 'run')) {
        if (['running', 'waiting'].includes(run.status)) {
          run.status = 'uncertain'
          run.error = '服务已重启，请核对运行状态'
          store.saveRun(owner, run)
        }
      }
  }
  start(): void {
    for (const owner of this.store.owners())
      for (const run of this.store.list<Run>(owner, 'run')) {
        if (run.status === 'queued') void this.execute(owner, run.id)
        else if (run.status === 'uncertain') void this.reconcile(owner, run.id).catch(() => {})
      }
  }
  send(owner: string, conversationId: string, input: unknown): Run {
    const body = parse(sendInput, input)
    const result = this.store.command(owner, body.requestId, { conversationId, ...body }, () => {
      const c = this.store.require<Conversation>(owner, 'conversation', conversationId)
      if (c.archived) throw new HttpError(409, '聊天已归档', 'conversation_archived')
      if (c.activeRunId) throw new HttpError(409, '请等待当前回复结束或先停止', 'conversation_busy')
      if (body.mentionIds.some((a) => !c.memberIds.includes(a)))
        throw new HttpError(400, '只能 @ 群内成员', 'invalid_mentions')
      const records = this.uploads.records(body.fileIds, owner)
      const now = Date.now(),
        runId = randomUUID(),
        agents = c.memberIds.map((id) => this.store.require<Agent>(owner, 'agent', id))
      const mentions = [
        ...new Set(
          body.mentionIds.length ? body.mentionIds : mentionedAgents(body.content, agents),
        ),
      ]
      const queue =
        c.kind === 'direct'
          ? [...c.memberIds]
          : mentions.length
            ? mentions
            : c.mode === 'free' && c.autoReplyIds.length
              ? [...c.autoReplyIds]
              : [c.administratorId]
      const message: Message = {
        id: randomUUID(),
        conversationId,
        seq: 0,
        role: 'user',
        content: body.content.trim(),
        reasoning: '',
        runId,
        status: 'complete',
        attachments: records.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          sender: 'user',
          createdAt: now,
        })),
        tools: [],
        createdAt: now,
      }
      this.store.saveMessage(owner, message)
      for (const file of records) {
        const existing = this.store.get<Record<string, unknown>>(owner, 'file', file.id)
        if (existing)
          this.store.put(owner, 'file', file.id, {
            ...existing,
            conversationId,
            messageId: message.id,
          })
      }
      const run: Run = {
        id: runId,
        conversationId,
        messageId: message.id,
        mentionIds: mentions,
        activeAgentId: queue[0],
        status: 'queued',
        round: 0,
        queue,
        next: [],
        hostReturn: c.mode === 'host' && queue.some((id) => id !== c.administratorId),
        createdAt: now,
        updatedAt: now,
      }
      this.store.saveRun(owner, run)
      this.uploads.markReferenced(body.fileIds, owner)
      return run
    })
    if (this.store.require<Run>(owner, 'run', result.id).status === 'queued')
      void this.execute(owner, result.id)
    return this.store.require<Run>(owner, 'run', result.id)
  }
  private async execute(owner: string, id: string): Promise<void> {
    if (this.executing.has(id) || this.closing) return
    this.executing.add(id)
    try {
      while (!this.closing) {
        const run = this.store.require<Run>(owner, 'run', id)
        if (!['queued', 'running'].includes(run.status)) break
        if (!this.userActive(owner)) throw new HttpError(403, '账号已停用', 'account_disabled')
        const c = this.store.require<Conversation>(owner, 'conversation', run.conversationId)
        if (!run.queue.length) {
          if (
            c.kind === 'direct' ||
            run.round + 1 >= c.maxReplyRounds ||
            (!run.next.length && !run.hostReturn)
          ) {
            run.status = 'complete'
            this.store.saveRun(owner, run)
            this.notify(
              owner,
              c,
              run,
              this.store
                .messages(owner, c.id)
                .filter((m) => m.runId === id && m.role === 'assistant')
                .at(-1),
            )
            break
          }
          run.round += 1
          run.queue = run.hostReturn ? [c.administratorId] : [...new Set(run.next)]
          run.hostReturn = false
          run.next = []
          this.store.saveRun(owner, run)
        }
        const agent = this.store.require<Agent>(owner, 'agent', run.queue[0]!)
        run.turnConfiguration = {
          mode: c.mode,
          administratorId: c.administratorId,
          members: c.memberIds.map((id) => {
            const a = this.store.require<Agent>(owner, 'agent', id)
            return { id: a.id, name: a.name }
          }),
        }
        run.status = 'running'
        run.activeAgentId = agent.id
        this.store.saveRun(owner, run)
        const message = await this.turn(owner, c, agent, run)
        await this.onMessage(owner, message).catch(() => {})
        if (this.closing) return
        this.advance(owner, run.id, agent.id, message)
      }
    } catch (error) {
      if (!this.closing) {
        const run = this.store.require<Run>(owner, 'run', id)
        if (!['interrupted', 'uncertain'].includes(run.status)) {
          run.status = 'failed'
          run.error = (error instanceof Error ? error.message : '执行失败').slice(0, 1000)
          this.store.saveRun(owner, run)
          this.store.saveMessage(owner, {
            id:randomUUID(), conversationId:run.conversationId, seq:0, role:'system',
            content:`执行失败：${run.error}`, reasoning:'', runId:run.id, status:'failed',
            attachments:[], tools:[], createdAt:Date.now(),
          })
          this.notify(owner, this.store.require(owner, 'conversation', run.conversationId), run)
        }
      }
    } finally {
      this.executing.delete(id)
    }
  }
  private advance(owner: string, runId: string, agentId: string, message: Message): void {
    this.store.atomic(() => {
      const run = this.store.require<Run>(owner, 'run', runId)
      if (run.status === 'interrupted') return
      const c = this.store.require<Conversation>(owner, 'conversation', run.conversationId)
      const configuration = run.turnConfiguration
      if (!configuration) throw new Error('运行配置缺失，已停止自动协作')
      if (configuration.mode === 'free' || agentId === configuration.administratorId)
        run.next.push(
          ...mentionedAgents(message.content, configuration.members).filter((id) => id !== agentId),
        )
      if (
        c.kind === 'group' &&
        configuration.mode === 'host' &&
        agentId !== configuration.administratorId
      )
        run.hostReturn = true
      if (run.queue[0] === agentId) run.queue.shift()
      run.activeAgentId = run.queue[0]
      run.currentMessageId = undefined
      run.error = undefined
      run.status = 'running'
      this.store.saveRun(owner, run)
    })
  }
  private async turn(
    owner: string,
    c: Conversation,
    agent: Agent,
    run: Run,
    recovering = false,
  ): Promise<Message> {
    const key = `${c.id}:${agent.id}`,
      target = this.nodes.target(owner, agent.nodeId)
    const gateway = new WorkspaceGateway(target)
    run.activeAgentId = agent.id
    this.store.saveRun(owner, run)
    let binding = this.store.get<WorkspaceBinding>(owner, 'binding', key)
    let message =
      recovering && run.currentMessageId
        ? this.store.require<Message>(owner, 'message', run.currentMessageId)
        : undefined
    if (!message) {
      message = {
        id: randomUUID(),
        conversationId: c.id,
        seq: 0,
        role: 'assistant',
        agentId: agent.id,
        agentName: agent.name,
        content: '',
        reasoning: '',
        status: 'streaming',
        runId: run.id,
        tools: [],
        attachments: [],
        createdAt: Date.now(),
      }
      run.currentMessageId = message.id
      this.store.atomic(() => {
        this.store.saveMessage(owner, message!)
        this.store.saveRun(owner, run)
      })
    }
    const resultMessage = message
    let submitted = recovering,
      settled = false,
      completedEvidence = false,
      completing = false,
      runtimeId = '',
      lastFlush = 0
    let resolveTurn!: (m: Message) => void, rejectTurn!: (e: Error) => void
    const completion = new Promise<Message>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    // Register rejection immediately; setup RPCs can still be awaiting a reply.
    void completion.catch(() => {})
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      this.live.delete(key)
      if (error) {
        const current = this.store.require<Run>(owner, 'run', run.id)
        resultMessage.status =
          current.status === 'interrupted' ? 'interrupted' : submitted ? 'uncertain' : 'failed'
        if (submitted && current.status !== 'interrupted') {
          current.status = 'uncertain'
          current.error = '执行状态待确认，未自动重发'
          this.store.saveRun(owner, current)
        }
        this.store.saveMessage(owner, resultMessage)
        rejectTurn(error)
      } else {
        resultMessage.status = 'complete'
        this.store.saveMessage(owner, resultMessage)
        resolveTurn(resultMessage)
      }
      gateway.close()
    }
    gateway.onDisconnect = () =>
      finish(completedEvidence ? undefined : new Error('Hermes 连接断开'))
    gateway.onEvent = (frame: GatewayFrame) => {
      if (settled || !runtimeId || frame.session_id !== runtimeId) return
      const p = frame.payload ?? {},
        type = frame.type
      if (type === 'message.delta') resultMessage.content += String(p.text ?? p.delta ?? '')
      else if (type === 'reasoning.delta')
        resultMessage.reasoning += String(p.text ?? p.delta ?? '')
      else if (type === 'message.interim') {
        resultMessage.content += '\n\n'
      } else if (type.startsWith('tool.')) {
        const id = String(p.tool_id ?? p.id ?? ''),
          index = resultMessage.tools.findIndex((t) => t.id === id)
        const value = { ...p, id, status: type }
        if (index >= 0) resultMessage.tools[index] = { ...resultMessage.tools[index], ...value }
        else resultMessage.tools.push(value)
      } else if (
        ['approval.request', 'approval.requested', 'clarify.request', 'clarify.requested'].includes(
          type,
        )
      ) {
        const upstreamId = String(p.request_id ?? p.requestId ?? p.id ?? '')
        const interaction: WorkspaceInteraction = {
          id: randomUUID(),
          conversationId: c.id,
          runId: run.id,
          agentId: agent.id,
          kind: type.startsWith('approval') ? 'approval' : 'clarification',
          message: String(p.question ?? p.message ?? p.prompt ?? '需要确认'),
          choices: Array.isArray(p.choices) ? p.choices.map(String) : [],
          resolved: false,
        }
        this.store.put(owner, 'interaction', interaction.id, interaction)
        this.store.put(owner, 'interaction-binding', interaction.id, { key, upstreamId })
        this.store.event(owner, 'interaction.changed', interaction, c.id)
        const current = this.store.require<Run>(owner, 'run', run.id)
        current.status = 'waiting'
        this.store.saveRun(owner, current)
        this.notify(owner, c, current, undefined, interaction)
      } else if (['message.complete', 'run.completed'].includes(type)) {
        if (typeof p.text === 'string') resultMessage.content = p.text
        if (p.status === 'interrupted') {
          const current = this.store.require<Run>(owner, 'run', run.id)
          current.status = 'interrupted'
          this.store.saveRun(owner, current)
          finish(new Error('已停止'))
        } else if (p.error || p.status === 'failed') {
          submitted = false
          finish(new HttpError(502, String(p.error ?? '运行失败'), 'run_failed'))
        } else if (!completing) {
          completedEvidence = true
          completing = true
          let timeout: ReturnType<typeof setTimeout>
          void Promise.race([
            gateway.rpc('session.usage', { session_id: runtimeId }),
            new Promise<undefined>((resolve) => {
              timeout = setTimeout(() => resolve(undefined), 1000)
            }),
          ])
            .then((usage) => {
              if (usage && !this.closing) {
                const used = usage.context_used ?? usage.used_tokens,
                  limit = usage.context_max ?? usage.context_limit
                this.store.put(owner, 'context', c.id, {
                  ...usage,
                  usedTokens: used,
                  limitTokens: limit,
                  percent:
                    typeof used === 'number' && typeof limit === 'number' && limit > 0
                      ? Math.round((used / limit) * 1000) / 10
                      : undefined,
                })
                this.store.event(
                  owner,
                  'context.changed',
                  this.store.get(owner, 'context', c.id),
                  c.id,
                )
              }
            })
            .catch(() => {})
            .finally(() => {
              clearTimeout(timeout)
              finish()
            })
        }
        return
      } else if (['error', 'message.error', 'run.failed'].includes(type)) {
        submitted = false
        finish(new HttpError(502, String(p.message ?? p.error ?? '运行失败'), 'run_failed'))
        return
      } else if (['session.usage', 'usage.update', 'context.update'].includes(type)) {
        this.store.put(owner, 'context', c.id, p)
        this.store.event(owner, 'context.changed', p, c.id)
      } else if (type === 'session.info' && binding) {
        const storedId = p.stored_session_id ?? p.session_key
        if (typeof storedId === 'string' && storedId && storedId !== binding.storedId) {
          binding.aliases = [...new Set([...binding.aliases, binding.storedId, storedId])]
          binding.storedId = storedId
          this.store.put(owner, 'binding', key, binding)
        }
      }
      if (Date.now() - lastFlush >= 100) {
        this.store.saveMessage(owner, resultMessage)
        lastFlush = Date.now()
      }
    }
    try {
      await gateway.connect()
      const opened = binding?.storedId
        ? await gateway.rpc('session.resume', {
            profile: agent.profile,
            session_id: binding.storedId,
            omit_messages: true,
            close_on_disconnect: false,
          })
        : await gateway.rpc('session.create', {
            profile: agent.profile,
            title: `Yaoyao ${c.id}`,
            source: 'yaoyao_workspace',
            hidden: true,
            room_plumbing: true,
            close_on_disconnect: false,
          })
      runtimeId = String(opened.session_id ?? '')
      const storedId = String(
        opened.stored_session_id ?? opened.session_key ?? opened.resumed ?? binding?.storedId ?? '',
      )
      if (
        !runtimeId ||
        !storedId ||
        (opened.info?.profile_name && opened.info.profile_name !== agent.profile)
      )
        throw new Error('Hermes 会话身份不匹配')
      binding = {
        id: key,
        nodeId: agent.nodeId,
        profile: agent.profile,
        storedId,
        runtimeId,
        aliases: [
          ...new Set([
            ...(binding?.aliases ?? []),
            ...(binding ? [binding.storedId] : []),
            storedId,
          ]),
        ],
        runId: run.id,
        messageId: resultMessage.id,
      }
      this.store.put(owner, 'binding', key, binding)
      this.live.set(key, { gateway, runtimeId, runId: run.id, agentId: agent.id, done: finish })
      if (this.closing || this.store.require<Run>(owner, 'run', run.id).status === 'interrupted')
        throw new Error('运行已停止')
      if (recovering) {
        if (opened.running) {
          const current = this.store.require<Run>(owner, 'run', run.id)
          current.status = 'running'
          this.store.saveRun(owner, current)
        } else {
          const response = await target.session.request(
            `/api/sessions/${encodeURIComponent(storedId)}/messages`,
            {
              search: new URLSearchParams({
                profile: agent.profile,
                limit: '500',
                order: 'latest',
                include_compacted: 'true',
              }),
            },
          )
          if (response.status !== 200) throw new Error('无法核对历史')
          const history = JSON.parse(response.body.toString()).messages ?? []
          const marker = `[yaoyao-run:${run.id}:${resultMessage.id}]`
          const index = history.findLastIndex(
            (m: any) => m.role === 'user' && String(m.content ?? m.text).includes(marker),
          )
          const answer =
            index >= 0
              ? history
                  .slice(index + 1)
                  .filter((m: any) => m.role === 'assistant' && (m.content || m.text))
                  .at(-1)
              : undefined
          if (!answer) throw new Error('无法确认本轮是否执行完成，请检查后停止此轮')
          resultMessage.content = String(answer.content ?? answer.text)
          finish()
        }
      } else {
        if (opened.running) throw new HttpError(409, '上游会话仍在运行', 'session_busy')
        const trigger = this.store.require<Message>(owner, 'message', run.messageId)
        const attachmentRefs: string[] = []
        for (const file of trigger.attachments) {
          const record = this.uploads.records([file.id], owner)[0]!
          const bytes = readFileSync(record.path).toString('base64')
          const attached = record.mimeType.startsWith('image/')
            ? await gateway.rpc('image.attach_bytes', {
                session_id: runtimeId,
                filename: record.name,
                content_base64: bytes,
              })
            : await gateway.rpc('file.attach', {
                session_id: runtimeId,
                name: record.name,
                data_url: `data:${record.mimeType};base64,${bytes}`,
              })
          if (attached.ref_text) attachmentRefs.push(String(attached.ref_text))
        }
        const members = run.turnConfiguration!.members
        const rules = [
          `你是 ${agent.name}。以下是用户为这个独立 Agent 配置的角色与规则（版本 ${agent.revision}）：\n${agent.instructions}`,
          c.kind === 'group'
            ? `你正在群聊「${c.name}」发言。群成员：${members.map((a) => `@${a.name} (id=${a.id})`).join('、')}。\n群规则：${c.instructions}\n${c.mode === 'host' ? (agent.id === c.administratorId ? '你是管理员。必要时用精确 @成员名称 委派工作；收到结果后复核并给用户结论。任务完成时不要继续 @。' : '执行当前委派任务。公开给出结果，由管理员复核；不要安排其他成员。') : '按自己的职责回复，只在需要协作时 @成员。不要重复已完成的工作。'}`
            : '',
          '角色规则不赋予额外工具权限；仍遵守基础 Hermes 的工具和安全约束。',
          `[yaoyao-run:${run.id}:${resultMessage.id}]`,
        ]
          .filter(Boolean)
          .join('\n\n')
        const text =
          c.kind === 'group'
            ? this.store
                .messages(owner, c.id)
              .filter((m) => !['queued','streaming'].includes(m.status))
                .map(
                  (m) => `${m.role === 'user' ? '用户' : (m.agentName ?? 'Agent')}：${m.content}`,
                )
                .join('\n\n')
            : trigger.content
        submitted = true
        await gateway.rpc('prompt.submit', {
          session_id: runtimeId,
          text: `${rules}\n\n${text}\n${attachmentRefs.join('\n')}`,
        })
      }
      return await completion
    } catch (error) {
      finish(error instanceof Error ? error : new Error('执行失败'))
      return await completion
    }
  }
  async respond(owner: string, id: string, answer: string): Promise<void> {
    const interaction = this.store.require<WorkspaceInteraction>(owner, 'interaction', id)
    if (interaction.resolved) return
    const b = this.store.require<{ key: string; upstreamId: string }>(
        owner,
        'interaction-binding',
        id,
      ),
      live = this.live.get(b.key)
    if (!live || live.runId !== interaction.runId)
      throw new HttpError(409, '请先恢复此轮连接', 'interaction_offline')
    if (
      interaction.kind === 'approval' &&
      !['once', 'always', 'deny', 'allow', 'approve'].includes(answer)
    )
      throw new HttpError(400, '审批选项无效', 'invalid_approval')
    await live.gateway.rpc(
      interaction.kind === 'approval' ? 'approval.respond' : 'clarify.respond',
      {
        session_id: live.runtimeId,
        request_id: b.upstreamId,
        ...(interaction.kind === 'approval' ? { choice: answer } : { answer }),
      },
    )
    interaction.resolved = true
    this.store.put(owner, 'interaction', id, interaction)
    this.store.event(owner, 'interaction.changed', interaction, interaction.conversationId)
    const run = this.store.require<Run>(owner, 'run', interaction.runId)
    run.status = 'running'
    this.store.saveRun(owner, run)
  }
  async stop(owner: string, id: string): Promise<void> {
    const run = this.store.require<Run>(owner, 'run', id)
    if (['complete', 'failed', 'interrupted'].includes(run.status)) return
    let live = [...this.live.values()].find((t) => t.runId === id)
    if (live) {
      await live.gateway.rpc('session.interrupt', { session_id: live.runtimeId })
      run.status = 'interrupted'
      this.store.saveRun(owner, run)
      live.done(new Error('已停止'))
    } else {
      const bindings = this.store
        .list<WorkspaceBinding>(owner, 'binding')
        .filter((b) => b.runId === id)
      for (const b of bindings) {
        const g = new WorkspaceGateway(this.nodes.target(owner, b.nodeId))
        try {
          await g.connect()
          const s = await g.rpc('session.resume', {
            profile: b.profile,
            session_id: b.storedId,
            close_on_disconnect: false,
            omit_messages: true,
          })
          if (s.running) await g.rpc('session.interrupt', { session_id: s.session_id })
        } finally {
          g.close()
        }
      }
      run.status = 'interrupted'
      this.store.saveRun(owner, run)
    }
    for (const i of this.store
      .list<WorkspaceInteraction>(owner, 'interaction')
      .filter((i) => i.runId === id && !i.resolved)) {
      i.resolved = true
      this.store.put(owner, 'interaction', i.id, i)
      this.store.event(owner, 'interaction.changed', i, i.conversationId)
    }
  }
  async reconcile(owner: string, id: string): Promise<void> {
    if (this.executing.has(id) || this.closing) return
    const run = this.store.require<Run>(owner, 'run', id)
    if (run.status !== 'uncertain' || !run.currentMessageId || !run.queue.length) return
    this.executing.add(id)
    try {
      const agent = this.store.require<Agent>(owner, 'agent', run.queue[0]!),
        c = this.store.require<Conversation>(owner, 'conversation', run.conversationId)
      const message = await this.turn(owner, c, agent, run, true)
      this.advance(owner, id, agent.id, message)
    } finally {
      this.executing.delete(id)
    }
    await this.execute(owner, id)
  }
  close(): void {
    this.closing = true
    for (const t of this.live.values()) {
      t.gateway.close()
      t.done(new Error('服务关闭'))
    }
    this.live.clear()
  }
}

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { notificationPlainText } from './notificationText.js'
import { decodeAgentMascotAvatar, isAgentImageAvatar, defaultAgentIdentity, encodeAgentAvatar } from '../shared/agentIdentity.js'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun as Run,
  WorkspaceEvent,
} from '../shared/workspace.js'

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[\u0000-\u001f@]/.test(v), '名称不能包含 @ 或控制字符')
const avatar = z
  .string()
  .max(2_800_000)
  .refine(
    (v) => !v || isAgentImageAvatar(v) || !!decodeAgentMascotAvatar(v) || /^builtin:team-animal:(fox|whale|owl|rabbit|bear)$/.test(v),
    '请选择有效的内置头像或 PNG、JPEG、WebP 图片',
  )
export const agentInput = z
  .object({
    name,
    avatar: avatar.default(''),
    instructions: z.string().max(24_000).default(''),
    nodeId: z.string().default('local'),
    profile: z.string().min(1).max(256),
  })
  .strict()
export const agentPatch = z
  .object({
    name: name.optional(),
    avatar: avatar.optional(),
    instructions: z.string().max(24_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
const memberRoles = z.record(z.string().uuid(), z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
}).strict()).refine(value => Object.keys(value).length <= 8, '最多 8 个群内角色')
export const groupInput = z
  .object({
    name,
    avatar: avatar.default(''),
    memberIds: z.array(z.string().uuid()).min(2).max(8),
    memberRoles: memberRoles.default({}),
    instructions: z.string().max(24_000).default(''),
    administratorId: z.string().uuid(),
    mode: z.enum(['host', 'free']).default('host'),
    autoReplyIds: z.array(z.string().uuid()).max(8).default([]),
    maxReplyRounds: z.number().int().min(1).max(100).default(3),
  })
  .strict()
export const conversationPatch = z
  .object({
    name: name.optional(),
    avatar: avatar.optional(),
    instructions: z.string().max(24_000).optional(),
    memberIds: z.array(z.string().uuid()).min(1).max(8).optional(),
    memberRoles: memberRoles.optional(),
    administratorId: z.string().uuid().optional(),
    mode: z.enum(['host', 'free']).optional(),
    autoReplyIds: z.array(z.string().uuid()).max(8).optional(),
    maxReplyRounds: z.number().int().min(1).max(100).optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      'invalid_workspace_request',
    )
  return parsed.data
}
export class WorkspaceStore {
  readonly db: DatabaseSync
  readonly changes = new EventEmitter()
  private transactionEvents: Array<{ owner: string; event: WorkspaceEvent }> | undefined
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, 'workspace.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace_entities(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,kind,id));
      CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,type TEXT NOT NULL,conversation_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_events_owner ON workspace_events(owner,seq);
      CREATE TABLE IF NOT EXISTS workspace_commands(owner TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));`)
    this.changes.setMaxListeners(0)
  }
  get<T>(owner: string, kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM workspace_entities WHERE owner=? AND kind=? AND id=?')
      .get(owner, kind, id)
    return row ? (JSON.parse(String(row.data)) as T) : undefined
  }
  require<T>(owner: string, kind: string, id: string): T {
    const value = this.get<T>(owner, kind, id)
    if (!value) throw new HttpError(404, '记录不存在', 'workspace_not_found')
    return value
  }
  list<T>(owner: string, kind: string): T[] {
    return this.db
      .prepare('SELECT data FROM workspace_entities WHERE owner=? AND kind=?')
      .all(owner, kind)
      .map((r) => JSON.parse(String(r.data)) as T)
  }
  owners(): string[] {
    return this.db
      .prepare('SELECT DISTINCT owner FROM workspace_entities')
      .all()
      .map((r) => String(r.owner))
  }
  put(owner: string, kind: string, id: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO workspace_entities VALUES(?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(owner, kind, id, JSON.stringify(value))
  }
  remove(owner: string, kind: string, id: string): void {
    this.db
      .prepare('DELETE FROM workspace_entities WHERE owner=? AND kind=? AND id=?')
      .run(owner, kind, id)
  }
  atomic<T>(fn: () => T): T {
    if (this.transactionEvents) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionEvents = []
    try {
      const result = fn()
      this.db.exec('COMMIT')
      const events = this.transactionEvents
      this.transactionEvents = undefined
      for (const entry of events) this.changes.emit(entry.owner, entry.event)
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.transactionEvents = undefined
      throw error
    }
  }
  event(owner: string, type: string, data: unknown, conversationId?: string): number {
    const seq = Number(
      this.db
        .prepare('INSERT INTO workspace_events(owner,type,conversation_id,data) VALUES(?,?,?,?)')
        .run(owner, type, conversationId ?? null, JSON.stringify(data)).lastInsertRowid,
    )
    const event = { seq, type, conversationId, data }
    if (this.transactionEvents) this.transactionEvents.push({ owner, event })
    else this.changes.emit(owner, event)
    return seq
  }
  events(owner: string, after: number): WorkspaceEvent[] {
    return this.db
      .prepare('SELECT * FROM workspace_events WHERE owner=? AND seq>? ORDER BY seq LIMIT 250')
      .all(owner, after)
      .map((r) => ({
        seq: Number(r.seq),
        type: String(r.type),
        conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
        data: JSON.parse(String(r.data)),
      }))
  }
  cursor(owner: string): number {
    return Number(
      this.db
        .prepare('SELECT coalesce(max(seq),0) AS n FROM workspace_events WHERE owner=?')
        .get(owner)!.n,
    )
  }
  command<T>(owner: string, id: string, payload: unknown, fn: () => T): T {
    parse(z.string().uuid(), id)
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return this.atomic(() => {
      const old = this.db
        .prepare('SELECT fingerprint,result FROM workspace_commands WHERE owner=? AND id=?')
        .get(owner, id)
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(409, '请求编号已用于其他内容', 'idempotency_conflict')
        return JSON.parse(String(old.result)) as T
      }
      const result = fn()
      this.db
        .prepare('INSERT INTO workspace_commands VALUES(?,?,?,?)')
        .run(owner, id, fingerprint, JSON.stringify(result))
      return result
    })
  }
  createAgent(owner: string, input: unknown): Agent {
    const body = parse(agentInput, input)
    return this.atomic(() => {
      if (
        this.list<Agent>(owner, 'agent').some(
          (a) => a.name.toLocaleLowerCase() === body.name.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, 'Agent 名称已存在', 'duplicate_agent_name')
      const now = Date.now(),
        id = randomUUID()
      const agent: Agent = {
        ...body,
        id,
        archived: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      this.put(owner, 'agent', id, agent)
      const conversation: Conversation = {
        id: randomUUID(),
        kind: 'direct',
        name: agent.name,
        avatar: agent.avatar,
        memberIds: [id],
        instructions: '',
        administratorId: id,
        mode: 'host',
        autoReplyIds: [],
        maxReplyRounds: 1,
        archived: false,
        pinned: false,
        readSeq: 0,
        lastSeq: 0,
        preview: '',
        createdAt: now,
        updatedAt: now,
      }
      this.put(owner, 'conversation', conversation.id, conversation)
      this.event(owner, 'agent.changed', agent)
      this.event(owner, 'conversation.changed', conversation, conversation.id)
      return agent
    })
  }
  updateAgent(owner: string, id: string, input: unknown): Agent {
    const patch = parse(agentPatch, input)
    return this.atomic(() => {
      const agent = this.require<Agent>(owner, 'agent', id)
      if (
        patch.name &&
        this.list<Agent>(owner, 'agent').some(
          (a) => a.id !== id && a.name.toLocaleLowerCase() === patch.name!.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, 'Agent 名称已存在', 'duplicate_agent_name')
      const next = { ...agent, ...patch, revision: agent.revision + 1, updatedAt: Date.now() }
      this.put(owner, 'agent', id, next)
      this.event(owner, 'agent.changed', next)
      for (const c of this.list<Conversation>(owner, 'conversation').filter(
        (c) => c.kind === 'direct' && c.memberIds[0] === id,
      )) {
        Object.assign(c, { name: next.name, avatar: next.avatar, archived: next.archived })
        this.put(owner, 'conversation', c.id, c)
        this.event(owner, 'conversation.changed', c, c.id)
      }
      return next
    })
  }
  createGroup(owner: string, input: unknown): Conversation {
    const body = parse(groupInput, input)
    const ids = new Set(body.memberIds)
    if (
      ids.size !== body.memberIds.length ||
      !ids.has(body.administratorId) ||
      body.autoReplyIds.some((id) => !ids.has(id)) ||
      Object.keys(body.memberRoles).some(id => !ids.has(id))
    )
      throw new HttpError(400, '群成员或管理员无效', 'invalid_members')
    for (const id of ids)
      if (this.require<Agent>(owner, 'agent', id).archived)
        throw new HttpError(409, '已归档 Agent 不能加入新群', 'agent_archived')
    const now = Date.now()
    const c: Conversation = {
      ...body,
      id: randomUUID(),
      kind: 'group',
      archived: false,
      pinned: false,
      readSeq: 0,
      lastSeq: 0,
      preview: '',
      createdAt: now,
      updatedAt: now,
    }
    this.atomic(() => {
      this.put(owner, 'conversation', c.id, c)
      this.event(owner, 'conversation.changed', c, c.id)
    })
    return c
  }
  updateConversation(owner: string, id: string, input: unknown): Conversation {
    const patch = parse(conversationPatch, input),
      c = this.require<Conversation>(owner, 'conversation', id)
    if (c.kind === 'direct' && Object.keys(patch).some((k) => k !== 'pinned'))
      throw new HttpError(400, '请编辑 Agent 资料', 'edit_agent_instead')
    const memberIds = patch.memberIds ?? c.memberIds
    const members = new Set(memberIds)
    if (!members.has(c.administratorId))
      throw new HttpError(400, '当前管理员不能移除，请先更换管理员并保存', 'administrator_required')
    if (
      members.size !== memberIds.length ||
      !members.has(patch.administratorId ?? c.administratorId) ||
      patch.autoReplyIds?.some((a) => !members.has(a) && !c.memberIds.includes(a)) ||
      Object.keys(patch.memberRoles ?? {}).some(a => !members.has(a) && !c.memberIds.includes(a))
    )
      throw new HttpError(400, '群成员或管理员无效', 'invalid_members')
    for (const memberId of memberIds) {
      const agent = this.require<Agent>(owner, 'agent', memberId)
      if (!c.memberIds.includes(memberId) && agent.archived)
        throw new HttpError(409, '已归档 Agent 不能加入群聊', 'agent_archived')
    }
    const next = {
      ...c, ...patch, memberIds,
      autoReplyIds: (patch.autoReplyIds ?? c.autoReplyIds).filter(a => members.has(a)),
      memberRoles: Object.fromEntries(Object.entries(patch.memberRoles ?? c.memberRoles ?? {}).filter(([id]) => members.has(id))),
      updatedAt: Date.now(),
    }
    this.atomic(() => {
      this.put(owner, 'conversation', id, next)
      this.event(owner, 'conversation.changed', next, id)
    })
    return next
  }
  messages(
    owner: string,
    conversationId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
  ): Message[] {
    this.require(owner, 'conversation', conversationId)
    return this.db
      .prepare(
        `SELECT data FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.seq')<? ORDER BY json_extract(data,'$.seq') DESC LIMIT ?`,
      )
      .all(owner, conversationId, before, limit)
      .map((r) => JSON.parse(String(r.data)) as Message)
      .reverse()
  }
  saveMessage(owner: string, message: Message): void {
    this.atomic(() => {
      const c = this.require<Conversation>(owner, 'conversation', message.conversationId)
      if (!message.seq) message.seq = c.lastSeq + 1
      c.lastSeq = Math.max(c.lastSeq, message.seq)
      c.updatedAt = Date.now()
      c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, message.createdAt)
      c.preview = notificationPlainText(message.content, { maximum: 160, fallback: '' })
      this.put(owner, 'message', message.id, message)
      this.put(owner, 'conversation', c.id, c)
      this.event(owner, 'message.changed', message, c.id)
      this.event(owner, 'conversation.changed', c, c.id)
    })
  }
  agentSummary(agent: Agent): Agent {
    return { ...agent, avatar: agent.avatar || encodeAgentAvatar(defaultAgentIdentity(agent.id, agent.name)) }
  }
  conversationSummary(owner: string, conversation: Conversation): Conversation {
    const member = conversation.kind === 'direct' ? this.get<Agent>(owner, 'agent', conversation.memberIds[0] ?? '') : undefined
    return {
      ...conversation,
      ...(member ? { avatar: this.agentSummary(member).avatar } : {}),
      lastMessageAt: conversation.lastMessageAt
        ?? (conversation.lastSeq > 0 ? this.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 1).at(-1)?.createdAt : undefined)
        ?? conversation.createdAt,
    }
  }
  saveRun(owner: string, run: Run): void {
    this.atomic(() => {
      const c = this.require<Conversation>(owner, 'conversation', run.conversationId)
      const terminal = ['complete', 'failed', 'interrupted'].includes(run.status)
      c.activeRunId = terminal ? undefined : run.id
      c.activeAgentId = terminal ? undefined : run.activeAgentId
      c.activeRunStatus = terminal ? undefined : run.status
      run.updatedAt = Date.now()
      this.put(owner, 'run', run.id, run)
      this.put(owner, 'conversation', c.id, c)
      this.event(owner, 'run.changed', run, c.id)
      this.event(owner, 'conversation.changed', c, c.id)
    })
  }
  ownsUpstream(id: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM workspace_entities WHERE kind='binding' AND (json_extract(data,'$.storedId')=? OR json_extract(data,'$.runtimeId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.aliases')) WHERE value=?)) LIMIT 1`,
        )
        .get(id, id, id),
    )
  }
  close(): void {
    this.changes.removeAllListeners()
    this.db.close()
  }
}

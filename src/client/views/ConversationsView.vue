<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceShell from '@/components/app/WorkspaceShell.vue'
import ConversationList from '@/components/workspace/ConversationList.vue'
import WorkspaceNodesPanel from '@/components/workspace/WorkspaceNodesPanel.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { apiRequest } from '@/api/client'
import type { JsonValue } from '@shared/types'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun as Run,
  WorkspaceInteraction as Interaction,
  WorkspaceSource as Source,
  WorkspaceFile,
  WorkspaceEvent,
} from '@shared/workspace'
const auth = useAuthStore(),
  theme = useThemeStore(),
  route = useRoute(),
  router = useRouter()
const agents = ref<Agent[]>([]),
  conversations = ref<Conversation[]>([]),
  messages = ref<Message[]>([]),
  sources = ref<Source[]>([])
const active = ref<Conversation>(),
  run = ref<Run | null>(null),
  interactions = ref<Interaction[]>([]),
  context = ref<Record<string, unknown> | null>(null)
const text = ref(''),
  error = ref(''),
  busy = ref(false),
  loading = ref(false),
  files = ref<WorkspaceFile[]>([]),
  mentions = ref<string[]>([]),
  older = ref(true)
const showNodes = ref(false)
const dialog = ref<'agent' | 'group' | 'editAgent' | 'editGroup' | null>(null),
  editingId = ref(''),
  scroller = ref<HTMLElement>(),
  fileInput = ref<HTMLInputElement>(),
  dialogElement = ref<HTMLDialogElement>()
const form = reactive({
  name: '',
  avatar: '',
  instructions: '',
  source: '',
  memberIds: [] as string[],
  administratorId: '',
  mode: 'host' as 'host' | 'free',
  autoReplyIds: [] as string[],
  maxReplyRounds: 3,
})
const answers = reactive<Record<string, string>>({})
let cursor = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  pendingRequestId: string | undefined
const selected = computed(() => (typeof route.params.id === 'string' ? route.params.id : undefined))
const members = computed(() => agents.value.filter((a) => active.value?.memberIds.includes(a.id)))
const isAgentDialog = computed(() => dialog.value === 'agent' || dialog.value === 'editAgent')
const body = (v: unknown) => v as JsonValue
async function refresh() {
  const [a, c] = await Promise.all([
    apiRequest<{ agents: Agent[] }>('/api/app/agents'),
    apiRequest<{ conversations: Conversation[]; cursor: number }>('/api/app/conversations'),
  ])
  if (disposed) return
  agents.value = a.agents
  conversations.value = c.conversations
  if (!cursor) cursor = c.cursor
}
async function load(id = selected.value, append = false) {
  if (!id) {
    active.value = undefined
    messages.value = []
    return
  }
  const own = ++generation
  if (!append) loading.value = true
  try {
    const r = await apiRequest<{
      conversation: Conversation
      messages: Message[]
      run: Run | null
      interactions: Interaction[]
      context: Record<string, unknown> | null
    }>(`/api/app/conversations/${id}`)
    if (disposed || own !== generation) return
    const atBottom =
      !scroller.value ||
      scroller.value.scrollHeight - scroller.value.scrollTop - scroller.value.clientHeight < 100
    active.value = r.conversation
    messages.value = append
      ? [...new Map([...messages.value, ...r.messages].map((m) => [m.id, m])).values()].sort(
          (a, b) => a.seq - b.seq,
        )
      : r.messages
    run.value = r.run
    interactions.value = r.interactions
    context.value = r.context
    if (!append) older.value = r.messages.length === 100
    if (!append || atBottom) {
      await nextTick()
      scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
      await markRead()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (own === generation) loading.value = false
  }
}
async function markRead() {
  const c = active.value
  if (!c || c.readSeq >= c.lastSeq) return
  await apiRequest(`/api/app/conversations/${c.id}/read`, {
    method: 'PUT',
    body: { seq: c.lastSeq },
  })
  c.readSeq = c.lastSeq
}
async function poll() {
  try {
    const r = await apiRequest<{ events: WorkspaceEvent[]; cursor: number }>(
      `/api/app/events?after=${cursor}`,
    )
    if (disposed) return
    cursor = r.cursor
    if (r.events.length) {
      await refresh()
      if (r.events.some((e) => e.conversationId === selected.value || e.type === 'agent.changed'))
        await load(selected.value, true)
    }
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '连接中断，正在重连'
  } finally {
    if (!disposed) timer = setTimeout(() => void poll(), 1200)
  }
}
async function select(id: string) {
  error.value = ''
  files.value = []
  mentions.value = []
  text.value = ''
  pendingRequestId = undefined
  await router.push(`/conversations/${id}`)
}
async function openDialog(kind: NonNullable<typeof dialog.value>) {
  error.value = ''
  dialog.value = kind
  Object.assign(form, {
    name: '',
    avatar: '',
    instructions: '',
    source: '',
    memberIds: [],
    administratorId: '',
    mode: 'host',
    autoReplyIds: [],
    maxReplyRounds: 3,
  })
  try {
    if (kind === 'agent') {
      const s = await apiRequest<{ sources: Source[] }>('/api/app/agents/sources')
      sources.value = s.sources
      form.source = s.sources[0] ? JSON.stringify([s.sources[0].nodeId, s.sources[0].profile]) : ''
    }
    if (kind === 'editAgent') {
      const a = members.value[0]
      if (!a) return
      editingId.value = a.id
      Object.assign(form, a)
    }
    if (kind === 'editGroup' && active.value) {
      editingId.value = active.value.id
      Object.assign(form, active.value, {
        memberIds: [...active.value.memberIds],
        autoReplyIds: [...active.value.autoReplyIds],
      })
    }
    await nextTick()
    dialogElement.value?.showModal()
  } catch (e) {
    error.value = String(e)
    dialog.value = null
  }
}
function closeDialog() {
  dialogElement.value?.close()
  dialog.value = null
}
watch(
  () => form.memberIds.slice(),
  (ids) => {
    if (!ids.includes(form.administratorId)) form.administratorId = ids[0] ?? ''
    form.autoReplyIds = form.autoReplyIds.filter((id) => ids.includes(id))
  },
)
async function avatarChanged(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) {
    error.value = '头像请小于 2 MB'
    return
  }
  form.avatar = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = reject
    r.readAsDataURL(file)
  })
}
async function save() {
  busy.value = true
  error.value = ''
  try {
    const fields = { name: form.name, avatar: form.avatar, instructions: form.instructions }
    if (dialog.value === 'agent') {
      const [nodeId, profile] = JSON.parse(form.source)
      const result = await apiRequest<{ agent: Agent }>('/api/app/agents', {
        method: 'POST',
        body: { ...fields, nodeId, profile },
      })
      await refresh()
      const c = conversations.value.find(
        (c) => c.kind === 'direct' && c.memberIds[0] === result.agent.id,
      )
      if (c) await select(c.id)
    } else if (dialog.value === 'editAgent')
      await apiRequest(`/api/app/agents/${editingId.value}`, { method: 'PATCH', body: fields })
    else {
      const payload = {
        ...fields,
        administratorId: form.administratorId,
        mode: form.mode,
        autoReplyIds: form.autoReplyIds,
        maxReplyRounds: form.maxReplyRounds,
        ...(dialog.value === 'group' ? { memberIds: form.memberIds } : {}),
      }
      const result = await apiRequest<{ conversation: Conversation }>(
        dialog.value === 'group'
          ? '/api/app/conversations'
          : `/api/app/conversations/${editingId.value}`,
        { method: dialog.value === 'group' ? 'POST' : 'PATCH', body: body(payload) },
      )
      await select(result.conversation.id)
    }
    closeDialog()
    await refresh()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}
async function upload(event: Event) {
  const picked = (event.target as HTMLInputElement).files
  if (!picked?.length) return
  busy.value = true
  error.value = ''
  try {
    const data = new FormData()
    for (const file of picked) data.append('files', file)
    const r = await apiRequest<{ files: WorkspaceFile[] }>('/api/app/uploads', {
      method: 'POST',
      body: data,
    })
    files.value = [...files.value, ...r.files].slice(0, 8)
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
    ;(event.target as HTMLInputElement).value = ''
  }
}
async function send() {
  const c = active.value
  if (!c || busy.value || c.activeRunId || (!text.value.trim() && !files.value.length)) return
  busy.value = true
  error.value = ''
  pendingRequestId ??= crypto.randomUUID()
  try {
    await apiRequest(`/api/app/conversations/${c.id}/messages`, {
      method: 'POST',
      body: {
        requestId: pendingRequestId,
        content: text.value,
        mentionIds: mentions.value,
        fileIds: files.value.map((f) => f.id),
      },
    })
    text.value = ''
    files.value = []
    mentions.value = []
    pendingRequestId = undefined
    await load(c.id, true)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '发送失败'
  } finally {
    busy.value = false
  }
}
watch([text, () => files.value.map((f) => f.id).join(), () => mentions.value.join()], () => {
  if (!busy.value) pendingRequestId = undefined
})
async function action(operation: 'pin' | 'archive') {
  const c = active.value
  if (!c) return
  try {
    if (operation === 'pin')
      await apiRequest(`/api/app/conversations/${c.id}`, {
        method: 'PATCH',
        body: { pinned: !c.pinned },
      })
    else
      await apiRequest(
        c.kind === 'direct'
          ? `/api/app/agents/${c.memberIds[0]}`
          : `/api/app/conversations/${c.id}`,
        { method: 'PATCH', body: { archived: !c.archived } },
      )
    await refresh()
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
async function control(action: 'stop' | 'reconcile') {
  if (!run.value) return
  try {
    await apiRequest(`/api/app/runs/${run.value.id}/${action}`, { method: 'POST', body: {} })
    await load(undefined, true)
  } catch (e) {
    error.value = String(e)
  }
}
async function respond(i: Interaction, answer: string) {
  try {
    await apiRequest(`/api/app/interactions/${i.id}/respond`, { method: 'POST', body: { answer } })
    await load(undefined, true)
  } catch (e) {
    error.value = String(e)
  }
}
async function loadOlder() {
  const c = active.value
  if (!c) return
  try {
    const r = await apiRequest<{ messages: Message[] }>(
      `/api/app/conversations/${c.id}/messages?before=${messages.value[0]?.seq ?? 0}`,
    )
    messages.value = [...r.messages, ...messages.value]
    older.value = r.messages.length === 100
  } catch (e) {
    error.value = String(e)
  }
}
function rendered(m: Message) {
  return m.content.replace(
    /(!?\[[^\]]*\])\(<?([^)>]+)>?\)/g,
    (whole, label: string, path: string) => {
      const file =
        m.attachments.find((f) => f.sourcePath === path) ||
        m.attachments.find((f) => path.split('/').at(-1) === f.name)
      return file
        ? `${label}(/api/app/files/${file.id}/${label.startsWith('!') ? 'preview' : 'download'})`
        : whole
    },
  )
}

watch(selected, () => void load())
onMounted(async () => {
  try {
    await apiRequest('/api/app/capabilities')
    await refresh()
    await load()
    if (!disposed) void poll()
  } catch (e) {
    error.value = String(e)
  }
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  if (timer) clearTimeout(timer)
})
</script>
<template>
  <WorkspaceShell
    :user-name="auth.user?.username"
    :profiles="auth.profiles"
    :active-profile="auth.activeProfile"
    :is-admin="auth.user?.role === 'admin'"
    :upstream-ready="auth.upstreamReady"
    :upstream-error="auth.upstreamError"
    :theme="theme.resolvedTheme"
    :theme-preference="theme.theme"
    sidebar-title="聊天"
    sidebar-context-title="聊天列表"
    @logout="auth.logout"
    @select-profile="auth.selectProfile"
    @toggle-theme="theme.toggle"
    @set-theme="theme.setTheme"
  >
    <template #sidebar-action
      ><div class="new-actions">
        <button @click="openDialog('agent')">＋ 创建 Agent</button
        ><button @click="openDialog('group')">＋ 创建群聊</button
        ><button @click="showNodes = true">节点</button>
      </div></template
    >
    <template #sidebar
      ><ConversationList :conversations="conversations" :selected="selected" @select="select"
    /></template>
    <template #mobile-sidebar
      ><ConversationList :conversations="conversations" :selected="selected" @select="select"
    /></template>
    <section class="workspace-chat" aria-label="聊天">
      <header v-if="active" class="chat-header">
        <AgentAvatar :name="active.name" :avatar="active.avatar" :size="38" />
        <div>
          <h1>{{ active.name }}</h1>
          <small>{{
            active.kind === 'group' ? `${members.length} 位成员 · 成员已固定` : 'Agent 单聊'
          }}</small>
        </div>
        <span class="spacer" /><button @click="action('pin')">
          {{ active.pinned ? '取消置顶' : '置顶' }}</button
        ><button @click="openDialog(active.kind === 'direct' ? 'editAgent' : 'editGroup')">
          设置</button
        ><button @click="action('archive')">{{ active.archived ? '恢复' : '归档' }}</button>
      </header>
      <p v-if="error" class="error" role="alert">
        {{ error }} <button @click="error = ''" aria-label="关闭错误">×</button>
      </p>
      <div
        v-if="active"
        ref="scroller"
        class="messages"
        @scroll="
          scroller &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40 &&
          markRead()
        "
      >
        <button v-if="older" class="older" @click="loadOlder">加载更早消息</button>
        <p v-if="loading && !messages.length">正在加载…</p>
        <article v-for="m in messages" :key="m.id" class="message" :class="m.role">
          <small
            >{{ m.role === 'user' ? '我' : m.agentName || '系统' }}
            <time>{{
              new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }}</time></small
          >
          <details v-if="m.reasoning">
            <summary>思考过程</summary>
            <p>{{ m.reasoning }}</p>
          </details>
          <MarkdownContent :content="rendered(m)" :streaming="m.status === 'streaming'" />
          <details v-for="(tool, i) in m.tools" :key="i">
            <summary>{{ tool.name || tool.tool_name || '工具' }} · {{ tool.status }}</summary>
            <pre>{{ JSON.stringify(tool, null, 2) }}</pre>
          </details>
          <a
            v-for="file in m.attachments"
            :key="file.id"
            class="file"
            :href="`/api/app/files/${file.id}/download`"
            target="_blank"
            rel="noreferrer"
            ><img
              v-if="file.mimeType.startsWith('image/')"
              :src="`/api/app/files/${file.id}/preview`"
              :alt="file.name"
            />{{ file.name }}</a
          ><small v-if="m.status !== 'complete'" class="status">{{
            {
              queued: '等待中',
              streaming: '正在回复…',
              failed: '执行失败',
              interrupted: '已停止',
              uncertain: '执行状态待确认',
            }[m.status]
          }}</small>
        </article>
        <p v-if="!loading && !messages.length" class="chat-empty">
          {{ active.kind === 'group' ? '向团队描述你希望完成的事。' : '发一条消息，开始协作。' }}
        </p>
      </div>
      <div v-else class="welcome">
        <AgentAvatar name="夭夭" :size="72" />
        <h1>从一个角色开始</h1>
        <p>创建专属 Agent，为它设置职责和规则。<br />让不同角色在同一个群聊中协作。</p>
        <button @click="openDialog('agent')">创建 Agent</button>
      </div>
      <div v-if="active" class="composer-area">
        <div v-for="i in interactions" :key="i.id" class="interaction">
          <strong>{{ i.kind === 'approval' ? '需要审批' : '需要补充信息' }}</strong>
          <p>{{ i.message }}</p>
          <template v-if="i.kind === 'approval'"
            ><button @click="respond(i, 'once')">允许本次</button
            ><button @click="respond(i, 'deny')">拒绝</button></template
          ><template v-else
            ><input v-model="answers[i.id]" aria-label="补充信息" /><button
              @click="respond(i, answers[i.id] || '')"
            >
              提交
            </button></template
          >
        </div>
        <div v-if="run" class="run-status">
          {{
            run.status === 'uncertain'
              ? '执行状态待确认'
              : run.status === 'waiting'
                ? '等待你的确认'
                : '正在协作'
          }}<span>{{ run.error }}</span
          ><button v-if="run.status === 'uncertain'" @click="control('reconcile')">核对状态</button
          ><button @click="control('stop')">停止</button>
        </div>
        <div v-if="active.kind === 'group'" class="mentions">
          <label v-for="a in members" :key="a.id"
            ><input v-model="mentions" type="checkbox" :value="a.id" />@{{ a.name }}</label
          >
        </div>
        <div v-if="files.length" class="uploads">
          <button
            v-for="f in files"
            :key="f.id"
            @click="files = files.filter((x) => x.id !== f.id)"
          >
            {{ f.name }} ×
          </button>
        </div>
        <form class="composer" @submit.prevent="send">
          <textarea
            v-model="text"
            :disabled="active.archived"
            aria-label="消息"
            :placeholder="active.archived ? '聊天已归档' : '输入消息…'"
            @keydown.enter.exact.prevent="send"
          />
          <div>
            <input ref="fileInput" hidden type="file" multiple @change="upload" /><button
              type="button"
              :disabled="busy || active.archived"
              @click="fileInput?.click()"
            >
              附件</button
            ><span class="spacer" /><small v-if="context"
              >上下文 {{ context.context_percent ?? context.percent ?? '—' }}%</small
            ><button
              type="submit"
              :disabled="
                busy || !!active.activeRunId || active.archived || (!text.trim() && !files.length)
              "
            >
              {{ busy ? '处理中…' : '发送' }}
            </button>
          </div>
        </form>
      </div>
    </section>
    <div
      v-if="showNodes"
      class="nodes-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="节点管理"
    >
      <div><button @click="showNodes = false">关闭</button><WorkspaceNodesPanel /></div>
    </div>
    <dialog v-if="dialog" ref="dialogElement" class="editor" @cancel.prevent="closeDialog">
      <form @submit.prevent="save">
        <header>
          <h2>
            {{ dialog === 'agent' ? '创建 Agent' : dialog === 'group' ? '创建群聊' : '编辑资料' }}
          </h2>
          <button type="button" aria-label="关闭" @click="closeDialog">×</button>
        </header>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label>名称<input v-model="form.name" required maxlength="100" /></label
        ><label
          >头像<input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            @change="avatarChanged" /></label
        ><AgentAvatar v-if="form.avatar" :name="form.name" :avatar="form.avatar" :size="48" /><label
          v-if="dialog === 'agent'"
          >基础 Agent<select v-model="form.source" required>
            <option
              v-for="s in sources"
              :key="`${s.nodeId}:${s.profile}`"
              :value="JSON.stringify([s.nodeId, s.profile])"
            >
              {{ s.name }} · {{ s.nodeId === 'local' ? '当前服务' : s.nodeId }}
            </option></select
          ><small v-if="!sources.length"
            >没有可用的基础 Agent，请检查 Web 的 Hermes 连接。</small
          ></label
        ><label
          >{{ isAgentDialog ? '角色提示词与规则' : '群规则'
          }}<textarea
            v-model="form.instructions"
            rows="6"
            maxlength="24000"
            :placeholder="
              isAgentDialog
                ? '例如：你是代码审查员。重点检查正确性、边界情况和测试证据。'
                : '所有成员共同遵守的协作规则'
            "
          />
        </label>
        <fieldset v-if="!isAgentDialog">
          <legend>{{ dialog === 'group' ? '选择成员（创建后不可变更）' : '固定成员' }}</legend>
          <label
            v-for="a in agents.filter((a) =>
              dialog === 'group' ? !a.archived : form.memberIds.includes(a.id),
            )"
            :key="a.id"
            ><input
              v-model="form.memberIds"
              type="checkbox"
              :value="a.id"
              :disabled="dialog === 'editGroup'"
            />{{ a.name }}</label
          ><small v-if="agents.filter((a) => !a.archived).length < 2"
            >至少需要两个 Agent 才能创建群聊。</small
          >
        </fieldset>
        <template v-if="!isAgentDialog"
          ><label
            >管理员<select v-model="form.administratorId" required>
              <option
                v-for="a in agents.filter((a) => form.memberIds.includes(a.id))"
                :key="a.id"
                :value="a.id"
              >
                {{ a.name }}
              </option>
            </select></label
          ><label
            >协作方式<select v-model="form.mode">
              <option value="host">管理员协调</option>
              <option value="free">自由协作</option>
            </select></label
          >
          <fieldset v-if="form.mode === 'free'">
            <legend>未 @ 时自动回复</legend>
            <label v-for="a in agents.filter((a) => form.memberIds.includes(a.id))" :key="a.id"
              ><input v-model="form.autoReplyIds" type="checkbox" :value="a.id" />{{
                a.name
              }}</label
            >
          </fieldset>
          <label
            >自动协作轮数<input
              v-model.number="form.maxReplyRounds"
              type="number"
              min="1"
              max="100"
              required /></label
        ></template>
        <footer>
          <button type="button" @click="closeDialog">取消</button
          ><button :disabled="busy || (!isAgentDialog && form.memberIds.length < 2)">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </dialog>
  </WorkspaceShell>
</template>
<style scoped>
.nodes-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #0006;
  display: grid;
  place-items: center;
}
.nodes-overlay > div {
  padding: 20px;
  border-radius: 18px;
  max-height: 85vh;
  overflow: auto;
  width: min(520px, 90vw);
  background: var(--surface);
}
.new-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.workspace-chat {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--text-primary);
  background: var(--surface);
}
button {
  cursor: pointer;
  color: inherit;
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 17px 24px;
  border-bottom: 1px solid var(--line);
}
h1 {
  font-size: 18px;
  margin: 0 0 4px;
}
small {
  color: var(--text-muted);
}
.spacer {
  flex: 1;
}
.chat-header button,
.composer button,
.run-status button,
.interaction button,
.editor button,
.welcome button {
  padding: 8px 13px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-soft);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px max(24px, calc((100% - 780px) / 2));
  scrollbar-gutter: stable;
}
.message {
  margin: 0 0 28px;
  overflow-wrap: anywhere;
}
.message > small {
  display: block;
  margin-bottom: 9px;
  font-size: 11px;
}
.message.user {
  margin-left: 15%;
  padding: 14px 18px;
  background: var(--surface-soft);
  border-radius: 17px;
}
.message time {
  margin-left: 8px;
  opacity: 0.7;
}
.message pre {
  white-space: pre-wrap;
  font-size: 11px;
  max-height: 300px;
  overflow: auto;
}
.message details {
  margin: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.message .file {
  display: inline-flex;
  vertical-align: top;
  flex-direction: column;
  max-width: 280px;
  margin: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: inherit;
  font-size: 12px;
}
.file img {
  max-height: 240px;
  max-width: 100%;
  object-fit: contain;
}
.composer-area {
  width: min(820px, 100%);
  box-sizing: border-box;
  align-self: center;
  padding: 12px 24px 24px;
}
.composer {
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 12px;
  background: var(--surface);
}
.composer textarea {
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
  min-height: 75px;
  max-height: 220px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.6;
  outline: none;
}
.composer > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mentions,
.uploads {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 12px;
}
.mentions label {
  display: flex;
  align-items: center;
  gap: 3px;
}
.uploads button {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px;
  background: var(--surface-soft);
}
.run-status {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  margin-bottom: 10px;
}
.run-status span {
  color: var(--text-muted);
}
.error {
  padding: 12px 20px;
  margin: 0;
  background: color-mix(in srgb, var(--danger, #c64c4c) 10%, transparent);
  color: var(--danger, #c64c4c);
  font-size: 13px;
}
.error button {
  float: right;
  border: 0;
  background: none;
}
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 30px;
  gap: 18px;
}
.welcome h1 {
  font-size: 26px;
}
.welcome p {
  line-height: 1.9;
  color: var(--text-muted);
}
.chat-empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-muted);
}
.interaction {
  border: 1px solid var(--line);
  padding: 16px;
  border-radius: 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.interaction button {
  margin-right: 8px;
}
.older {
  display: block;
  margin: 0 auto 25px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
}
.editor {
  border: 1px solid var(--line);
  border-radius: 18px;
  width: min(520px, calc(100vw - 48px));
  max-height: 85vh;
  overflow: auto;
  background: var(--surface);
  color: var(--text-primary);
  padding: 25px;
}
.editor::backdrop {
  background: #0006;
}
.editor header,
.editor footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor h2 {
  font-size: 20px;
}
.editor label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 15px 0;
  font-size: 13px;
}
.editor input:not([type='checkbox']),
.editor textarea,
.editor select,
.interaction input {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-soft);
  color: inherit;
  font: inherit;
}
.editor fieldset {
  border: 1px solid var(--line);
  border-radius: 10px;
}
.editor fieldset label {
  flex-direction: row;
  align-items: center;
}
.editor footer {
  justify-content: flex-end;
  margin-top: 25px;
}
.status {
  margin-top: 8px;
}
@media (max-width: 700px) {
  .chat-header {
    padding: 12px;
    gap: 8px;
  }
  .chat-header button {
    padding: 6px;
    font-size: 11px;
  }
  .messages {
    padding: 18px 15px;
  }
  .composer-area {
    padding: 10px 12px 16px;
  }
  .message.user {
    margin-left: 8%;
  }
}
</style>

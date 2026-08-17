import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const port = Number(process.env.FAKE_HERMES_PORT || 19119)
const epoch = '11111111-1111-4111-8111-111111111111'
const roomId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const now = () => Date.now() / 1000

function authenticated(request) {
  return String(request.headers.cookie || '').includes('fake_session=authenticated')
}

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...headers,
  })
  response.end(body)
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const profiles = [
  { name: 'yaoyao', description: '夭夭', is_default: true, model: 'gpt-5.6', provider: 'openai', gateway_running: true },
  { name: 'yaoer', description: '瑶儿', is_default: false, model: 'gpt-5.6', provider: 'openai', gateway_running: true },
]
// This intentionally differs from local timestamp/pin ranking. Browser tests
// verify that the WebUI preserves the ordering returned by 9119.
const sessions = [
  { id: 'session-second', profile: 'yaoyao', source: 'web', title: '第二个会话', preview: '用于验证列表和切换', message_count: 2, tool_call_count: 0, started_at: now() - 7200, last_active_at: now() - 600 },
  { id: 'session-demo', profile: 'yaoyao', source: 'web', title: '夭夭 Web 验收会话', preview: '文件库与群聊已经就绪', message_count: 4, tool_call_count: 1, started_at: now() - 3600, last_active_at: now(), pinned: true, model: 'gpt-5.6', provider: 'openai' },
]
const messages = [
  { id: 'message-user', role: 'user', content: '请检查今天生成的产物。MEDIA:/brand/AppIcon-1024.png', timestamp: now() - 180 },
  { id: 'message-assistant', role: 'assistant', content: '已整理完成。下面是 **验收摘要**：\n\n- 普通聊天已连接\n- 群聊 v2 已就绪\n- [打开报告](https://example.com/report)', reasoning_content: '先核对会话与文件索引。', timestamp: now() - 170 },
  { id: 'message-tool', role: 'tool', tool_name: 'file_search', tool_call_id: 'tool-1', summary: '扫描产物目录', result: { path: '/tmp/demo-report.pdf', count: 1 }, timestamp: now() - 175 },
  { id: 'message-image', role: 'assistant', content: '预览图：![夭夭 Logo](/brand/AppIcon-1024.png)', timestamp: now() - 160 },
  { id: 'message-legacy-media', role: 'assistant', content: '历史兼容：MEDIA:/brand/AppIcon-1024.png', timestamp: now() - 150 },
]
const groupAgent = { id: agentId, roomId, profile: 'yaoyao', displayName: '夭夭', description: '主 Agent', enabled: true, replyWithoutMention: true, status: 'idle', createdAt: now() - 2000, updatedAt: now() }
const groupMessage = { seq: 1, id: '44444444-4444-4444-8444-444444444444', roomId, senderKind: 'human', senderId: 'demo-user', senderName: '验收用户', content: '大家好，检查一下群聊输入框。', status: 'completed', createdAt: now() - 120, updatedAt: now() - 120 }
const groupAssistantMessage = { seq: 2, id: '55555555-5555-4555-8555-555555555555', roomId, senderKind: 'agent', senderId: agentId, senderName: '夭夭', content: '历史兼容：MEDIA:/brand/AppIcon-1024.png', status: 'completed', createdAt: now() - 100, updatedAt: now() - 100 }
const groupMessages = [groupMessage, groupAssistantMessage]
const room = { id: roomId, name: '设计与工程协作', cwd: '/tmp', createdAt: now() - 2000, updatedAt: now(), archived: false, agentCount: 1, maxReplyRounds: 3, lastMessage: groupAssistantMessage, unreadCount: 0 }
const previewPdf = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTAgMDAwMDAgbiAKMDAwMDAwMDA1MyAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMTY2CiUlRU9G', 'base64')

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  if (url.pathname === '/api/status') return json(response, 200, { version: 'test', overall: 'ok', auth_required: true, auth_providers: ['basic'], gateway_running: true, gateway_state: 'running' })
  if (url.pathname === '/api/auth/providers') return json(response, 200, { providers: [{ name: 'basic', display_name: '账号密码', supports_password: true }] })
  if (url.pathname === '/auth/password-login' && request.method === 'POST') {
    const input = await body(request)
    if (input.username !== 'test' || input.password !== 'test') return json(response, 401, { detail: 'Invalid credentials' })
    return json(response, 200, { ok: true, next: '' }, { 'Set-Cookie': 'fake_session=authenticated; Path=/; HttpOnly; SameSite=Lax' })
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') return json(response, 200, { ok: true }, { 'Set-Cookie': 'fake_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' })
  if (!authenticated(request)) return json(response, 401, { detail: 'Unauthorized' })
  if (url.pathname === '/api/auth/me') return json(response, 200, { user_id: 'demo-user', display_name: '验收用户', email: 'demo@example.invalid', provider: 'basic' })
  if (url.pathname === '/api/auth/ws-ticket' && request.method === 'POST') return json(response, 200, { ticket: 'fake-ticket' })
  if (url.pathname === '/api/profiles') return json(response, 200, { profiles })
  if (url.pathname === '/api/plugins/yaoyao/profiles') return json(response, 200, { profiles: [
    { name: 'yaoyao', label: '夭夭', agentName: '夭夭', isDefault: true },
    { name: 'yaoer', label: '瑶儿', agentName: '瑶儿', isDefault: false },
  ] })
  if (url.pathname === '/api/model/options') return json(response, 200, { model: 'gpt-5.6', provider: 'openai', providers: [{ slug: 'openai', name: 'OpenAI', models: ['gpt-5.6', 'gpt-5.5'] }] })
  if (url.pathname === '/api/profiles/sessions' || url.pathname === '/api/sessions') return json(response, 200, { sessions, total: sessions.length, offset: 0, limit: 100 })
  if (/^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json(response, 200, { messages, pagination: { total: messages.length, returned: messages.length, limit: 150, hasMore: false } })
  if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) return json(response, 200, sessions[0])
  if (url.pathname === '/api/session-unread') return json(response, 200, { items: { 'session-demo': 0 } })
  if (url.pathname === '/api/plugins/yaoyao/v1/capabilities') return json(response, 200, { protocolVersion: 2, journalEpoch: epoch, latestCursor: 0, limits: { maxAgentsPerRoom: 8, maxMessageBytes: 65536, maxMessagePageSize: 100, defaultMaxReplyRounds: 3, unlimitedReplyRoundsValue: -1, maxAgentDisplayNameLength: 100 }, eventTypes: ['message.upsert', 'agent.status'] })
  if (url.pathname === '/api/plugins/yaoyao/v1/rooms') return json(response, 200, { items: [room], nextCursor: null })
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}`) return json(response, 200, { ...room, agents: [groupAgent], runs: [], pendingInteractions: [], latestCursor: 0 })
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}/messages`) return json(response, 200, { items: groupMessages })
  if (url.pathname === '/api/plugins/yaoyao/files') return json(response, 200, { items: [{ id: 1, path: '/tmp/demo-report.pdf', name: 'demo-report.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 204800, modifiedAt: now(), exists: true, origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话', messageId: 'message-assistant', authorKind: 'assistant', authorName: '夭夭', observedAt: now() }] }], nextCursor: null, total: 1 })
  if (url.pathname === '/api/plugins/yaoyao/1/download') {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': previewPdf.length })
    return response.end(previewPdf)
  }
  json(response, 404, { detail: `No fake route for ${request.method} ${url.pathname}` })
})

const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  if (url.searchParams.get('ticket') !== 'fake-ticket') return socket.destroy()
  sockets.handleUpgrade(request, socket, head, client => {
    if (url.pathname.endsWith('/events')) {
      client.send(JSON.stringify({ type: 'group.ready', epoch, cursor: 0, heartbeatSeconds: 20 }))
      return
    }
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { capabilities: ['safe_interrupt', 'session_reasoning_config'] } } }))
    client.on('message', raw => {
      const requestFrame = JSON.parse(raw.toString())
      const respond = result => client.send(JSON.stringify({ jsonrpc: '2.0', id: requestFrame.id, result }))
      if (requestFrame.method === 'session.resume') return respond({ session_id: 'runtime-demo', stored_session_id: requestFrame.params.session_id, messages: [] })
      if (requestFrame.method === 'session.create') return respond({ session_id: 'runtime-new', stored_session_id: 'session-new' })
      if (requestFrame.method === 'session.usage') return respond({ context_used: 12500, context_max: 114688, total: 12500, input: 9000, output: 3500 })
      if (requestFrame.method === 'prompt.submit') {
        respond({ status: 'accepted' })
        setTimeout(() => {
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', session_id: requestFrame.params.session_id, profile: 'yaoyao', payload: { message_id: 'stream-demo' } } }))
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: requestFrame.params.session_id, profile: 'yaoyao', payload: { message_id: 'stream-demo', delta: '这是来自假 Gateway 的流式回复。' } } }))
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: requestFrame.params.session_id, profile: 'yaoyao', payload: { message_id: 'stream-demo', text: '这是来自假 Gateway 的流式回复。', status: 'complete' } } }))
        }, 20)
        return
      }
      respond({ ok: true })
    })
  })
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`Fake Hermes listening on 127.0.0.1:${port}\n`))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)))

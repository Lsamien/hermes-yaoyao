import { describe, expect, it } from 'vitest'
import { chatMessagesToUi } from '@/components/workspace/viewModels'
import { normalizeChatMessage } from '@/utils/normalize'
import { buildMessageTimelineRows } from '@/utils/turnTrace'

describe('ordinary chat tool timeline', () => {
  it('folds persisted function calls and their result rows into one expandable tool', () => {
    const user = normalizeChatMessage({ id: 'user-row', role: 'user', content: 'MEDIA:/tmp/keep-raw.png', timestamp: 0 }, 'session-1', 'default')
    const call = normalizeChatMessage({
      id: 'assistant-call', role: 'assistant', content: '', tool_calls: JSON.stringify([{
        id: 'call-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' },
      }]), timestamp: 1,
    }, 'session-1', 'default')
    const result = normalizeChatMessage({
      id: 'tool-result', role: 'tool', tool_call_id: 'call-1', tool_name: 'terminal',
      content: '{"output":"/tmp/work","exit_code":0,"error":null}', timestamp: 2,
    }, 'session-1', 'default')
    const system = normalizeChatMessage({ id: 'system-row', role: 'system', content: 'transport detail', timestamp: 3 }, 'session-1', 'default')

    const timeline = chatMessagesToUi([user, call, result, system])
    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toMatchObject({ role: 'user', content: 'MEDIA:/tmp/keep-raw.png' })
    expect(timeline[1].role).toBe('assistant')
    expect(timeline[1].tools).toEqual([expect.objectContaining({
      id: 'call-1', name: 'terminal', status: 'success', input: '{"command":"pwd"}', output: { output: '/tmp/work', exit_code: 0, error: null },
    })])
  })

  it('renders asynchronous delegation completion as a timeline event, not a user message', () => {
    const notice = normalizeChatMessage({
      id: 'delegation', role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE]',
      display_kind: 'async_delegation_complete',
      display_metadata: JSON.stringify({ task_count: 2, completed_count: 2, failed_count: 0, duration_seconds: 71 }),
      timestamp: 1,
    }, 'session-1', 'default')
    const [timeline] = chatMessagesToUi([notice])
    expect(timeline).toMatchObject({
      role: 'system', timelineKind: 'delegation-complete',
      timelineMetadata: { task_count: 2, completed_count: 2 },
    })
  })

  it('groups one turn of reasoning and tools before its visible assistant reply', () => {
    const rows = buildMessageTimelineRows([
      { id: 'user', role: 'user', content: '检查一下' },
      { id: 'thinking', role: 'assistant', content: '', reasoning: '先读取配置', tools: [{ id: 'read', name: 'read_file', status: 'success', input: { path: 'a' }, output: 'ok' }] },
      { id: 'tool-two', role: 'assistant', content: '', reasoning: '再执行命令', tools: [{ id: 'run', name: 'terminal', status: 'running', input: { command: 'pwd' } }] },
      { id: 'answer', role: 'assistant', content: '检查完成', reasoning: '组织答案' },
    ])
    expect(rows.map(row => [row.kind, row.id])).toEqual([
      ['message', 'message:user'],
      ['trace', 'trace:thinking'],
      ['message', 'message:answer'],
    ])
    const trace = rows[1]
    expect(trace?.kind === 'trace' ? trace.entries.map(entry => entry.type) : []).toEqual(['reasoning', 'tool', 'reasoning', 'tool', 'reasoning'])
    expect(trace?.kind === 'trace' ? trace.status : '').toBe('running')
    expect(rows[2]?.kind === 'message' ? rows[2].message : undefined).toMatchObject({ content: '检查完成', reasoning: undefined, tools: undefined })
  })

  it('does not merge assistant traces across agents or system events', () => {
    const rows = buildMessageTimelineRows([
      { id: 'a', role: 'assistant', author: '甲', content: '', reasoning: '甲思考' },
      { id: 'b', role: 'assistant', author: '乙', content: '', reasoning: '乙思考' },
      { id: 'system', role: 'system', content: '系统信息' },
      { id: 'c', role: 'assistant', author: '乙', content: '', reasoning: '新回合' },
    ])
    expect(rows.map(row => row.id)).toEqual(['trace:a', 'trace:b', 'message:system', 'trace:c'])
  })
})

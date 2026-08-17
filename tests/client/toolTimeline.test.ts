import { describe, expect, it } from 'vitest'
import { chatMessagesToUi } from '@/components/workspace/viewModels'
import { normalizeChatMessage } from '@/utils/normalize'

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
})

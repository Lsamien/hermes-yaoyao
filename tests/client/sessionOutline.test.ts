import { describe, expect, it } from 'vitest'
import type { UiMessage } from '@/components/messages/types'
import { buildSessionOutline } from '@/utils/sessionOutline'

describe('session outline', () => {
  it('keeps each user turn and all assistant H1-H3 headings before the next turn', () => {
    const messages: UiMessage[] = [
      { id: 'u1', role: 'user', content: '请给我一份完整方案' },
      { id: 'a1', role: 'assistant', content: '# 结论\n正文\n## 实施步骤' },
      { id: 'a2', role: 'assistant', content: '### 风险\n说明' },
      { id: 'u2', role: 'user', content: '再补充测试' },
      { id: 'a3', role: 'assistant', content: '## 测试计划' },
    ]
    expect(buildSessionOutline(messages).map(item => [item.type, item.level, item.content])).toEqual([
      ['user', 0, '请给我一份完整方案'],
      ['heading', 1, '结论'],
      ['heading', 2, '实施步骤'],
      ['heading', 3, '风险'],
      ['user', 0, '再补充测试'],
      ['heading', 2, '测试计划'],
    ])
  })

  it('ignores reasoning, fenced-code headings, tools, and timeline system events', () => {
    const messages: UiMessage[] = [
      { id: 'system', role: 'user', content: '模型切换', timelineKind: 'system' },
      { id: 'u1', role: 'user', content: '<think>内部</think>真实问题' },
      { id: 'a1', role: 'assistant', content: '<think># 隐藏标题</think>\n```md\n# 代码标题\n```\n## 可见标题' },
      { id: 'tool', role: 'tool', content: '# 工具标题' },
    ]
    expect(buildSessionOutline(messages).map(item => item.content)).toEqual(['真实问题', '可见标题'])
  })

  it('truncates long user questions to fifty characters', () => {
    const content = '这是一条很长的用户问题'.repeat(8)
    const [item] = buildSessionOutline([{ id: 'u1', role: 'user', content }])
    expect(item?.content).toHaveLength(51)
    expect(item?.content.endsWith('…')).toBe(true)
  })
})

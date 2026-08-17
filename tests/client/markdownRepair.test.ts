import { describe, expect, it } from 'vitest'
import { repairMarkdownForRender, repairNestedMarkdownFences } from '@/utils/markdownRepair'

describe('repairNestedMarkdownFences', () => {
  it('unwraps a whole-answer outer md fence', () => {
    const input = '```md\n# 标题\n\n- 项目一\n- 项目二\n```'
    expect(repairNestedMarkdownFences(input)).toBe('# 标题\n\n- 项目一\n- 项目二')
  })

  it('keeps a real code block untouched', () => {
    const input = '说明\n\n```ts\nconst a = 1\n```\n\n结尾'
    expect(repairNestedMarkdownFences(input)).toBe(input)
  })

  it('promotes literal fences nested inside a markdown example', () => {
    const input = '```md\n示例\n\n```\nnested\n```\n```'
    expect(repairNestedMarkdownFences(input)).toBe('示例\n\n```\nnested\n```')
  })

  it('ignores content without fences', () => {
    expect(repairNestedMarkdownFences('普通文本')).toBe('普通文本')
  })
})

describe('repairMarkdownForRender', () => {
  it('closes a dangling fence left open by truncation', () => {
    const result = repairMarkdownForRender('前言\n\n```python\nprint(1)')
    expect(result).toBe('前言\n\n```python\nprint(1)\n```')
  })

  it('keeps dangling fences open while streaming', () => {
    const input = '```python\nprint(1)'
    expect(repairMarkdownForRender(input, true)).toBe(input)
  })

  it('does not close an already balanced fence', () => {
    const input = '```js\nconst a = 1\n```'
    expect(repairMarkdownForRender(input)).toBe(input)
  })

  it('keeps a truncated outer md wrapper as a code block while closing it', () => {
    // 流被截断时外层 md 围栏没有终止行，解包条件不成立；仅补闭合让它按代码块渲染。
    const result = repairMarkdownForRender('```md\n# 标题\n\n```ts\nconst a = 1')
    expect(result).toBe('```md\n# 标题\n\n```ts\nconst a = 1\n```')
  })
})

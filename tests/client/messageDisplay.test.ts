import { describe, expect, it } from 'vitest'
import { displayContentForMessage } from '@/utils/messageDisplay'

describe('displayContentForMessage', () => {
  it('hides expanded attached context while restoring a missing reference', () => {
    const content = [
      '帮我看看这个文件',
      '',
      '--- Attached Context ---',
      '',
      '📄 @file:`/Users/samien/My Notes/方案.md` (981 tokens)',
      '```markdown',
      '# 很长的附加正文',
      '```',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe(
      '@file:`/Users/samien/My Notes/方案.md`\n\n帮我看看这个文件',
    )
  })

  it('keeps visible references in place and deduplicates attached references', () => {
    const reference = '@url:`https://example.com/a b`'
    const content = [
      reference,
      '总结这篇文章',
      '',
      '--- Attached Context ---',
      '',
      `🌐 ${reference} (1200 tokens)`,
      '正文一',
      `🌐 ${reference} (1200 tokens)`,
      '正文二',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe(`${reference}\n总结这篇文章`)
  })

  it('supports quoted refs and removes context warnings from user display', () => {
    const content = [
      '分析附件',
      '',
      '--- Attached Context ---',
      '',
      "📁 @folder:'/Users/samien/中文 文件夹' (20 tokens)",
      'folder listing',
      '🛠 @tool:"desktop capture" (10 tokens)',
      'tool output',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe([
      "@folder:'/Users/samien/中文 文件夹'",
      '@tool:"desktop capture"',
      '',
      '分析附件',
    ].join('\n'))

    expect(displayContentForMessage('user', '继续\n\n--- Context Warnings ---\n抓取失败')).toBe('继续')
  })

  it('never rewrites assistant or system content', () => {
    const content = '回答\n\n--- Attached Context ---\n\n不应隐藏'
    expect(displayContentForMessage('assistant', content)).toBe(content)
    expect(displayContentForMessage('system', content)).toBe(content)
  })
})

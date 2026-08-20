import { describe, expect, it } from 'vitest'
import { displayContentForMessage } from '@/utils/messageDisplay'
import { normalizeChatMessage } from '@/utils/normalize'

describe('displayContentForMessage', () => {
  it('turns persisted user @file markers into attachment cards and removes marker text', () => {
    const message = normalizeChatMessage({
      id: 'user-file', role: 'user', timestamp: 1,
      content: [
        '刘博士的技术介绍。',
        '',
        '[用户附加文件：大模型推理优化报告.docx]',
        '@file:\\/Users/samien/.hermes/attachments/大模型推理优化报告.docx',
        '',
        '[用户附加文件：MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx]',
        '@file:`/Users/samien/.hermes/attachments/MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx`',
      ].join('\n'),
    }, 'session-1', 'default')
    expect(message.content).toBe('刘博士的技术介绍。')
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: '大模型推理优化报告.docx',
        path: '/Users/samien/.hermes/attachments/大模型推理优化报告.docx',
        kind: 'file',
      }),
      expect.objectContaining({
        name: 'MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx',
        path: '/Users/samien/.hermes/attachments/MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx',
        kind: 'file',
      }),
    ])
  })

  it('turns iOS relative attachment markers into attachment cards', () => {
    const message = normalizeChatMessage({
      id: 'ios-user-file', role: 'user', timestamp: 1,
      content: '[用户附加文件：车位 四号车库-B2307 罗益民 33600元.pdf]\n@file:`attachments/车位 四号车库-B2307 罗益民 33600元.pdf`',
    }, 'session-1', 'default')

    expect(message.content).toBe('')
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: '车位 四号车库-B2307 罗益民 33600元.pdf',
        path: 'attachments/车位 四号车库-B2307 罗益民 33600元.pdf',
        url: '/attachments/%E8%BD%A6%E4%BD%8D%20%E5%9B%9B%E5%8F%B7%E8%BD%A6%E5%BA%93-B2307%20%E7%BD%97%E7%9B%8A%E6%B0%91%2033600%E5%85%83.pdf',
        kind: 'pdf',
      }),
    ])
  })
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

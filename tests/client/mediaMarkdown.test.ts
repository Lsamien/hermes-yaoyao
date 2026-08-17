import { describe, expect, it } from 'vitest'
import { normalizeAssistantMediaMarkdown } from '@/utils/mediaMarkdown'

describe('historical assistant MEDIA compatibility', () => {
  it('converts image and non-image absolute paths to standard Markdown', () => {
    expect(normalizeAssistantMediaMarkdown('MEDIA:/Users/samien/图片 文件.jpg\nMEDIA:/tmp/报告.docx')).toBe(
      '![图片 文件.jpg](/Users/samien/图片 文件.jpg)\n[报告.docx](/tmp/报告.docx)',
    )
  })

  it('accepts quoted paths with Chinese, spaces, quotes, and backticks', () => {
    expect(normalizeAssistantMediaMarkdown("MEDIA:' /not-a-path'\nMEDIA:\"/Users/瑶儿/带 空格 '引号'.png\"\nMEDIA:\"/tmp/含`反引号`.pdf\"\nMEDIA:`/tmp/反引号.pdf`")).toBe(
      "MEDIA:' /not-a-path'\n![带 空格 '引号'.png](/Users/瑶儿/带 空格 '引号'.png)\n[含`反引号`.pdf](/tmp/含`反引号`.pdf)\n[反引号.pdf](/tmp/反引号.pdf)",
    )
  })

  it('waits for an unquoted streaming path to reach a line boundary', () => {
    expect(normalizeAssistantMediaMarkdown('MEDIA:/tmp/正在生成.png', true)).toBe('MEDIA:/tmp/正在生成.png')
    expect(normalizeAssistantMediaMarkdown('MEDIA:/tmp/正在生成.png\n下一行', true)).toBe('![正在生成.png](/tmp/正在生成.png)\n下一行')
    expect(normalizeAssistantMediaMarkdown('MEDIA:`/tmp/已完整.png`', true)).toBe('![已完整.png](/tmp/已完整.png)')
  })

  it('does not transform code, headings, tables, URLs, or traversal paths', () => {
    const input = [
      '```text',
      'MEDIA:/tmp/inside-code.png',
      '```',
      '`MEDIA:/tmp/inline.png`',
      '# MEDIA:/tmp/title.png',
      '| MEDIA:/tmp/table.png | value |',
      'MEDIA:https://example.com/remote.png',
      'MEDIA:/tmp/../secret.png',
    ].join('\n')
    expect(normalizeAssistantMediaMarkdown(input)).toBe(input)
  })
})

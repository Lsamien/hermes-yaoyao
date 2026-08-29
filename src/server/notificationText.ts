import { basename } from 'node:path'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

export interface NotificationTextOptions {
  fallback: string
  maximum: number
}

const MAXIMUM_SOURCE_CHARACTERS = 16 * 1_024
const markdown = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: false,
  typographer: false,
})
markdown.disable('smartquotes')
const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

function sourcePrefix(value: string): string {
  if (value.length <= MAXIMUM_SOURCE_CHARACTERS) return value
  let result = value.slice(0, MAXIMUM_SOURCE_CHARACTERS)
  const last = result.charCodeAt(result.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) result = result.slice(0, -1)
  return result
}

function inlineText(tokens: readonly Token[]): string {
  const result: string[] = []
  for (const token of tokens) {
    if (token.type === 'text') result.push(token.content)
    else if (token.type === 'code_inline') result.push(token.content)
    else if (token.type === 'softbreak' || token.type === 'hardbreak') result.push(' ')
    else if (token.type === 'image') {
      const alt = inlineText(token.children ?? []).trim() || token.content.trim() || '图片'
      result.push(`🖼️ ${alt}`)
    } else if (token.type !== 'html_inline' && token.children?.length) {
      result.push(inlineText(token.children))
    }
  }
  return result.join('')
}

function markdownText(value: string): string {
  const result: string[] = []
  for (const token of markdown.parse(value, {})) {
    if (token.type === 'inline') {
      const text = inlineText(token.children ?? []).trim()
      if (text) result.push(text)
    } else if (token.type === 'fence' || token.type === 'code_block') {
      result.push('💻 代码片段')
    } else if (token.type === 'list_item_open') {
      result.push('•')
    } else if (token.type === 'th_open' || token.type === 'td_open') {
      result.push('•')
    } else if (token.type === 'hr') {
      result.push('•')
    }
  }
  return result.join(' ')
}

function visibleBasename(value: string): string {
  const unwrapped = value.replace(/^<|>$/g, '').replace(/[\])}>,.;，。；：]+$/u, '')
  try {
    const decoded = decodeURIComponent(unwrapped)
    return basename(decoded) || '附件'
  } catch {
    return basename(unwrapped) || '附件'
  }
}

function replaceHermesReferences(value: string): string {
  return value
    .replace(/@(terminal|tool):[^\r\n]*/giu, (_match, kind: string) => (
      kind.toLowerCase() === 'terminal' ? '💻 终端信息' : '🛠️ 工具信息'
    ))
    .replace(/@(file|folder|image):\s*([^\s]+)/giu, (_match, kind: string, target: string) => {
      const icon = kind.toLowerCase() === 'image' ? '🖼️' : kind.toLowerCase() === 'folder' ? '📁' : '📎'
      return `${icon} ${visibleBasename(target)}`
    })
    .replace(/@url:\s*[^\s]+/giu, '🔗 链接')
}

function stripUnsafeTechnicalText(value: string): string {
  return value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, '')
    .split(/\r?\n/u)
    .filter(line => !/^\s*at\s+(?:async\s+)?[^\s]+.*(?:\([^)]*:\d+:\d+\)|:\d+:\d+)\s*$/u.test(line)
      && !/^\s*File\s+"[^"]+",\s+line\s+\d+/u.test(line))
    .join('\n')
}

function redactRawLocations(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s<>()]+/giu, '🔗 链接')
    .replace(/\bdata:[^\s]+/giu, '🖼️ 图片')
    .replace(/(^|[\s(（:：])((?:\/[^\s/]+){2,})/gu, (_match, prefix: string, target: string) => (
      `${prefix}📎 ${visibleBasename(target)}`
    ))
    .replace(/\[图片：([^\]]+)\]/gu, '🖼️ $1')
    .replace(/\[文件：([^\]]+)\]/gu, '📎 $1')
}

function normalizeVisibleText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .replace(/[\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, '')
    .replace(/<\/?[A-Za-z][^>]*>/gu, ' ')
    .replace(/(?:\s*•\s*){2,}/gu, ' • ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function truncateGraphemes(value: string, maximum: number): string {
  const segments = [...graphemeSegmenter.segment(value)].map(segment => segment.segment)
  if (segments.length <= maximum) return value
  return `${segments.slice(0, Math.max(0, maximum - 1)).join('')}…`
}

/** Converts model-authored Markdown into one safe, visible notification line. */
export function notificationPlainText(
  raw: unknown,
  options: NotificationTextOptions,
): string {
  const source = typeof raw === 'string' ? sourcePrefix(raw).trim() : ''
  if (!source) return options.fallback
  const prepared = replaceHermesReferences(stripUnsafeTechnicalText(source))
  const rendered = markdownText(prepared)
  const normalized = normalizeVisibleText(redactRawLocations(rendered))
  if (!normalized) return options.fallback
  return truncateGraphemes(normalized, options.maximum)
}

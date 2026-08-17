import type { ChatMessage, ConversationArtifact, JsonValue, SessionSummary } from '@shared/types'

export const ARTIFACT_EXTRACTOR_VERSION = 2

const markdownImage = /!\[([^\]]*)\]\(([^)\s]+)\)/gi
const markdownLink = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/gi
const rawUrl = /https?:\/\/[^\s<>"')]+/gi
const localPath = /(?:^|[\s(："'`])((?:\/|~\/|\.\.?\/)[^\s"'`<>]+(?:\.[a-z0-9]{1,8})?)/gim
const imageExtensions = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'])
const fileExtensions = new Set([...imageExtensions, 'pdf', 'txt', 'json', 'md', 'csv', 'zip', 'tar', 'gz', 'mp3', 'wav', '3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const keyHints = ['path', 'file', 'url', 'image', 'artifact', 'output', 'download', 'result', 'target']

interface Candidate { value: string; label?: string; mimeType?: string; attachment?: ConversationArtifact['attachment'] }

function extension(value: string): string {
  try {
    const path = new URL(value, window.location.origin).pathname
    return path.split('.').pop()?.toLowerCase() ?? ''
  } catch { return value.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '' }
}

function normalize(value: string): string {
  return value.trim().replace(/[),.;]+$/g, '')
}

function looksLikePathOrUrl(value: string): boolean {
  return ['http://', 'https://', 'file://', 'data:image/', '/', './', '../', '~/'].some(prefix => value.startsWith(prefix))
}

function looksLikeArtifact(value: string): boolean {
  if (/^(https?:\/\/|data:image\/)/i.test(value)) return true
  if (looksLikePathOrUrl(value) && fileExtensions.has(extension(value))) return true
  return value.startsWith('/') && value.includes('.')
}

function kind(value: string, mimeType?: string): ConversationArtifact['kind'] {
  if (mimeType?.startsWith('image/') || value.startsWith('data:image/') || imageExtensions.has(extension(value))) return 'image'
  if (/^(\/|\.\.?\/|~\/|file:\/\/)/.test(value)) return 'file'
  return 'link'
}

function label(value: string, artifactKind: ConversationArtifact['kind'], suggested?: string): string {
  const clean = suggested?.trim()
  if (artifactKind === 'link' && clean && clean !== value) return clean
  if (artifactKind === 'link') {
    try { return new URL(value).hostname.replace(/^www\./, '') || value } catch { return value }
  }
  if (value.startsWith('data:image/')) return '生成图片'
  try { return decodeURIComponent(new URL(value, window.location.origin).pathname.split('/').pop() || value) } catch { return value.split('/').pop() || value }
}

function textCandidates(text: string): Candidate[] {
  const result: Candidate[] = []
  for (const match of text.matchAll(markdownImage)) result.push({ value: match[2] })
  for (const match of text.matchAll(markdownLink)) result.push({ value: match[2], label: match[1] })
  for (const match of text.matchAll(rawUrl)) result.push({ value: match[0] })
  for (const match of text.matchAll(localPath)) result.push({ value: match[1] })
  return result
}

function collectStringValues(value: JsonValue, keyPath: string, output: Candidate[]): void {
  if (typeof value === 'string') {
    const normalized = normalize(value)
    if ((keyHints.some(hint => keyPath.toLowerCase().includes(hint)) || looksLikePathOrUrl(normalized)) && looksLikeArtifact(normalized)) {
      output.push({ value: normalized })
    }
    return
  }
  if (Array.isArray(value)) return value.forEach((child, index) => collectStringValues(child, `${keyPath}.${index}`, output))
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) collectStringValues(value[key], `${keyPath}.${key}`, output)
  }
}

function candidates(message: ChatMessage): Candidate[] {
  const result = textCandidates(message.content)
  for (const attachment of message.attachments ?? []) {
    const value = attachment.path || attachment.url
    if (value) result.push({ value, mimeType: attachment.mimeType, attachment })
  }
  for (const call of message.toolCalls ?? []) {
    if (call.arguments !== undefined) collectStringValues(call.arguments, 'tool.arguments', result)
    if (call.result !== undefined) collectStringValues(call.result, 'tool.result', result)
    if (call.preview) result.push(...textCandidates(call.preview))
  }
  if (message.role === 'tool') {
    try { collectStringValues(JSON.parse(message.content) as JsonValue, 'tool.result', result) } catch { /* plain tool text is already scanned */ }
  }
  return result
}

/** Extracts assistant/tool artifacts and intentionally ignores user rows. */
export function extractArtifacts(session: SessionSummary, messages: ChatMessage[]): ConversationArtifact[] {
  const found = new Map<string, ConversationArtifact>()
  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'tool') continue
    for (const candidate of candidates(message)) {
      const value = normalize(candidate.value)
      if (!value || !looksLikeArtifact(value)) continue
      const id = `${ARTIFACT_EXTRACTOR_VERSION}:${session.profile ?? ''}:${session.id}:${message.id}:${value}`
      if (found.has(id)) continue
      const artifactKind = kind(value, candidate.mimeType)
      found.set(id, {
        id,
        kind: artifactKind,
        value,
        label: label(value, artifactKind, candidate.label),
        sessionId: session.id,
        sessionTitle: session.title,
        profile: session.profile,
        messageId: message.id,
        timestamp: message.timestamp || session.updatedAt,
        mimeType: candidate.mimeType,
        attachment: candidate.attachment,
      })
    }
  }
  return [...found.values()]
}

import type { UiMessage } from '@/components/messages/types'

export type SessionOutlineItem = {
  id: string
  type: 'user' | 'heading'
  content: string
  messageId: string
  level: 0 | 1 | 2 | 3
  anchorId: string
  createdAt?: UiMessage['createdAt']
}

function cleanMessageText(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function userQuestion(message: UiMessage): string {
  const firstLine = cleanMessageText(message.content).split('\n').map(line => line.trim()).find(Boolean) || '用户消息'
  return firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine
}

function assistantHeadings(message: UiMessage): SessionOutlineItem[] {
  const result: SessionOutlineItem[] = []
  let headingIndex = 0
  let fence = ''
  for (const line of cleanMessageText(message.content).split('\n')) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(```+|~~~+)/)
    if (fenceMatch) {
      fence = fence ? '' : fenceMatch[1]![0]!
      continue
    }
    if (fence) continue
    const match = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/)
    if (!match) continue
    headingIndex += 1
    const level = match[1]!.length as 1 | 2 | 3
    result.push({
      id: `outline-${message.id}-heading-${headingIndex}`,
      type: 'heading',
      content: match[2]!.trim(),
      messageId: message.id,
      level,
      anchorId: `outline-${message.id}-heading-${headingIndex}`,
      createdAt: message.createdAt,
    })
  }
  return result
}

/** Builds the loaded-session outline from user turns and assistant Markdown headings. */
export function buildSessionOutline(messages: UiMessage[]): SessionOutlineItem[] {
  const visible = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && !message.timelineKind)
  const items: SessionOutlineItem[] = []
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index]!
    if (message.role !== 'user') continue
    items.push({
      id: `outline-user-${message.id}`,
      type: 'user',
      content: userQuestion(message),
      messageId: message.id,
      level: 0,
      anchorId: `message-${message.id}`,
      createdAt: message.createdAt,
    })
    for (let replyIndex = index + 1; replyIndex < visible.length && visible[replyIndex]?.role !== 'user'; replyIndex += 1) {
      items.push(...assistantHeadings(visible[replyIndex]!))
    }
  }
  return items
}

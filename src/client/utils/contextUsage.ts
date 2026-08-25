import type { ChatMessage } from '@shared/types'

function estimateTextTokens(value: string): number {
  const nonAscii = (value.match(/[^\x00-\x7F]/g) ?? []).length
  return Math.ceil((value.length - nonAscii) / 4 + nonAscii * 0.9)
}

/**
 * A clearly-labelled fallback for gateways that do not persist a live context
 * gauge after a session has gone idle. It is intentionally conservative and
 * estimates only visible conversation payloads, never a model's hidden prompt.
 */
export function estimateConversationTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const tools = message.toolCalls?.map(tool => JSON.stringify({
      name: tool.name, arguments: tool.arguments, result: tool.result, error: tool.error,
    })).join('\n') ?? ''
    return total + estimateTextTokens([message.content, message.reasoning ?? '', tools].join('\n'))
  }, 0)
}

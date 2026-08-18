function calendarStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

export function formatMessageTime(value: string | number | Date | undefined, now = new Date()): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  const days = Math.round((calendarStart(now) - calendarStart(date)) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `昨天 ${time}`
  if (days >= 2 && days < 7) {
    return `周${'日一二三四五六'[date.getDay()]} ${time}`
  }
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear() ? `${dateLabel} ${time}` : `${date.getFullYear()}年${dateLabel} ${time}`
}

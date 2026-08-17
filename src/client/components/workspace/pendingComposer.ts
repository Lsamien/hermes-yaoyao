import type { UiLibraryItem } from '@/components/library/types'

const KEY = 'hermes-yaoyao:pending-composer-item'

type PendingItem = { name: string; url: string; mimeType?: string }

export function queueLibraryItemForComposer(item: UiLibraryItem): boolean {
  const url = item.downloadUrl || item.previewUrl
  if (!url) return false
  const pending: PendingItem = { name: item.name, url, mimeType: item.mimeType }
  sessionStorage.setItem(KEY, JSON.stringify(pending))
  return true
}

export async function consumeLibraryItemForComposer(): Promise<File | null> {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return null
  sessionStorage.removeItem(KEY)
  try {
    const pending = JSON.parse(raw) as PendingItem
    if (!pending.url || !pending.name) return null
    const response = await fetch(pending.url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`下载文件失败（${response.status}）`)
    const blob = await response.blob()
    return new File([blob], pending.name, { type: pending.mimeType || blob.type || 'application/octet-stream' })
  } catch {
    return null
  }
}

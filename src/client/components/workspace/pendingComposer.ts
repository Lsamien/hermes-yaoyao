import type { UiLibraryItem } from '@/components/library/types'

const KEY = 'hermes-yaoyao:pending-composer-item'

type PendingItem = { name: string; url: string; mimeType?: string }

type ComposerFileSource = Pick<UiLibraryItem, 'name' | 'previewUrl' | 'downloadUrl' | 'mimeType'>

export function queueLibraryItemForComposer(item: UiLibraryItem): boolean {
  const url = item.downloadUrl || item.previewUrl
  if (!url) return false
  const pending: PendingItem = { name: item.name, url, mimeType: item.mimeType }
  sessionStorage.setItem(KEY, JSON.stringify(pending))
  return true
}

export async function loadComposerFile(item: ComposerFileSource): Promise<File | null> {
  const url = item.downloadUrl || item.previewUrl
  if (!url || !item.name) return null
  try {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`下载文件失败（${response.status}）`)
    const blob = await response.blob()
    return new File([blob], item.name, { type: item.mimeType || blob.type || 'application/octet-stream' })
  } catch {
    return null
  }
}

export async function consumeLibraryItemForComposer(): Promise<File | null> {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return null
  sessionStorage.removeItem(KEY)
  try {
    const pending = JSON.parse(raw) as PendingItem
    return await loadComposerFile({ name: pending.name, downloadUrl: pending.url, mimeType: pending.mimeType })
  } catch {
    return null
  }
}

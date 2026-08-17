export type LibraryKind = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'code' | 'text' | 'file' | 'link'

export type LibraryFilterOption = {
  id: string
  label: string
  count?: number
  icon: 'files' | 'image' | 'video' | 'audio' | 'file' | 'link' | 'artifacts'
}

export type UiLibraryItem = {
  id: string
  name: string
  kind: LibraryKind
  mimeType?: string
  size?: number
  createdAt?: string | number | Date
  updatedAt?: string | number | Date
  previewUrl?: string
  downloadUrl?: string
  sourceLabel?: string
  sourceSessionId?: string
  sourceMessageId?: string
  sourceProfile?: string
  textContent?: string
  title?: string
}

import type { FileKind, FileLibraryPage } from '@shared/types'
import { apiRequest, apiUrl, unwrapData } from './client'
import { normalizeFile, number, record, values } from '@/utils/normalize'

export interface FileQuery {
  search?: string
  kind?: FileKind | 'all'
  profile?: string
  conversationOnly?: boolean
  cursor?: string
  limit?: number
}

export async function getFiles(query: FileQuery = {}): Promise<FileLibraryPage> {
  const serverKind = query.kind === 'image' || query.kind === 'video' ? query.kind : undefined
  const payload = unwrapData(await apiRequest<unknown>(apiUrl('/api/app/files', {
    search: query.search,
    kind: serverKind,
    profile: query.profile,
    conversationOnly: query.conversationOnly || undefined,
    cursor: query.cursor,
    limit: Math.max(1, Math.min(100, query.limit ?? 50)),
  })))
  const source = record(payload)
  const responseProfile = typeof source.profile === 'string' ? source.profile : query.profile
  return {
    items: values(source.items ?? source.files ?? payload)
      .map(item => normalizeFile(item, responseProfile)).filter(file => file.id),
    nextCursor: typeof source.nextCursor === 'string' ? source.nextCursor : typeof source.next_cursor === 'string' ? source.next_cursor : null,
    total: number(source.total) || undefined,
  }
}

export function fileDownloadUrl(id: string, profile?: string): string {
  return apiUrl(`/api/app/files/${encodeURIComponent(id)}/download`, { profile })
}

export function filePreviewUrl(id: string, profile?: string): string {
  return apiUrl(`/api/app/files/${encodeURIComponent(id)}/preview`, { profile })
}

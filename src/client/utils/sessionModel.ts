import type { ModelOption } from '@shared/types'
import { record, string } from '@/utils/normalize'

export interface SessionModelSelection {
  model: string
  provider?: string
}

export function modelForSession(options: ModelOption[], model?: string, provider?: string): ModelOption | undefined {
  const id = model?.trim()
  if (!id) return undefined
  const normalizedId = id.toLocaleLowerCase()
  const normalizedProvider = provider?.trim().toLocaleLowerCase() || ''
  const exact = options.find(option => option.id.toLocaleLowerCase() === normalizedId
    && (!normalizedProvider || option.provider.toLocaleLowerCase() === normalizedProvider))
  if (exact) return exact
  const byId = options.find(option => option.id.toLocaleLowerCase() === normalizedId)
  if (byId) return byId
  return { id, name: id, provider: provider?.trim() || '' }
}

export function modelSelectionFromSessionInfo(payload: unknown): SessionModelSelection | undefined {
  const source = record(payload)
  const info = record(source.info)
  const model = string(source.model ?? info.model).trim()
  if (!model) return undefined
  const provider = string(source.provider ?? info.provider).trim()
  return { model, provider: provider || undefined }
}

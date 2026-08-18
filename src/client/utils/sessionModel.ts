import type { ModelOption } from '@shared/types'

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

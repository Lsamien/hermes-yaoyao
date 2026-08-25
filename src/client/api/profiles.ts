import type { JsonValue, ModelOption, Profile } from '@shared/types'
import { apiRequest, unwrapData } from './client'
import { normalizeModel, normalizeProfile, record, values } from '@/utils/normalize'
import { ChatRpcSocket } from './realtime'

const MAX_AGENT_NAME_LENGTH = 100
const MAX_AGENT_AVATAR_LENGTH = 512_000
const avatarDataURLPattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i

export type ProfileIdentityInput = {
  title: string
  avatarDataURL: string | null
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  return record(value) as Record<string, JsonValue>
}

function readProfileEntries(value: JsonValue): Record<string, JsonValue>[] {
  const source = jsonObject(value)
  return values(source.profiles).flatMap(item => {
    const outer = jsonObject(item)
    const profile = jsonObject(outer.profile)
    return Object.keys(profile).length ? [profile] : [outer]
  })
}

function validateIdentity(input: ProfileIdentityInput): ProfileIdentityInput {
  const title = input.title.trim().replace(/\s+/g, ' ')
  if (!title || title.length > MAX_AGENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error(`Agent 名称应为 1 至 ${MAX_AGENT_NAME_LENGTH} 个字符`)
  }
  const avatarDataURL = input.avatarDataURL?.trim() || null
  if (avatarDataURL && (avatarDataURL.length > MAX_AGENT_AVATAR_LENGTH || !avatarDataURLPattern.test(avatarDataURL))) {
    throw new Error('头像必须是小于 375 KB 的 PNG、JPEG 或 WebP 图片')
  }
  return { title, avatarDataURL }
}

/**
 * Hermes owns this metadata in profile.yaml. Reading it immediately before the
 * write preserves Bot chat bindings and lets the upstream revision guard
 * reject a concurrent edit instead of silently overwriting it.
 */
export async function updateProfileIdentity(profile: Profile, input: ProfileIdentityInput): Promise<void> {
  const identity = validateIdentity(input)
  const control = new ChatRpcSocket()
  await control.connect()
  try {
    const listed = await control.request('profiles.list', { include_sessions: false })
    const current = readProfileEntries(listed).find(item => String(item.name ?? '') === profile.name)
    if (!current) throw new Error('该 Agent 已不存在，请刷新后重试')
    const uiMeta = jsonObject(current.ui_meta)
    const botMeta: Record<string, JsonValue> = { ...jsonObject(uiMeta['hermes-bots']), title: identity.title }
    if (identity.avatarDataURL) botMeta.avatar = identity.avatarDataURL
    else delete botMeta.avatar
    const revisions = jsonObject(current.ui_meta_revisions)
    const revision = revisions['hermes-bots']
    await control.request('profiles.configure', {
      name: profile.name,
      ui_meta: { 'hermes-bots': botMeta },
      ...(typeof revision === 'number' ? { ui_meta_expected_revisions: { 'hermes-bots': revision } } : {}),
    })
  } finally {
    control.close()
  }
}

export async function getProfiles(): Promise<Profile[]> {
  const payload = unwrapData(await apiRequest<unknown>('/api/app/profiles'))
  const source = record(payload)
  return values(source.profiles ?? source.items ?? payload).map(normalizeProfile)
}

export async function getModels(profile?: string): Promise<ModelOption[]> {
  const suffix = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const payload = unwrapData(await apiRequest<unknown>(`/api/app/models${suffix}`))
  const source = record(payload)
  if (Array.isArray(source.providers)) {
    const currentModel = typeof source.model === 'string' ? source.model : ''
    const currentProvider = typeof source.provider === 'string' ? source.provider : ''
    return source.providers.flatMap(rawProvider => {
      const provider = record(rawProvider)
      const slug = typeof provider.slug === 'string' ? provider.slug : typeof provider.name === 'string' ? provider.name : ''
      const capabilities = record(provider.capabilities)
      return values(provider.models).flatMap(rawModel => {
        const model = typeof rawModel === 'string' ? rawModel : String(record(rawModel).id ?? record(rawModel).model ?? '')
        if (!model || !slug) return []
        const modelCapabilities = record(capabilities[model])
        return [{
          id: model,
          name: model,
          provider: slug,
          supportsReasoning: typeof modelCapabilities.reasoning === 'boolean' ? modelCapabilities.reasoning : undefined,
          isDefault: model === currentModel && slug === currentProvider,
        } satisfies ModelOption]
      })
    })
  }
  return values(source.models ?? source.items ?? payload).map(normalizeModel).filter(model => model.id)
}

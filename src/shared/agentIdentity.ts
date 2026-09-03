export const YAOYAO_AGENT_IDENTITY_NAMESPACE = 'hermes-yaoyao-identity'
export const YAOYAO_AGENT_IDENTITY_VERSION = 2
export const AVATAR_DESCRIPTOR_PREFIX = 'yaoyao-avatar:v2:'
export const MAX_AVATAR_IMAGE_LENGTH = 2_800_000
export const MAX_AVATAR_DESCRIPTOR_LENGTH = MAX_AVATAR_IMAGE_LENGTH + 4096
export const AGENT_MASCOT_SHAPES = ['circle', 'square', 'triangle', 'ellipse', 'capsule', 'hexagon', 'cloud', 'droplet'] as const
export type AgentMascotShape = typeof AGENT_MASCOT_SHAPES[number]
export const AGENT_MASCOT_SHAPE_OPTIONS: readonly AgentMascotShape[] = ['circle', 'ellipse', 'square', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet']
export const AGENT_MASCOT_EXPRESSIONS = ['idle', 'happy', 'curious', 'drowsy', 'working', 'thinking', 'listening', 'sleeping', 'suspicious', 'proud'] as const
export type AgentMascotExpression = typeof AGENT_MASCOT_EXPRESSIONS[number]
export const AGENT_MASCOT_BODIES = ['cursor', 'blob', 'circle', 'squircle', 'capsule', 'drop', 'shield', 'hexagon', 'diamond', 'star'] as const
export type AgentMascotBody = typeof AGENT_MASCOT_BODIES[number]
export const AGENT_MASCOT_BODY_LABELS: Record<AgentMascotBody, string> = { cursor: '光标', blob: '软团', circle: '圆球', squircle: '圆角块', capsule: '胶囊体', drop: '液滴', shield: '盾牌', hexagon: '六边体', diamond: '菱形', star: '星星' }
export const AGENT_MASCOT_EXPRESSION_LABELS: Record<AgentMascotExpression, string> = { idle: '默认', happy: '开心', curious: '好奇', drowsy: '困倦', working: '工作', thinking: '思考', listening: '倾听', sleeping: '睡眠', suspicious: '疑惑', proud: '自豪' }
export const AGENT_MASCOT_COLORS = ['#000000', '#94643a', '#ff2d45', '#ff6b00', '#ff9900', '#00c875', '#00b9ac', '#1488ff', '#9655f7', '#f52ba5', '#808080'] as const
export const AGENT_MASCOT_COLOR_LABELS: Record<string, string> = { '#000000':'黑色', '#94643a':'棕色', '#ff2d45':'红色', '#ff6b00':'橙色', '#ff9900':'金黄色', '#00c875':'绿色', '#00b9ac':'青绿色', '#1488ff':'蓝色', '#9655f7':'紫色', '#f52ba5':'粉色', '#808080':'灰色' }
export const AGENT_IMAGE_CROPS = ['circle', 'rounded', 'square'] as const
export type AgentImageCrop = typeof AGENT_IMAGE_CROPS[number]
export type AgentAvatarMode = 'mascot' | 'image'
export interface AgentIdentity {
  version: 2
  displayName: string
  avatarMode: AgentAvatarMode
  shape: AgentMascotShape
  color: string
  expression: AgentMascotExpression
  bodyId?: AgentMascotBody | null
  imageCrop?: AgentImageCrop
  imageDataURL?: string
}
export interface AgentIdentityProfileSource { name?: unknown; display_name?: unknown; displayName?: unknown; description?: unknown; ui_meta?: unknown }
const imagePattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i
const legacyPattern = /^yaoyao-mascot:v1:(circle|square|triangle|ellipse|capsule|hexagon|cloud|droplet):([0-9a-f]{6}):(friendly|focused|curious|calm)$/i
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }
function name(v: unknown): string { return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 100) : '' }
export function validAvatarImage(v: unknown): boolean { return typeof v === 'string' && v.length <= MAX_AVATAR_IMAGE_LENGTH && imagePattern.test(v) }
export function defaultAgentIdentity(profile: string, displayName?: string): AgentIdentity {
  return { version: 2, displayName: name(displayName) || name(profile) || 'default', avatarMode: 'mascot', shape: 'circle', color: '#00c875', expression: 'idle', bodyId: null, imageCrop: 'rounded' }
}
function descriptor(v: Record<string, unknown>): AgentIdentity | null {
  if (v.version !== 2 || !['mascot', 'image'].includes(String(v.avatarMode)) || !AGENT_MASCOT_SHAPES.includes(v.shape as AgentMascotShape)
      || typeof v.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.color)
      || !AGENT_MASCOT_EXPRESSIONS.includes(v.expression as AgentMascotExpression)
      || (v.bodyId != null && !AGENT_MASCOT_BODIES.includes(v.bodyId as AgentMascotBody))
      || (v.imageCrop != null && !AGENT_IMAGE_CROPS.includes(v.imageCrop as AgentImageCrop))
      || (v.imageDataURL != null && !validAvatarImage(v.imageDataURL))
      || (v.avatarMode === 'image' && !validAvatarImage(v.imageDataURL))) return null
  return { version: 2, displayName: name(v.displayName), avatarMode: v.avatarMode as AgentAvatarMode, shape: v.shape as AgentMascotShape, color: v.color.toLowerCase(), expression: v.expression as AgentMascotExpression,
    bodyId: v.bodyId as AgentMascotBody | null ?? null, imageCrop: v.imageCrop as AgentImageCrop ?? 'rounded', ...(v.imageDataURL ? { imageDataURL: v.imageDataURL as string } : {}) }
}
export function decodeAgentAvatar(value: string | undefined): AgentIdentity | null {
  if (!value || value.length > MAX_AVATAR_DESCRIPTOR_LENGTH) return null
  if (validAvatarImage(value)) return { ...defaultAgentIdentity(''), avatarMode: 'image', imageDataURL: value }
  if (legacyPattern.test(value)) return defaultAgentIdentity('')
  if (!value.startsWith(AVATAR_DESCRIPTOR_PREFIX)) return null
  try { return descriptor(object(JSON.parse(value.slice(AVATAR_DESCRIPTOR_PREFIX.length)))) } catch { return null }
}
export function encodeAgentAvatar(identity: AgentIdentity): string {
  const value = descriptor({ ...identity, version: 2, bodyId: identity.bodyId ?? null, imageCrop: identity.imageCrop ?? 'rounded' })
  if (!value) throw new Error('无效的头像设置')
  const { displayName: _, ...data } = value
  return AVATAR_DESCRIPTOR_PREFIX + JSON.stringify(data)
}
export function decodeAgentMascotAvatar(value: string | undefined): AgentIdentity | null {
  const identity = decodeAgentAvatar(value)
  return identity?.avatarMode === 'mascot' ? identity : null
}
export function isAgentImageAvatar(value: string | undefined): boolean { return decodeAgentAvatar(value)?.avatarMode === 'image' }
export function normalizeAvatar(value: string | undefined): string { return encodeAgentAvatar(decodeAgentAvatar(value) ?? defaultAgentIdentity('')) }
export function agentIdentityFromProfile(source: AgentIdentityProfileSource): AgentIdentity {
  const meta = object(source.ui_meta), current = object(meta[YAOYAO_AGENT_IDENTITY_NAMESPACE]), legacy = object(meta['hermes-bots'])
  const displayName = name(current.display_name) || name(legacy.title) || name(source.display_name) || name(source.displayName) || name(source.description) || name(source.name)
  const fallback = defaultAgentIdentity(name(source.name), displayName)
  const image = validAvatarImage(current.image_data_url) ? current.image_data_url as string : validAvatarImage(legacy.avatar) ? legacy.avatar as string : undefined
  if (current.version !== 2) return { ...fallback, ...(image ? { imageDataURL: image, avatarMode: current.avatar_mode === 'image' || !Object.keys(current).length ? 'image' as const : 'mascot' as const } : {}) }
  return descriptor({ version: 2, displayName, avatarMode: current.avatar_mode, shape: current.shape, color: current.color, expression: current.expression, bodyId: current.body_id, imageCrop: current.image_crop, imageDataURL: current.image_data_url }) ?? fallback
}
export function agentIdentityMetadata(identity: AgentIdentity): Record<string, unknown> {
  const v = descriptor({ ...identity })
  if (!v) throw new Error('无效的头像设置')
  return { version: 2, display_name: name(identity.displayName), avatar_mode: v.avatarMode, shape: v.shape, color: v.color, expression: v.expression, body_id: v.bodyId, image_crop: v.imageCrop, ...(v.imageDataURL ? { image_data_url: v.imageDataURL } : {}) }
}

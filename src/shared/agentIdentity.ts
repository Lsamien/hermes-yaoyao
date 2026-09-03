export const YAOYAO_AGENT_IDENTITY_NAMESPACE = 'hermes-yaoyao-identity'
export const YAOYAO_AGENT_IDENTITY_VERSION = 1

export const AGENT_MASCOT_SHAPES = ['circle', 'square', 'triangle', 'ellipse', 'capsule', 'hexagon', 'cloud', 'droplet'] as const
export type AgentMascotShape = typeof AGENT_MASCOT_SHAPES[number]
export const AGENT_MASCOT_SHAPE_OPTIONS: readonly AgentMascotShape[] = ['circle', 'ellipse', 'square', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet']

export const AGENT_MASCOT_EXPRESSIONS = ['friendly', 'focused', 'curious', 'calm'] as const
export type AgentMascotExpression = typeof AGENT_MASCOT_EXPRESSIONS[number]

export const AGENT_MASCOT_COLORS = [
  '#009957', '#377fe6', '#d94b52', '#e78531', '#8057c8',
  '#0ea5c6', '#d84f8b', '#d8a729', '#01a492', '#e5634e',
  '#000000', '#a2845e', '#ff2dab', '#8e8e93',
] as const

export type AgentAvatarMode = 'mascot' | 'image'

export interface AgentIdentity {
  version: 1
  displayName: string
  avatarMode: AgentAvatarMode
  shape: AgentMascotShape
  color: string
  expression: AgentMascotExpression
  imageDataURL?: string
}

export interface AgentIdentityProfileSource {
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  description?: unknown
  ui_meta?: unknown
}

const imageDataURLPattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i
const mascotAvatarPattern = /^yaoyao-mascot:v1:(circle|square|triangle|ellipse|capsule|hexagon|cloud|droplet):([0-9a-f]{6}):(friendly|focused|curious|calm)$/i

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanName(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 100)
    : ''
}

function stableIndex(value: string, modulo: number): number {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(value || 'default')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash % modulo
}

export function defaultAgentIdentity(profileName: string, displayName?: string): AgentIdentity {
  const key = profileName.trim() || 'default'
  return {
    version: YAOYAO_AGENT_IDENTITY_VERSION,
    displayName: cleanName(displayName) || key,
    avatarMode: 'mascot',
    shape: AGENT_MASCOT_SHAPES[stableIndex(`${key}:shape`, 3)]!,
    color: AGENT_MASCOT_COLORS[stableIndex(`${key}:color`, 10)]!,
    expression: AGENT_MASCOT_EXPRESSIONS[stableIndex(`${key}:expression`, AGENT_MASCOT_EXPRESSIONS.length)]!,
  }
}

export function agentIdentityFromProfile(source: AgentIdentityProfileSource): AgentIdentity {
  const profileName = cleanName(source.name) || 'default'
  const uiMeta = object(source.ui_meta)
  const current = object(uiMeta[YAOYAO_AGENT_IDENTITY_NAMESPACE])
  const legacy = object(uiMeta['hermes-bots'])
  const inheritedName = cleanName(current.display_name)
    || cleanName(legacy.title)
    || cleanName(source.display_name)
    || cleanName(source.displayName)
    || cleanName(source.description)
    || profileName
  const fallback = defaultAgentIdentity(profileName, inheritedName)
  const shape = AGENT_MASCOT_SHAPES.includes(current.shape as AgentMascotShape)
    ? current.shape as AgentMascotShape
    : fallback.shape
  const expression = AGENT_MASCOT_EXPRESSIONS.includes(current.expression as AgentMascotExpression)
    ? current.expression as AgentMascotExpression
    : fallback.expression
  const color = typeof current.color === 'string' && /^#[0-9a-f]{6}$/i.test(current.color)
    ? current.color.toLowerCase()
    : fallback.color
  const imageDataURL = typeof current.image_data_url === 'string'
    && current.image_data_url.length <= 2_800_000
    && imageDataURLPattern.test(current.image_data_url)
    ? current.image_data_url
    : undefined
  const avatarMode: AgentAvatarMode = current.avatar_mode === 'image' && imageDataURL
    ? 'image'
    : 'mascot'
  return {
    version: YAOYAO_AGENT_IDENTITY_VERSION,
    displayName: inheritedName,
    avatarMode,
    shape,
    color,
    expression,
    ...(imageDataURL ? { imageDataURL } : {}),
  }
}

export function agentIdentityMetadata(identity: AgentIdentity): Record<string, unknown> {
  return {
    version: YAOYAO_AGENT_IDENTITY_VERSION,
    display_name: cleanName(identity.displayName),
    avatar_mode: identity.avatarMode,
    shape: identity.shape,
    color: identity.color.toLowerCase(),
    expression: identity.expression,
    ...(identity.imageDataURL ? { image_data_url: identity.imageDataURL } : {}),
  }
}

export function encodeAgentAvatar(identity: AgentIdentity): string {
  if (identity.avatarMode === 'image' && identity.imageDataURL) return identity.imageDataURL
  return `yaoyao-mascot:v1:${identity.shape}:${identity.color.replace('#', '').toLowerCase()}:${identity.expression}`
}

export function decodeAgentMascotAvatar(value: string | undefined): Pick<AgentIdentity, 'shape' | 'color' | 'expression'> | null {
  const match = value?.match(mascotAvatarPattern)
  if (!match) return null
  return {
    shape: match[1]!.toLowerCase() as AgentMascotShape,
    color: `#${match[2]!.toLowerCase()}`,
    expression: match[3]!.toLowerCase() as AgentMascotExpression,
  }
}

export function isAgentImageAvatar(value: string | undefined): boolean {
  return Boolean(value && imageDataURLPattern.test(value))
}

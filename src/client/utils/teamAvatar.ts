import foxAvatar from '@/assets/team-avatars/fox.png'
import whaleAvatar from '@/assets/team-avatars/whale.png'
import owlAvatar from '@/assets/team-avatars/owl.png'
import rabbitAvatar from '@/assets/team-avatars/rabbit.png'
import bearAvatar from '@/assets/team-avatars/bear.png'

export const TEAM_ANIMAL_AVATAR_PREFIX = 'builtin:team-animal:'

export const TEAM_ANIMAL_AVATARS = [
  { id: 'fox', label: '狐狸', value: `${TEAM_ANIMAL_AVATAR_PREFIX}fox`, src: foxAvatar },
  { id: 'whale', label: '鲸鱼', value: `${TEAM_ANIMAL_AVATAR_PREFIX}whale`, src: whaleAvatar },
  { id: 'owl', label: '猫头鹰', value: `${TEAM_ANIMAL_AVATAR_PREFIX}owl`, src: owlAvatar },
  { id: 'rabbit', label: '兔子', value: `${TEAM_ANIMAL_AVATAR_PREFIX}rabbit`, src: rabbitAvatar },
  { id: 'bear', label: '小熊', value: `${TEAM_ANIMAL_AVATAR_PREFIX}bear`, src: bearAvatar },
] as const

export function teamAnimalAvatar(value?: string) {
  return TEAM_ANIMAL_AVATARS.find(avatar => avatar.value === value)
}

export function randomTeamAnimalAvatar(): typeof TEAM_ANIMAL_AVATARS[number] {
  return TEAM_ANIMAL_AVATARS[Math.floor(Math.random() * TEAM_ANIMAL_AVATARS.length)]!
}

export function fallbackTeamAnimalAvatar(key: string): typeof TEAM_ANIMAL_AVATARS[number] {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(key || 'team')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return TEAM_ANIMAL_AVATARS[hash % TEAM_ANIMAL_AVATARS.length]!
}

export function resolvedTeamAvatarSource(value: string | undefined, fallbackKey: string): string {
  if (value && /^data:image\/(png|jpeg|webp);base64,/i.test(value)) return value
  return (teamAnimalAvatar(value) ?? fallbackTeamAnimalAvatar(fallbackKey)).src
}

const SUPPORTED_TEAM_AVATAR_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

function resizeAvatar(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('当前浏览器不支持图片处理'))
      const edge = Math.min(image.width, image.height)
      context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 256, 256)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('请选择有效的 PNG、JPEG 或 WebP 图片'))
    image.src = source
  })
}

export async function processTeamAvatarFile(file: File): Promise<string> {
  if (!SUPPORTED_TEAM_AVATAR_TYPES.has(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片')
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB')
  return resizeAvatar(await readImage(file))
}

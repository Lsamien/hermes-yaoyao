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

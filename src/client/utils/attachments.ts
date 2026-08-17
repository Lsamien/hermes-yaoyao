export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface EncodedAttachment {
  name: string
  mimeType: string
  size: number
  base64: string
  dataUrl: string
  extension: string
  kind: 'image' | 'pdf' | 'file'
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

export async function encodeAttachment(file: File): Promise<EncodedAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 25 MiB 限制`)
  const dataUrl = await readAsDataURL(file)
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error(`${file.name} 编码失败`)
  const mimeType = file.type || 'application/octet-stream'
  return {
    name: file.name,
    mimeType,
    size: file.size,
    base64: dataUrl.slice(separator + 1),
    dataUrl,
    extension: file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '',
    kind: mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file',
  }
}

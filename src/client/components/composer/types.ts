export type ComposerAttachment = {
  id: string
  file: File
  name: string
  size: number
  type: string
  previewUrl?: string
}

export type ComposerReference = {
  id: string
  content: string
  author?: string
}

export type ComposerOption = {
  id: string
  label: string
  detail?: string
  disabled?: boolean
  insertText?: string
}

export type ComposerSubmit = {
  text: string
  files: File[]
  mentionIds: string[]
}

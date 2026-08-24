export type UiAgent = {
  id: string
  name: string
  profile?: string
  enabled?: boolean
  status?: 'idle' | 'working' | 'offline' | 'error'
  autoReply?: boolean
  isHost?: boolean
  replyRounds?: number
}

export type UiRoom = {
  id: string
  name: string
  description?: string
  instructions?: string
  archived?: boolean
  memberIds?: string[]
  autoReply?: boolean
  replyRounds?: number
  orchestrationMode?: 'free' | 'host'
}

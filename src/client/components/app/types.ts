export type SidebarItemBase = {
  id: string
  title: string
  subtitle?: string
  meta?: string
  section?: string
  active?: boolean
  unread?: number
  pinned?: boolean
  nested?: boolean
  topic?: boolean
  showMore?: boolean
  expandable?: boolean
  expanded?: boolean
  status?: 'online' | 'working' | 'offline'
  icon?: 'chat' | 'groups' | 'file' | 'image' | 'video' | 'audio' | 'link' | 'artifacts' | 'branch' | 'topic' | 'chevron-left' | 'plus' | 'archive'
  avatarKind?: 'agent' | 'team'
  avatarState?: 'idle' | 'working' | 'waiting'
  avatar?: string
  avatarFallbackKey?: string
  avatarMembers?: Array<{ name: string; avatar?: string; state?: 'idle' | 'working' | 'waiting' }>
  emptyText?: string
}

export type SidebarItem = SidebarItemBase & { children?: SidebarItemBase[] }

export type SidebarItem = {
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
  icon?: 'chat' | 'groups' | 'file' | 'image' | 'video' | 'audio' | 'link' | 'artifacts' | 'branch' | 'topic' | 'chevron-left' | 'plus'
  avatar?: string
  avatarMembers?: Array<{ name: string; avatar?: string }>
}

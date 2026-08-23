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
  showMore?: boolean
  expandable?: boolean
  expanded?: boolean
  status?: 'online' | 'working' | 'offline'
  icon?: 'chat' | 'groups' | 'file' | 'image' | 'video' | 'audio' | 'link' | 'artifacts' | 'branch'
}

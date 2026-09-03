<script setup lang="ts">
import { computed, ref } from 'vue'
import ResourceSidebar from '@/components/app/ResourceSidebar.vue'
import type { SidebarItem } from '@/components/app/types'
import { workspaceAvatarMembers, workspaceAvatarState } from './viewModels'
import { formatMessageTime } from '@/utils/messageTime'
import type { WorkspaceAgent, WorkspaceConversation } from '@shared/workspace'
const props = withDefaults(defineProps<{ conversations: WorkspaceConversation[]; agents?: WorkspaceAgent[]; selected?: string }>(), { agents: () => [] })
const emit = defineEmits<{ select: [id: string]; pin: [id: string]; archive: [id: string] }>()
const query = ref(''), archived = ref(false), menuId = ref('')
const menuPosition = ref({ left: '8px', top: '8px' })
const menuConversation = computed(() => props.conversations.find(c => c.id === menuId.value))
const rows = computed<SidebarItem[]>(() => props.conversations.filter(c => c.archived === archived.value &&
  (!query.value || `${c.name} ${c.preview}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
  .map(c => ({ id: c.id, title: c.name, subtitle: c.preview || '开始聊天', pinned: c.pinned,
    section: c.pinned ? '已置顶' : '聊天', avatar: c.kind === 'group' ? '' : c.avatar,
    avatarMembers: c.kind === 'group' ? workspaceAvatarMembers(c.memberIds, props.agents, c) : [],
    meta: formatMessageTime(c.lastMessageAt ?? c.createdAt),
    avatarKind: c.kind === 'direct' ? 'agent' : 'team',
    avatarState: workspaceAvatarState(c, c.memberIds[0] || ''),
    unread: c.unreadCount ?? Math.max(0, c.lastSeq - c.readSeq), status: c.activeRunId ? 'working' : undefined })))
function openMenu(id: string, event: MouseEvent) {
  menuId.value = id
  menuPosition.value = { left: `${Math.max(8, Math.min(event.clientX, window.innerWidth - 170))}px`, top: `${Math.max(8, Math.min(event.clientY, window.innerHeight - 100))}px` }
}
function action(kind: 'pin' | 'archive') {
  if (kind === 'pin') emit('pin', menuId.value)
  else emit('archive', menuId.value)
  menuId.value = ''
}
</script>
<template>
  <div class="conversation-list">
    <label class="archive-filter"><input v-model="archived" type="checkbox" />显示已归档</label>
    <ResourceSidebar :items="rows" :active-id="selected" :search="query" search-placeholder="搜索聊天"
      empty-title="还没有聊天" empty-description="创建 Agent，或选择成员新建群聊。"
      @search="query = $event" @select="emit('select', $event)" @more="openMenu" @context-menu="openMenu" />
    <Teleport to="body">
      <div v-if="menuConversation" class="conversation-menu-dismiss" @pointerdown.self="menuId = ''" @keydown.esc="menuId = ''">
        <section class="conversation-actions" :style="menuPosition" role="menu" aria-label="聊天操作">
          <button role="menuitem" @click="action('pin')">{{ menuConversation.pinned ? '取消置顶' : '置顶聊天' }}</button>
          <button role="menuitem" @click="action('archive')">{{ menuConversation.archived ? '恢复聊天' : '归档聊天' }}</button>
        </section>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.conversation-list{display:flex;flex:1;flex-direction:column;min-height:0}.archive-filter{display:flex;align-items:center;gap:6px;padding:8px 12px;color:var(--text-muted);font-size:11px}
.conversation-menu-dismiss{position:fixed;inset:0;z-index:200}.conversation-actions{position:absolute;display:grid;min-width:155px;padding:5px;border:1px solid var(--line);border-radius:10px;background:var(--surface-raised);box-shadow:var(--shadow-float)}.conversation-actions button{padding:9px 12px;border:0;border-radius:7px;background:transparent;color:var(--text-primary);text-align:left;cursor:pointer;font-size:12px}.conversation-actions button:hover{background:var(--surface-hover)}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import type { WorkspaceConversation } from '@shared/workspace'
const props = defineProps<{ conversations: WorkspaceConversation[]; selected?: string }>()
defineEmits<{ select: [id: string] }>()
const query = ref(''),
  archived = ref(false)
const rows = computed(() =>
  props.conversations.filter(
    (c) =>
      c.archived === archived.value &&
      (!query.value || `${c.name} ${c.preview}`.toLowerCase().includes(query.value.toLowerCase())),
  ),
)
</script>
<template>
  <div class="conversation-list">
    <input v-model="query" type="search" placeholder="搜索聊天" aria-label="搜索聊天" />
    <label class="archive-filter"><input v-model="archived" type="checkbox" />显示已归档</label>
    <button
      v-for="c in rows"
      :key="c.id"
      class="conversation-row"
      :class="{ selected: c.id === selected }"
      @click="$emit('select', c.id)"
    >
      <AgentAvatar
        :name="c.name"
        :avatar="c.avatar"
        :state="c.activeRunId ? 'working' : 'idle'"
        :size="38"
      />
      <span class="row-text"
        ><strong>{{ c.pinned ? '⌖ ' : '' }}{{ c.name }}</strong
        ><small
          >{{ c.kind === 'group' ? `${c.memberIds.length} 位成员 · ` : ''
          }}{{ c.preview || '开始聊天' }}</small
        ></span
      >
      <span v-if="c.lastSeq > c.readSeq" class="unread" aria-label="未读消息" />
    </button>
    <p v-if="!rows.length" class="empty">
      {{ archived ? '没有已归档聊天' : '创建一个 Agent，开始你的第一段聊天。' }}
    </p>
  </div>
</template>
<style scoped>
.conversation-list {
  padding: 8px;
}
.conversation-list > input {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text-primary);
}
.archive-filter {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: var(--text-muted);
  padding: 10px 3px;
}
.conversation-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--text-primary);
  padding: 12px 10px;
  text-align: left;
  cursor: pointer;
}
.conversation-row:hover,
.conversation-row.selected {
  background: var(--surface-soft);
}
.row-text {
  display: grid;
  gap: 5px;
  min-width: 0;
  flex: 1;
}
.row-text strong {
  font-size: 13px;
}
.row-text small {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unread {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent, #507f6c);
}
.empty {
  padding: 24px 12px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
}
</style>

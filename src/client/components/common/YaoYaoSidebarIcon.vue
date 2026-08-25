<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import {
  AddOutline,
  ChatbubbleOutline,
  FolderOutline,
  PeopleOutline,
  SearchOutline,
} from '@vicons/ionicons5'
import { Robot } from '@vicons/tabler'

type SidebarIconName = 'add' | 'bots' | 'chat' | 'folder' | 'people' | 'search'

const props = withDefaults(defineProps<{ name: SidebarIconName; size?: number }>(), { size: 20 })
const component = computed(() => ({
  add: AddOutline,
  bots: Robot,
  chat: ChatbubbleOutline,
  folder: FolderOutline,
  people: PeopleOutline,
  search: SearchOutline,
})[props.name])
</script>

<template>
  <NIcon :component="component" :size="size" aria-hidden="true" />
</template>

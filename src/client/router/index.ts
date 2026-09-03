import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/conversations' },
    { path: '/chat/:sessionId?', name: 'chat', component: () => import('@/views/ChatView.vue') },
    { path: '/conversations/:id?', name: 'conversations', component: () => import('@/views/ConversationsView.vue') },
    { path: '/kanban/:boardSlug?', name: 'kanban', component: () => import('@/views/KanbanView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/FilesView.vue') },
    { path: '/artifacts', redirect: '/chat' },
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

export default router

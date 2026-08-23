import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat/:sessionId?', name: 'chat', component: () => import('@/views/ChatView.vue') },
    { path: '/groups/:roomId?/:topicId?', name: 'groups', component: () => import('@/views/GroupsView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/FilesView.vue') },
    { path: '/artifacts', redirect: '/chat' },
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

export default router

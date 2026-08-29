import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { GroupRoomDetail, GroupRoomSummary, GroupTopicSummary } from '@shared/types'

const api = vi.hoisted(() => ({
  getGroupCapabilities: vi.fn(),
  getGroupMessages: vi.fn(),
  getGroupRoom: vi.fn(),
  getGroupRooms: vi.fn(),
  getGroupTopics: vi.fn(),
  getPinnedGroupTopics: vi.fn(),
}))

vi.mock('@/api/groups', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/groups')>(),
  ...api,
}))

vi.mock('@/api/realtime', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/realtime')>(),
  GroupEventSocket: class {
    async connect(): Promise<void> {}
    close(): void {}
  },
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'groups-selection-test', role: 'user' },
    activeProfile: { name: 'default' },
    status: 'authenticated',
    isAuthenticated: true,
  }),
}))

import { useGroupsStore } from '@/stores/groups'

const room = (id: string, name: string): GroupRoomSummary => ({
  id, name, cwd: '', avatar: '', createdAt: 1, updatedAt: 1, archived: false,
  agentCount: 0, lastMessage: null, unreadCount: 0, maxReplyRounds: 3,
})

const detail = (summary: GroupRoomSummary): GroupRoomDetail => ({
  ...summary, agents: [], runs: [], pendingInteractions: [], latestCursor: 0,
})

const topic = (id: string, roomId: string): GroupTopicSummary => ({
  id, roomId, title: id, preview: '', messageCount: 0, createdAt: 1, updatedAt: 1,
})

describe('groups selection state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('publishes the target topic with its room instead of retaining the previous room topic', async () => {
    const roomA = room('room-a', '团队 A')
    const roomB = room('room-b', '团队 B')
    const topicA = topic('topic-a', roomA.id)
    const topicB = topic('topic-b', roomB.id)
    let resolveRoomB!: (value: GroupRoomDetail) => void
    const roomBRequest = new Promise<GroupRoomDetail>(resolve => { resolveRoomB = resolve })

    api.getGroupCapabilities.mockResolvedValue({
      protocolVersion: 12,
      journalEpoch: '11111111-1111-4111-8111-111111111111',
      latestCursor: 0,
      limits: {},
      eventTypes: [],
      features: [],
    })
    api.getGroupRooms.mockResolvedValue({ items: [roomA, roomB], nextCursor: null })
    api.getPinnedGroupTopics.mockResolvedValue({ items: [] })
    api.getGroupRoom.mockImplementation((roomId: string) => roomId === roomA.id ? Promise.resolve(detail(roomA)) : roomBRequest)
    api.getGroupTopics.mockImplementation((roomId: string) => Promise.resolve({ items: roomId === roomA.id ? [topicA] : [topicB], nextCursor: null }))
    api.getGroupMessages.mockResolvedValue({ items: [] })

    const groups = useGroupsStore()
    await groups.start()
    expect(groups.selectedRoomId).toBe(roomA.id)
    expect(groups.selectedTopicId).toBe(topicA.id)

    await groups.loadRoomTopics(roomB.id)
    const selection = groups.selectRoom(roomB.id, topicB.id)

    expect(groups.selectedRoomId).toBe(roomB.id)
    expect(groups.selectedTopicId).toBe(topicB.id)
    expect(groups.selectedTopic?.id).toBe(topicB.id)

    resolveRoomB(detail(roomB))
    await selection
    expect(groups.selectedRoomId).toBe(roomB.id)
    expect(groups.selectedTopicId).toBe(topicB.id)
    groups.stop()
  })
})

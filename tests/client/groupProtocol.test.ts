import { describe, expect, it } from 'vitest'
import type { GroupMessage, GroupSocketEnvelope } from '@shared/types'
import {
  applyGroupEnvelope, classifyGroupEnvelope, type GroupProtocolState, upsertGroupMessage,
} from '@/utils/groupProtocol'

const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function groupMessage(
  id: string,
  clientMessageId: string,
  content: string,
  status: GroupMessage['status'],
  topicId: string | null = null,
): GroupMessage {
  return {
    seq: status === 'queued' ? 0 : 1, id, roomId: 'room-1', topicId, senderKind: 'human', senderId: 'me', senderName: '我',
    rootMessageId: id, clientMessageId, content, reasoning: '', toolState: [], status, error: '', createdAt: 1, updatedAt: 1,
  }
}

function initial(): GroupProtocolState {
  return {
    epoch, cursor: 8,
    rooms: [{ id: 'room-1', name: '群聊', cwd: '', createdAt: 1, updatedAt: 1, archived: false, agentCount: 1, unreadCount: 0, maxReplyRounds: 3 }],
    roomDetails: {}, topicsByRoom: { 'room-1': [] }, messagesByRoom: { 'room-1': [] }, messagesByTopic: {},
  }
}

describe('group protocol continuity', () => {
  it('accepts only exact ready and next cursor, ignoring duplicates', () => {
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.ready', epoch, cursor: 8 })).toBe('ready')
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.event', epoch, cursor: 8 })).toBe('ignore')
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.event', epoch, cursor: 9 })).toBe('apply')
  })

  it('requires reset for gaps, epoch changes, and server reset', () => {
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.event', epoch, cursor: 10 })).toBe('reset')
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.event', epoch: 'other', cursor: 9 })).toBe('reset')
    expect(classifyGroupEnvelope(epoch, 8, { type: 'group.reset_required', epoch, cursor: 8 })).toBe('reset')
  })

  it('reconciles optimistic group messages by clientMessageId', () => {
    const optimistic = groupMessage('local', 'client-1', 'hello', 'queued')
    const server = groupMessage('server', 'client-1', 'hello', 'completed')
    const merged = upsertGroupMessage([optimistic], server)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'server', status: 'completed' })
  })

  it('applies message events to their own room and advances the cursor', () => {
    const payload = groupMessage('server', 'client-1', 'answer', 'completed')
    const envelope: GroupSocketEnvelope = {
      type: 'group.event', epoch, cursor: 9, roomId: 'room-1', event: 'message.upsert', payload: payload as never,
    }
    const reduced = applyGroupEnvelope(initial(), envelope)
    expect(reduced.cursor).toBe(9)
    expect(reduced.messagesByRoom['room-1']).toHaveLength(1)
    expect(reduced.rooms[0].lastMessage?.id).toBe('server')
  })

  it('upserts topic.updated events in most-recently-active order', () => {
    const state = initial()
    state.topicsByRoom['room-1'] = [
      { id: 'topic-1', roomId: 'room-1', title: '旧标题', preview: '旧内容', messageCount: 1, createdAt: 1, updatedAt: 2 },
      { id: 'topic-2', roomId: 'room-1', title: '另一话题', preview: '另一内容', messageCount: 1, createdAt: 1, updatedAt: 4 },
    ]
    const envelope: GroupSocketEnvelope = {
      type: 'group.event', epoch, cursor: 9, roomId: 'room-1', event: 'topic.updated',
      payload: {
        id: 'topic-1', roomId: 'room-1', title: '新标题', preview: '最新内容',
        messageCount: 2, createdAt: 1, updatedAt: 5,
      },
    }

    const reduced = applyGroupEnvelope(state, envelope)

    expect(reduced.topicsByRoom['room-1']).toHaveLength(2)
    expect(reduced.topicsByRoom['room-1'].map(topic => topic.id)).toEqual(['topic-1', 'topic-2'])
    expect(reduced.topicsByRoom['room-1'][0]).toMatchObject({
      title: '新标题', preview: '最新内容', messageCount: 2, updatedAt: 5,
    })
  })

  it('routes v4 message events to their topic without polluting legacy room history', () => {
    const payload = groupMessage('server-topic', 'client-topic', '话题回复', 'completed', 'topic-1')
    const envelope: GroupSocketEnvelope = {
      type: 'group.event', epoch, cursor: 9, roomId: 'room-1', event: 'message.upsert', payload: payload as never,
    }

    const reduced = applyGroupEnvelope(initial(), envelope)

    expect(reduced.messagesByTopic['topic-1']).toEqual([expect.objectContaining({ id: 'server-topic', topicId: 'topic-1' })])
    expect(reduced.messagesByRoom['room-1']).toEqual([])
  })
})

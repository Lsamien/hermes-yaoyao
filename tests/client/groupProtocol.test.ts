import { describe, expect, it } from 'vitest'
import type { GroupMessage, GroupSocketEnvelope } from '@shared/types'
import {
  applyGroupEnvelope, classifyGroupEnvelope, type GroupProtocolState, upsertGroupMessage,
} from '@/utils/groupProtocol'

const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function groupMessage(id: string, clientMessageId: string, content: string, status: GroupMessage['status']): GroupMessage {
  return {
    seq: status === 'queued' ? 0 : 1, id, roomId: 'room-1', senderKind: 'human', senderId: 'me', senderName: '我',
    rootMessageId: id, clientMessageId, content, reasoning: '', toolState: [], status, error: '', createdAt: 1, updatedAt: 1,
  }
}

function initial(): GroupProtocolState {
  return {
    epoch, cursor: 8,
    rooms: [{ id: 'room-1', name: '群聊', cwd: '', createdAt: 1, updatedAt: 1, archived: false, agentCount: 1, unreadCount: 0, maxReplyRounds: 3 }],
    roomDetails: {}, messagesByRoom: { 'room-1': [] },
  }
}

describe('group protocol v2 continuity', () => {
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
})

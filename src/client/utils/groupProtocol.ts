import type {
  GroupAgent, GroupInteraction, GroupMessage, GroupRoomDetail, GroupRoomSummary, GroupSocketEnvelope, JsonValue,
} from '@shared/types'
import {
  normalizeGroupAgent, normalizeGroupInteraction, normalizeGroupMessage, normalizeGroupRoom, normalizeGroupRoomDetail, record, string,
} from './normalize'

export interface GroupProtocolState {
  epoch: string
  cursor: number
  rooms: GroupRoomSummary[]
  roomDetails: Record<string, GroupRoomDetail>
  messagesByRoom: Record<string, GroupMessage[]>
}

export type GroupEnvelopeVerdict = 'ready' | 'apply' | 'ignore' | 'heartbeat' | 'reset'

export function classifyGroupEnvelope(epoch: string, cursor: number, envelope: GroupSocketEnvelope): GroupEnvelopeVerdict {
  if (envelope.epoch && envelope.epoch !== epoch) return 'reset'
  if (envelope.type === 'group.reset_required') return 'reset'
  if (envelope.type === 'group.ready') return envelope.cursor === cursor ? 'ready' : 'reset'
  if (envelope.type === 'group.heartbeat') return envelope.cursor == null || envelope.cursor === cursor ? 'heartbeat' : 'reset'
  if (envelope.type !== 'group.event' || envelope.cursor == null || envelope.cursor < 0) return 'reset'
  if (envelope.cursor <= cursor) return 'ignore'
  return envelope.cursor === cursor + 1 ? 'apply' : 'reset'
}

function upsert<T extends { id: string }>(items: T[], incoming: T): T[] {
  const index = items.findIndex(item => item.id === incoming.id)
  if (index < 0) return [...items, incoming]
  const result = [...items]
  result[index] = { ...items[index], ...incoming }
  return result
}

export function upsertGroupMessage(items: GroupMessage[], incoming: GroupMessage): GroupMessage[] {
  const index = items.findIndex(item => item.id === incoming.id
    || Boolean(item.clientMessageId && incoming.clientMessageId && item.clientMessageId === incoming.clientMessageId))
  if (index < 0) return [...items, incoming].sort((a, b) => a.seq - b.seq)
  const result = [...items]
  result[index] = { ...items[index], ...incoming }
  return result.sort((a, b) => a.seq - b.seq)
}

function eventRoomId(envelope: GroupSocketEnvelope): string {
  return envelope.roomId || string(record(envelope.payload).roomId ?? record(envelope.payload).room_id)
}

export function applyGroupEnvelope(state: GroupProtocolState, envelope: GroupSocketEnvelope): GroupProtocolState {
  if (classifyGroupEnvelope(state.epoch, state.cursor, envelope) !== 'apply') return state
  const roomId = eventRoomId(envelope)
  const payload = record(envelope.payload)
  const next: GroupProtocolState = {
    ...state,
    cursor: envelope.cursor!,
    rooms: [...state.rooms],
    roomDetails: { ...state.roomDetails },
    messagesByRoom: { ...state.messagesByRoom },
  }
  switch (envelope.event) {
    case 'room.created':
    case 'room.updated': {
      const room = normalizeGroupRoom(payload)
      if (room.id) next.rooms = upsert(next.rooms, room).sort((a, b) => b.updatedAt - a.updatedAt)
      if (roomId && next.roomDetails[roomId] && envelope.event === 'room.updated') {
        next.roomDetails[roomId] = { ...next.roomDetails[roomId], ...room }
      }
      break
    }
    case 'room.deleted':
      next.rooms = next.rooms.map(room => room.id === roomId ? { ...room, archived: true } : room)
      if (next.roomDetails[roomId]) next.roomDetails[roomId] = { ...next.roomDetails[roomId], archived: true }
      break
    case 'agent.created':
    case 'agent.updated': {
      const agent = normalizeGroupAgent(payload)
      const detail = next.roomDetails[agent.roomId || roomId]
      if (detail) next.roomDetails[detail.id] = { ...detail, agents: upsert(detail.agents, agent) }
      break
    }
    case 'agent.deleted': {
      const agent = normalizeGroupAgent(payload)
      const detail = next.roomDetails[agent.roomId || roomId]
      if (detail) next.roomDetails[detail.id] = { ...detail, agents: detail.agents.filter(item => item.id !== agent.id) }
      break
    }
    case 'agent.status': {
      const agentId = string(payload.agentId ?? payload.agent_id)
      const status = string(payload.status, 'unknown') as GroupAgent['status']
      const detail = next.roomDetails[roomId]
      if (detail) next.roomDetails[roomId] = {
        ...detail,
        agents: detail.agents.map(agent => agent.id === agentId ? { ...agent, status } : agent),
      }
      break
    }
    case 'message.upsert': {
      const message = normalizeGroupMessage(payload)
      if (!message.id || !message.roomId) break
      next.messagesByRoom[message.roomId] = upsertGroupMessage(next.messagesByRoom[message.roomId] ?? [], message)
      next.rooms = next.rooms.map(room => room.id === message.roomId
        ? { ...room, lastMessage: message, updatedAt: Math.max(room.updatedAt, message.updatedAt) }
        : room)
      break
    }
    case 'interaction.requested':
    case 'interaction.resolved': {
      const interaction = normalizeGroupInteraction(payload)
      const detail = next.roomDetails[interaction.roomId || roomId]
      if (!detail) break
      const interactions = upsert(detail.pendingInteractions, interaction)
      next.roomDetails[detail.id] = {
        ...detail,
        pendingInteractions: interactions.filter(item => item.status === 'pending'),
      }
      break
    }
    case 'run.updated': {
      const run = payload as unknown as GroupRoomDetail['runs'][number]
      const detail = next.roomDetails[roomId]
      if (detail && string((run as unknown as Record<string, JsonValue>).id)) {
        next.roomDetails[roomId] = { ...detail, runs: upsert(detail.runs, run) }
      }
      break
    }
  }
  return next
}

export function snapshotGroupRoom(
  state: GroupProtocolState,
  roomValue: unknown,
  messages: GroupMessage[],
): GroupProtocolState {
  const room = normalizeGroupRoomDetail(roomValue)
  return {
    ...state,
    rooms: upsert(state.rooms, normalizeGroupRoom(roomValue)),
    roomDetails: { ...state.roomDetails, [room.id]: room },
    messagesByRoom: { ...state.messagesByRoom, [room.id]: messages },
    cursor: Math.max(state.cursor, room.latestCursor),
  }
}

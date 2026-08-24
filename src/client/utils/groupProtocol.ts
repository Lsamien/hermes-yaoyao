import type {
  GroupAgent, GroupInteraction, GroupMessage, GroupRoomDetail, GroupRoomSummary, GroupSocketEnvelope, GroupTopicSummary,
} from '@shared/types'
import {
  normalizeGroupAgent, normalizeGroupInteraction, normalizeGroupMessage, normalizeGroupRoom, normalizeGroupRoomDetail,
  normalizeGroupRoomActivity, normalizeGroupRun, normalizeGroupTopic, record, string,
} from './normalize'

export interface GroupProtocolState {
  epoch: string
  cursor: number
  rooms: GroupRoomSummary[]
  roomDetails: Record<string, GroupRoomDetail>
  messagesByRoom: Record<string, GroupMessage[]>
  topicsByRoom: Record<string, GroupTopicSummary[]>
  messagesByTopic: Record<string, GroupMessage[]>
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

export function convergeGroupAgents(items: GroupAgent[], incoming: GroupAgent): GroupAgent[] {
  const current = items.find(agent => agent.id === incoming.id)
  if (current && incoming.updatedAt < current.updatedAt) return items
  const converged = incoming.isHost
    ? items.map(agent => agent.id === incoming.id || !agent.isHost ? agent : { ...agent, isHost: false })
    : items
  return upsert(converged, incoming)
}

export function upsertGroupTopic(items: GroupTopicSummary[], incoming: GroupTopicSummary): GroupTopicSummary[] {
  return upsert(items, incoming).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
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
    topicsByRoom: { ...state.topicsByRoom },
    messagesByTopic: { ...state.messagesByTopic },
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
      if (detail) next.roomDetails[detail.id] = { ...detail, agents: convergeGroupAgents(detail.agents, agent) }
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
      if (message.topicId) {
        next.messagesByTopic[message.topicId] = upsertGroupMessage(next.messagesByTopic[message.topicId] ?? [], message)
      } else {
        next.messagesByRoom[message.roomId] = upsertGroupMessage(next.messagesByRoom[message.roomId] ?? [], message)
      }
      next.rooms = next.rooms.map(room => room.id === message.roomId
        ? { ...room, lastMessage: message, updatedAt: Math.max(room.updatedAt, message.updatedAt) }
        : room)
      break
    }
    case 'topic.updated': {
      const topic = normalizeGroupTopic(payload)
      if (!topic.id || !topic.roomId) break
      next.topicsByRoom[topic.roomId] = upsertGroupTopic(next.topicsByRoom[topic.roomId] ?? [], topic)
      break
    }
    case 'room.activity': {
      const activity = normalizeGroupRoomActivity(payload)
      if (!activity.roomId) break
      next.rooms = next.rooms.map(room => room.id === activity.roomId ? {
        ...room,
        activeRunCount: activity.activeRunCount,
        unreadCount: activity.unreadCount,
        lastMessage: activity.lastMessage ?? room.lastMessage,
      } : room)
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
      const run = normalizeGroupRun(payload)
      const detail = next.roomDetails[run.roomId || roomId]
      if (detail && run.id) {
        next.roomDetails[detail.id] = { ...detail, runs: upsert(detail.runs, run) }
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
  options: { topicId?: string; topics?: GroupTopicSummary[] } = {},
): GroupProtocolState {
  const room = normalizeGroupRoomDetail(roomValue)
  const messagesByRoom = options.topicId
    ? state.messagesByRoom
    : { ...state.messagesByRoom, [room.id]: messages }
  const messagesByTopic = options.topicId
    ? { ...state.messagesByTopic, [options.topicId]: messages }
    : state.messagesByTopic
  return {
    ...state,
    rooms: upsert(state.rooms, normalizeGroupRoom(roomValue)),
    roomDetails: { ...state.roomDetails, [room.id]: room },
    messagesByRoom,
    topicsByRoom: options.topics ? { ...state.topicsByRoom, [room.id]: options.topics } : state.topicsByRoom,
    messagesByTopic,
    cursor: Math.max(state.cursor, room.latestCursor),
  }
}

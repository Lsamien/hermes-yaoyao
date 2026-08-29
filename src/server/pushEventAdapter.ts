import { createHash } from 'node:crypto'
import type { UpstreamServiceSession } from './localAuth.js'
import {
  type ChatPushJob,
  type ChatPushObservation,
  type GroupWatchAnchor,
  type GroupWatchReset,
  type PushEventCoordinator,
  type PushNotificationCandidate,
} from './pushEvents.js'
import { PushCoordinator } from './pushCoordinator.js'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(result) ? result : undefined
}

function timestampMilliseconds(value: unknown): number | undefined {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function summary(value: unknown, fallback: string): string {
  const normalized = text(value).replace(/\s+/g, ' ')
  if (!normalized) return fallback
  return Array.from(normalized).length > 180 ? `${Array.from(normalized).slice(0, 179).join('')}…` : normalized
}

function collapseID(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 32)}`
}

function parseResponse(body: Buffer): JsonRecord {
  try { return record(JSON.parse(body.toString('utf8'))) } catch { throw new Error('Hermes returned invalid group reconciliation JSON') }
}

interface ReconciliationSubscription {
  userId: string
  roomId: string
  startedAt: number
  lastMessageSeq?: number
}

/**
 * Adapts the durable push store to the realtime observers. Cursor resets first
 * reconcile every active room from REST, then move to the server-provided
 * latest anchor. Existing processed event IDs make the replay idempotent.
 */
export class PushCoordinatorEventAdapter implements PushEventCoordinator {
  constructor(
    readonly push: PushCoordinator,
    readonly upstreamSession: UpstreamServiceSession,
  ) {}

  observeChat(_observation: ChatPushObservation): void {}
  saveChatJob(job: ChatPushJob): void {
    if (this.push.isAnyProviderEnabled()) this.push.saveChatJob(job)
  }
  completeChatJob(jobID: string): void { this.push.completeChatJob(jobID) }
  pendingChatJobs(): readonly ChatPushJob[] {
    return this.push.isAnyProviderEnabled() ? this.push.pendingChatJobs() : []
  }
  promptDigest(localUserID: string, prompt: string): string {
    return this.push.promptDigest(localUserID, prompt)
  }
  canRecoverChatJob(job: ChatPushJob): boolean { return this.push.chatJobRecoveryAllowed(job) }
  enqueueNotification(candidate: PushNotificationCandidate): 'enqueued' | 'duplicate' | 'ignored' {
    if (!this.push.isAnyProviderEnabled()) return 'ignored'
    if ('roomID' in candidate) {
      if (candidate.messageSequence !== undefined) {
        const lastSequence = this.push.groupSubscriptionLastMessageSeq(candidate.localUserID, candidate.roomID)
        if (lastSequence !== undefined && candidate.messageSequence <= lastSequence) return 'ignored'
        const result = this.push.enqueueNotification(candidate)
        this.push.advanceGroupSubscriptionMessageSeq(
          candidate.localUserID,
          candidate.roomID,
          candidate.messageSequence,
        )
        return result
      } else {
        const startedAt = this.push.groupSubscriptionStartedAt(candidate.localUserID, candidate.roomID)
        if (startedAt === undefined || candidate.occurredAt === undefined || candidate.occurredAt + 2_000 < startedAt) {
          return 'ignored'
        }
      }
    }
    return this.push.enqueueNotification(candidate)
  }
  groupWatchAnchor(): GroupWatchAnchor | undefined {
    const anchor = this.push.groupWatchAnchor()
    return anchor ? { epoch: anchor.epoch, cursor: anchor.cursor } : undefined
  }
  groupSubscribers(roomID: string): readonly string[] { return this.push.groupSubscribers(roomID) }
  advanceGroupCursor(anchor: GroupWatchAnchor): void { this.push.advanceGroupCursor(anchor) }

  async resetGroupCursor(reset: GroupWatchReset): Promise<GroupWatchAnchor> {
    if (reset.reason !== 'initial') await this.reconcileGroups()
    const anchor = this.push.resetGroupCursor(reset)
    return { epoch: anchor.epoch, cursor: anchor.cursor }
  }

  async reconcileGroups(): Promise<void> {
    const subscriptions = this.push.activeGroupSubscriptions().flatMap(item => {
      const startedAt = Date.parse(item.updatedAt)
      return Number.isNaN(startedAt) ? [] : [{
        userId: item.userId,
        roomId: item.roomId,
        startedAt,
        ...(item.lastMessageSeq !== undefined ? { lastMessageSeq: item.lastMessageSeq } : {}),
      }]
    })
    const byRoom = new Map<string, ReconciliationSubscription[]>()
    for (const subscription of subscriptions) {
      byRoom.set(subscription.roomId, [...(byRoom.get(subscription.roomId) ?? []), subscription])
    }
    for (const [roomID, roomSubscriptions] of byRoom) {
      await this.reconcileRoom(roomID, roomSubscriptions)
    }
  }

  private async reconcileRoom(roomID: string, subscriptions: ReconciliationSubscription[]): Promise<void> {
    const detailResponse = await this.upstreamSession.request(
      `/api/plugins/yaoyao/v1/rooms/${encodeURIComponent(roomID)}`,
    )
    if (detailResponse.status < 200 || detailResponse.status >= 300) {
      if (detailResponse.status === 404) {
        for (const subscription of subscriptions) {
          this.push.setGroupSubscription(subscription.userId, roomID, false)
        }
        return
      }
      throw new Error(`Unable to reconcile group ${roomID} (${detailResponse.status})`)
    }
    const detailPayload = parseResponse(detailResponse.body)
    const detailData = record(detailPayload.data)
    const room = record(detailPayload.room ?? detailData.room ?? detailPayload.data ?? detailPayload)
    const roomName = text(room.name) || '团队'
    await this.reconcileMessages(roomID, roomName, subscriptions)
    await this.reconcileInteractions(roomID, roomName, subscriptions, room)
  }

  private async reconcileMessages(
    roomID: string,
    roomName: string,
    subscriptions: ReconciliationSubscription[],
  ): Promise<void> {
    if (subscriptions.some(item => item.lastMessageSeq === undefined)) {
      const baselineResponse = await this.upstreamSession.request(
        `/api/plugins/yaoyao/v1/rooms/${encodeURIComponent(roomID)}/messages`,
        { search: new URLSearchParams({ limit: '1' }) },
      )
      if (baselineResponse.status < 200 || baselineResponse.status >= 300) {
        throw new Error(`Unable to establish group baseline for ${roomID} (${baselineResponse.status})`)
      }
      const baselinePayload = parseResponse(baselineResponse.body)
      const baselineData = record(baselinePayload.data)
      const baseline = values(
        baselinePayload.items ?? baselinePayload.messages ?? baselineData.items ?? baselineData.messages,
      ).map(record).reduce((maximum, message) => {
        const sequence = number(message.seq ?? message.sequence)
        return sequence !== undefined && Number.isSafeInteger(sequence) ? Math.max(maximum, sequence) : maximum
      }, 0)
      for (const subscription of subscriptions) {
        if (subscription.lastMessageSeq !== undefined) continue
        this.push.advanceGroupSubscriptionMessageSeq(subscription.userId, roomID, baseline)
        subscription.lastMessageSeq = baseline
      }
    }
    let afterSequence = Math.min(...subscriptions.map(item => item.lastMessageSeq ?? 0))
    if (afterSequence === 0) {
      const collected: JsonRecord[] = []
      let beforeSequence: number | undefined
      let complete = false
      for (let page = 0; page < 200; page += 1) {
        const search = new URLSearchParams({ limit: '100' })
        if (beforeSequence !== undefined) search.set('beforeSeq', String(beforeSequence))
        const messages = await this.fetchGroupMessages(roomID, search)
        if (!messages.length) { complete = true; break }
        collected.push(...messages)
        const sequences = messages
          .map(message => number(message.seq ?? message.sequence))
          .filter((value): value is number => value !== undefined && Number.isSafeInteger(value))
        if (messages.length < 100 || !sequences.length) { complete = true; break }
        const nextBefore = Math.min(...sequences)
        if (beforeSequence !== undefined && nextBefore >= beforeSequence) break
        beforeSequence = nextBefore
      }
      if (!complete) throw new Error(`Group reconciliation exceeded the safe page limit for ${roomID}`)
      const ordered = [...new Map(collected.map(message => [String(message.id ?? message.seq), message])).values()]
        .sort((left, right) => Number(left.seq ?? left.sequence) - Number(right.seq ?? right.sequence))
      this.processGroupMessages(roomID, roomName, subscriptions, ordered, 0)
      return
    }
    for (let page = 0; page < 50; page += 1) {
      const search = new URLSearchParams({ limit: '100' })
      search.set('afterSeq', String(afterSequence))
      const messages = await this.fetchGroupMessages(roomID, search)
      if (!messages.length) return
      const greatestSequence = this.processGroupMessages(
        roomID, roomName, subscriptions, messages, afterSequence,
      )
      if (messages.length < 100 || greatestSequence <= afterSequence) return
      afterSequence = greatestSequence
    }
    throw new Error(`Group reconciliation exceeded the safe page limit for ${roomID}`)
  }

  private async fetchGroupMessages(roomID: string, search: URLSearchParams): Promise<JsonRecord[]> {
    const response = await this.upstreamSession.request(
      `/api/plugins/yaoyao/v1/rooms/${encodeURIComponent(roomID)}/messages`,
      { search },
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Unable to reconcile group messages for ${roomID} (${response.status})`)
    }
    const payload = parseResponse(response.body)
    const data = record(payload.data)
    return values(payload.items ?? payload.messages ?? data.items ?? data.messages).map(record)
  }

  private processGroupMessages(
    roomID: string,
    roomName: string,
    subscriptions: ReconciliationSubscription[],
    messages: JsonRecord[],
    afterSequence: number,
  ): number {
    let greatestSequence = afterSequence
    for (const message of messages) {
      const sequence = number(message.seq ?? message.sequence)
      const updatedAt = timestampMilliseconds(message.updatedAt ?? message.updated_at ?? message.createdAt ?? message.created_at)
      if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence <= afterSequence) continue
      greatestSequence = Math.max(greatestSequence, sequence)
      const senderKind = text(message.senderKind ?? message.sender_kind).toLowerCase()
      const status = text(message.status).toLowerCase()
      const messageID = text(message.id)
      if (senderKind !== 'agent' || !messageID || (status !== 'completed' && status !== 'failed')) continue
      for (const subscription of subscriptions) {
        if (sequence <= (subscription.lastMessageSeq ?? 0)) continue
        const kind = status === 'completed' ? 'group.message.completed' as const : 'group.message.failed' as const
        const eventID = `group-message:${messageID}:${status}`
        const sender = text(message.senderName ?? message.sender_name) || 'Agent'
        const topicID = text(message.topicId ?? message.topic_id)
        this.enqueueNotification({
          eventID,
          localUserID: subscription.userId,
          kind,
          title: `${roomName} · ${sender}`,
          body: summary(message.error ?? message.content, status === 'completed' ? '打开夭夭查看团队消息' : '打开夭夭查看失败详情'),
          collapseID: collapseID('group-message', messageID),
          roomID,
          messageSequence: sequence,
          occurredAt: updatedAt,
          ...(topicID ? { topicID } : {}),
          data: {
            version: '1', eventId: eventID, kind, roomId: roomID,
            ...(topicID ? { topicId: topicID } : {}), messageId: messageID,
          },
        })
      }
    }
    return greatestSequence
  }

  private async reconcileInteractions(
    roomID: string,
    roomName: string,
    subscriptions: ReconciliationSubscription[],
    room: JsonRecord,
  ): Promise<void> {
    const interactions = values(room.pendingInteractions ?? room.pending_interactions)
      .map(record)
    for (const interaction of interactions) {
      const status = text(interaction.status).toLowerCase()
      const interactionID = text(interaction.id)
      const updatedAt = timestampMilliseconds(
        interaction.updatedAt ?? interaction.updated_at ?? interaction.createdAt ?? interaction.created_at,
      )
      if (!interactionID || status && status !== 'pending' || updatedAt === undefined) continue
      const interactionKind = text(interaction.kind).toLowerCase()
      const clarification = interactionKind === 'clarification'
      const payload = record(interaction.payload)
      const topicID = text(interaction.topicId ?? interaction.topic_id)
      const eventID = `group-interaction:${interactionID}`
      for (const subscription of subscriptions) {
        if (updatedAt + 2_000 < subscription.startedAt) continue
        this.push.enqueueNotification({
          eventID,
          localUserID: subscription.userId,
          kind: 'group.interaction.requested',
          title: clarification ? `${roomName} · 需要补充信息` : `${roomName} · 请求审批`,
          body: summary(payload.question ?? payload.message ?? payload.prompt, '请打开夭夭继续处理'),
          collapseID: collapseID('group-interaction', interactionID),
          roomID,
          ...(topicID ? { topicID } : {}),
          data: {
            version: '1', eventId: eventID, kind: 'group.interaction.requested', roomId: roomID,
            ...(topicID ? { topicId: topicID } : {}), interactionId: interactionID,
          },
        })
      }
    }
  }
}

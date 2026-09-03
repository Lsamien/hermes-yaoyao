import type {
  ChatPushJob,
  ChatPushObservation,
  PushEventCoordinator,
  PushNotificationCandidate,
} from './pushEvents.js'
import { PushCoordinator } from './pushCoordinator.js'

/** Chat notifications and workspace events use Web-owned persistence. */
export class PushCoordinatorEventAdapter implements PushEventCoordinator {
  constructor(readonly push: PushCoordinator) {}
  observeChat(_observation: ChatPushObservation): void {}
  saveChatJob(job: ChatPushJob): void {
    if (this.push.isAnyProviderEnabled()) this.push.saveChatJob(job)
  }
  completeChatJob(jobID: string): void {
    this.push.completeChatJob(jobID)
  }
  pendingChatJobs(): readonly ChatPushJob[] {
    return this.push.isAnyProviderEnabled() ? this.push.pendingChatJobs() : []
  }
  promptDigest(localUserID: string, prompt: string): string {
    return this.push.promptDigest(localUserID, prompt)
  }
  canRecoverChatJob(job: ChatPushJob): boolean {
    return this.push.chatJobRecoveryAllowed(job)
  }
  enqueueNotification(candidate: PushNotificationCandidate): 'enqueued' | 'duplicate' | 'ignored' {
    if (
      'roomID' in candidate &&
      !this.push.isGroupSubscribed(candidate.localUserID, candidate.roomID)
    )
      return 'ignored'
    return this.push.isAnyProviderEnabled() ? this.push.enqueueNotification(candidate) : 'ignored'
  }
}

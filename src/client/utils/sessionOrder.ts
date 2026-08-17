import type { SessionSummary } from '@shared/types'

/** Keeps 9119's relative order inside each partition while honoring a pin. */
export function pinnedSessionsFirst(sessions: SessionSummary[]): SessionSummary[] {
  const pinned: SessionSummary[] = []
  const regular: SessionSummary[] = []
  for (const session of sessions) (session.pinned ? pinned : regular).push(session)
  return [...pinned, ...regular]
}

export function appendSessionPage(existing: SessionSummary[], next: SessionSummary[]): SessionSummary[] {
  const seen = new Set(existing.map(session => `${session.profile}\u0000${session.id}`))
  return pinnedSessionsFirst([...existing, ...next.filter(session => {
    const key = `${session.profile}\u0000${session.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })])
}

export const ORPHAN_PART_TTL_MS = 10 * 60 * 1_000
export const ORPHAN_PART_LIMIT = 4_096
export const ORPHAN_PART_LIMIT_PER_SESSION = 512

export type OrphanStore = Map<string, Map<string, number>>

export function evictForInsert(
  store: OrphanStore,
  sessionID: string,
  messageID: string,
  now: number,
): void {
  const session = store.get(sessionID) ?? new Map<string, number>()
  session.set(messageID, now)
  store.set(sessionID, session)
  while (session.size > ORPHAN_PART_LIMIT_PER_SESSION) {
    const oldest = [...session.entries()].sort((a, b) => a[1] - b[1])[0]
    if (!oldest) break
    session.delete(oldest[0])
  }
  let total = 0
  for (const parts of store.values()) total += parts.size
  while (total > ORPHAN_PART_LIMIT) {
    let victim: { sessionID: string; messageID: string; created: number } | undefined
    for (const [id, parts] of store) {
      for (const [message, created] of parts) {
        if (!victim || created < victim.created) victim = { sessionID: id, messageID: message, created }
      }
    }
    if (!victim) break
    store.get(victim.sessionID)?.delete(victim.messageID)
    total -= 1
  }
}

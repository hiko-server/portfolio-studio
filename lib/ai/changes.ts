import { getAiDb } from './db'

/**
 * AI changes (SERVER-ONLY, design §3.2 `ai_changes`, §5.3): every AI write,
 * as a row in ai.db with a state.
 *
 * Here so far: the withdrawal of what is still open when access ends. A
 * change is "open" while it waits for the owner (`waiting`) or sits in an
 * editor (`in_editor`); once the app that asked loses access, or AI access is
 * turned off, nothing it asked for may still be applied, so those rows
 * become `voided` with the reason in `error_code`:
 *
 *   ACCESS_OFF      AI access was turned off (§5.2)
 *   ISSUER_ENDED    the connected app was revoked, or the browser that made
 *                   it was signed out (§5.4)
 *
 * The approve route checks the issuer again in any case (§5.3 step 4), so a
 * row this could not reach (ai.db unreadable at that moment) still cannot be
 * applied.
 */

export type VoidReason = 'ACCESS_OFF' | 'ISSUER_ENDED'

const OPEN_STATES = ['waiting', 'in_editor'] as const

/**
 * Void every open change — of the given actors (grant ids, or run ids for
 * the assistant), or all of them. Returns how many rows changed.
 */
export function voidOpenChanges(which: { all: true } | { actorIds: readonly string[] }, reason: VoidReason, now = Date.now()): number {
  const states = OPEN_STATES.map(() => '?').join(', ')
  const db = getAiDb()
  if ('all' in which) {
    return db.prepare(`UPDATE ai_changes SET state = 'voided', error_code = ?, decided_at = ? WHERE state IN (${states})`).run(reason, now, ...OPEN_STATES).changes
  }
  const ids = Array.from(new Set(which.actorIds.filter((id) => typeof id === 'string' && id)))
  if (!ids.length) return 0
  return db
    .prepare(`UPDATE ai_changes SET state = 'voided', error_code = ?, decided_at = ? WHERE state IN (${states}) AND actor_id IN (${ids.map(() => '?').join(', ')})`)
    .run(reason, now, ...OPEN_STATES, ...ids).changes
}

/** Changes waiting for the owner's decision (the status strip's count; read-only). */
export function waitingCount(now = Date.now()): number {
  const row = getAiDb()
    .prepare(`SELECT count(*) AS n FROM ai_changes WHERE state = 'waiting' AND (expires_at IS NULL OR expires_at > ?)`)
    .get(now) as { n: number }
  return Number(row.n) || 0
}

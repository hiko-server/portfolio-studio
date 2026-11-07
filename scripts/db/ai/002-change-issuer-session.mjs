import { hasColumn } from '../migrate.mjs'

/**
 * ai.db v2 — the browser session that issued an assistant's change.
 *
 *   ai_changes.issuer_session   for a change the owner's assistant made: the
 *                               signed-in session that started its run. NULL
 *                               for a connected app's (its grant is the
 *                               issuer) and on rows written before v2.
 *
 * An approval refuses a change whose issuer no longer has access (design
 * §5.3 step 4); for the assistant that is the session that started the run.
 * Version 1 could read it only from ai_runs, and a run's row goes with its
 * conversation (deleted by the owner, or by "Don't keep" when the next
 * conversation starts), which left a waiting proposal unapprovable while the
 * session that made it was still signed in. The row now records its issuer
 * itself, as it records the session version (issuer_version).
 * Expand-only: one guarded, nullable column.
 */

/** @type {import('../migrate.mjs').Migration} */
const migration = {
  version: 2,
  name: 'change-issuer-session',
  up(db) {
    if (!hasColumn(db, 'ai_changes', 'issuer_session')) db.exec('ALTER TABLE ai_changes ADD COLUMN issuer_session TEXT')
  },
}

export default migration

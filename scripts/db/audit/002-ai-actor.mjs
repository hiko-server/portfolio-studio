import { hasColumn } from '../migrate.mjs'

/**
 * audit.db v2 — AI actors in the activity log (design §3.3, §5.6). Every
 * column is nullable and empty on the rows of a person's own writes:
 *
 *   actor_kind           'mcp' (a connected app) or 'assistant' (the owner's
 *                        assistant in the admin)
 *   ai_client            the connected app's name as the owner labelled it, or
 *                        its verified host — never the name it reports itself
 *   ai_grant_id          the grant (personal token or OAuth consent) it used
 *   ai_provider, ai_model, ai_run_id   the assistant's provider, model and run
 *   tool                 the tool that made the write
 *   args_sha256          SHA-256 of its canonical arguments (never the
 *                        arguments themselves)
 *   tool_list_hash       the catalogue the model was shown
 *   change_id            the ai_changes row in ai.db
 *   approved_by_session, approved_at   for a proposal the owner approved:
 *                        the browser session that approved it, and when
 *
 * An AI write is recorded BEFORE it runs, as an intent row with status 0,
 * and refused when that row cannot be written; the row then takes the
 * write's status, or is removed when the write was refused before anything
 * changed (lib/ai/audit). Expand-only: guarded column additions and an index.
 */

const COLUMNS = [
  ['actor_kind', 'TEXT'],
  ['ai_client', 'TEXT'],
  ['ai_grant_id', 'TEXT'],
  ['ai_provider', 'TEXT'],
  ['ai_model', 'TEXT'],
  ['ai_run_id', 'TEXT'],
  ['tool', 'TEXT'],
  ['args_sha256', 'TEXT'],
  ['tool_list_hash', 'TEXT'],
  ['change_id', 'TEXT'],
  ['approved_by_session', 'TEXT'],
  ['approved_at', 'INTEGER'],
]

/** @type {import('../migrate.mjs').Migration} */
const migration = {
  version: 2,
  name: 'ai-actor',
  up(db) {
    for (const [name, type] of COLUMNS) {
      if (!hasColumn(db, 'audit_log', name)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${name} ${type}`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit_log (actor_kind, ts DESC)')
  },
}

export default migration

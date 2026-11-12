/**
 * ai.db v3 — files the owner gives the assistant (images, PDFs, text files,
 * audio clips).
 *
 *   ai_media   one row per file, its bytes inline (BLOB). A file is uploaded
 *              first (conversation_id NULL: pending, bound to the browser
 *              session that sent it) and claimed by the message that carries
 *              it; from then on it belongs to that conversation and goes
 *              with it (ON DELETE CASCADE: deleting the conversation, or the
 *              retention prune, deletes its files). Pending files nobody
 *              claimed are deleted after a day (lib/ai/media).
 *
 * The stored native turns never copy these bytes: they carry a placeholder
 * the agent loop fills in just before each model call, so the history stays
 * small and byte-identical from call to call. Expand-only: a new table.
 */

/** @type {import('../migrate.mjs').Migration} */
const migration = {
  version: 3,
  name: 'media',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_media (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES ai_conversations (id) ON DELETE CASCADE,
        session_id      TEXT,
        kind            TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'audio')),
        mime            TEXT NOT NULL,
        name            TEXT NOT NULL,
        bytes           BLOB NOT NULL,
        size            INTEGER NOT NULL,
        sha256          TEXT NOT NULL,
        width           INTEGER,
        height          INTEGER,
        pages           INTEGER,
        duration_ms     INTEGER,
        chars           INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_media_conv ON ai_media (conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_media_pending ON ai_media (created_at) WHERE conversation_id IS NULL;
    `)
  },
}

export default migration

/**
 * ai.db v1 — the AI feature's bulk data (design §3.2): conversations with
 * the owner's assistant, model usage, the log of tool calls and refusals,
 * the per-grant daily roll-up, every AI write ("changes": applied drafts,
 * proposals waiting for the owner, editor suggestions) and the budget
 * counters that must survive a restart.
 *
 *   ai_conversations  one assistant conversation: the provider, model and the
 *                     frozen system text and tool list it was started with
 *   ai_turns          its turns in order; native_json is the provider's own
 *                     shape (only its adapter reads it), display_json what
 *                     the admin renders
 *   ai_runs           one server-side run of the assistant loop
 *   ai_usage          one row per model call (tokens as reported, or
 *                     estimated and marked so)
 *   ai_tool_calls     every tool call and every refusal, reads included —
 *                     never in audit_log; slugs and page names only, never
 *                     bodies or addresses; 30 days
 *   ai_grant_daily    per grant, day and country: calls, writes, refusals and
 *                     argument bytes, kept beyond the call log (tokens can
 *                     live 365 days)
 *   ai_changes        every AI write and its state; what an approval executes
 *                     (args_json), the preview the owner saw (preview_gz,
 *                     hashed), the complete state before it (before_gz)
 *   ai_counters       persisted budget windows (lib/ai/budgets)
 *
 * A store of its own (data/ai.db, owner-only, secure_delete on): a chat log
 * that grows, breaks or fills the disk can never touch sign-in, and none of
 * it is ever packed into a content snapshot, mirrored to R2 or replaced by a
 * restore. Retention is applied on write (lib/ai), no background job.
 */

/** @type {import('../migrate.mjs').Migration} */
const migration = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        provider_id     TEXT NOT NULL,
        provider_label  TEXT NOT NULL,
        wire            TEXT NOT NULL,
        model           TEXT NOT NULL,
        effort          TEXT,
        system_text     TEXT NOT NULL,
        tools_json      TEXT NOT NULL,
        tool_list_hash  TEXT NOT NULL,
        tokens_weighted INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_conv_updated ON ai_conversations (updated_at DESC);

      CREATE TABLE IF NOT EXISTS ai_turns (
        conversation_id TEXT NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        native_json     TEXT NOT NULL,
        display_json    TEXT NOT NULL,
        run_id          TEXT,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );

      CREATE TABLE IF NOT EXISTS ai_runs (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('running', 'finished', 'stopped', 'limit', 'failed', 'interrupted')),
        reason          TEXT,
        model_turns     INTEGER NOT NULL DEFAULT 0,
        tool_calls      INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER
      );

      CREATE TABLE IF NOT EXISTS ai_usage (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        day                TEXT NOT NULL,
        provider_id        TEXT NOT NULL,
        model              TEXT NOT NULL,
        conversation_id    TEXT,
        run_id             TEXT,
        usage_in           INTEGER NOT NULL DEFAULT 0,
        cached_read        INTEGER NOT NULL DEFAULT 0,
        cache_write        INTEGER NOT NULL DEFAULT 0,
        usage_out          INTEGER NOT NULL DEFAULT 0,
        reasoning          INTEGER NOT NULL DEFAULT 0,
        weighted           INTEGER NOT NULL DEFAULT 0,
        reported_micro_usd INTEGER,
        estimated          INTEGER NOT NULL DEFAULT 0,
        at                 INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage (day, provider_id, model);

      CREATE TABLE IF NOT EXISTS ai_tool_calls (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('mcp', 'assistant')),
        actor_id    TEXT NOT NULL,
        actor_label TEXT NOT NULL,
        tool        TEXT NOT NULL,
        target      TEXT,
        risk        TEXT NOT NULL,
        outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'refused')),
        code        TEXT,
        ms          INTEGER NOT NULL,
        bytes_out   INTEGER NOT NULL DEFAULT 0,
        args_sha256 TEXT NOT NULL,
        ip_prefix   TEXT,
        country     TEXT,
        era         TEXT,
        request_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_calls_at ON ai_tool_calls (at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_calls_actor ON ai_tool_calls (actor_id, at DESC);

      CREATE TABLE IF NOT EXISTS ai_grant_daily (
        grant_id TEXT NOT NULL,
        day      TEXT NOT NULL,
        country  TEXT NOT NULL DEFAULT '',
        calls    INTEGER NOT NULL DEFAULT 0,
        writes   INTEGER NOT NULL DEFAULT 0,
        refused  INTEGER NOT NULL DEFAULT 0,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (grant_id, day, country)
      );

      CREATE TABLE IF NOT EXISTS ai_changes (
        id              TEXT PRIMARY KEY,
        state           TEXT NOT NULL CHECK (state IN
                          ('waiting', 'applying', 'applied', 'rejected', 'expired', 'conflict', 'failed', 'undone', 'voided', 'in_editor')),
        risk            TEXT NOT NULL CHECK (risk IN ('draft', 'live', 'destructive')),
        tool            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        actor_kind      TEXT NOT NULL,
        actor_id        TEXT NOT NULL,
        actor_label     TEXT NOT NULL,
        issuer_version  INTEGER NOT NULL,
        provider        TEXT,
        model           TEXT,
        conversation_id TEXT,
        target_kind     TEXT NOT NULL,
        target_ref      TEXT NOT NULL,
        title           TEXT NOT NULL,
        base_version    TEXT,
        args_json       TEXT,
        args_sha256     TEXT NOT NULL,
        preview_gz      BLOB,
        preview_sha256  TEXT NOT NULL,
        before_gz       BLOB,
        rationale       TEXT,
        reject_note     TEXT,
        result_json     TEXT,
        error_code      TEXT,
        decided_session TEXT,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER,
        decided_at      INTEGER,
        applied_at      INTEGER,
        undone_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ai_changes_state ON ai_changes (state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_changes_target ON ai_changes (target_kind, target_ref, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_changes_actor ON ai_changes (actor_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_counters (
        key          TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        n            INTEGER NOT NULL,
        PRIMARY KEY (key, window_start)
      );
    `)
  },
}

export default migration

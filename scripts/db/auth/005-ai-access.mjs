/**
 * auth.db v5 — AI access: the switches, connected apps (personal tokens and
 * OAuth grants), single-use authorization codes and the owner's provider keys
 * (design §3.1).
 *
 *   ai_settings       one row (id = 1): the master switch `enabled`, "Allow
 *                     connected apps" `mcp_enabled`, "Save drafts without
 *                     asking", conversation retention, the daily token
 *                     limit and the pairing window an OAuth connection
 *                     needs. Off by default; the row exists from the start.
 *   ai_grants         one connected app: a personal token or one OAuth
 *                     consent. Bound to the session version it was minted
 *                     under and to the browser session that minted it.
 *   ai_tokens         SHA-256 of each token (the token is shown once and
 *                     never stored), its kind and last four characters.
 *   ai_oauth_codes    SHA-256 of each authorization code, single use
 *                     (`used_at`), with the PKCE challenge and what it issued.
 *   ai_provider_keys  the owner's model providers: the API key sealed with
 *                     AES-256-GCM (lib/ai/secretBox: ciphertext || tag and
 *                     the nonce), bound to its row id, preset and base URL.
 *
 * In auth.db, not content.db or ai.db, for the reason the sessions are: auth.db
 * is never packed into a content snapshot, mirrored to R2 or replaced by a
 * restore, so restoring an older backup can never re-enable AI access or bring
 * a revoked token back to life. Expand-only: new tables and one row.
 */

/** @type {import('../migrate.mjs').Migration} */
const migration = {
  version: 5,
  name: 'ai-access',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        enabled                 INTEGER NOT NULL DEFAULT 0,
        mcp_enabled             INTEGER NOT NULL DEFAULT 0,
        auto_apply_drafts       INTEGER NOT NULL DEFAULT 1,
        default_provider_id     TEXT,
        keep_conversations_days INTEGER NOT NULL DEFAULT 90,
        daily_token_limit       INTEGER NOT NULL DEFAULT 2000000,
        pairing_id              TEXT,
        pairing_app             TEXT,
        pairing_opened_at       INTEGER,
        pairing_expires_at      INTEGER,
        changed_at              INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO ai_settings (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS ai_grants (
        id                         TEXT PRIMARY KEY,
        kind                       TEXT NOT NULL CHECK (kind IN ('pat', 'oauth')),
        name                       TEXT NOT NULL,
        client_id                  TEXT,
        redirect_host              TEXT,
        scopes                     TEXT NOT NULL,
        resource                   TEXT NOT NULL,
        session_version            INTEGER NOT NULL,
        created_session            TEXT,
        created_device             TEXT,
        client_reported            TEXT,
        client_reported_changed_at INTEGER,
        created_at                 INTEGER NOT NULL,
        expires_at                 INTEGER NOT NULL,
        first_used_at              INTEGER,
        last_used_at               INTEGER,
        last_ip_prefix             TEXT,
        last_country               TEXT,
        revoked_at                 INTEGER,
        revoke_reason              TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_grants_created ON ai_grants (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_grants_session ON ai_grants (created_session);

      CREATE TABLE IF NOT EXISTS ai_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id   TEXT NOT NULL REFERENCES ai_grants (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('pat', 'access', 'refresh')),
        hint       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ai_tokens_grant ON ai_tokens (grant_id);

      CREATE TABLE IF NOT EXISTS ai_oauth_codes (
        code_hash       TEXT PRIMARY KEY,
        client_id       TEXT NOT NULL,
        redirect_uri    TEXT NOT NULL,
        code_challenge  TEXT NOT NULL,
        scopes          TEXT NOT NULL,
        resource        TEXT NOT NULL,
        session_version INTEGER NOT NULL,
        created_session TEXT,
        expires_at      INTEGER NOT NULL,
        used_at         INTEGER,
        grant_id        TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_provider_keys (
        id            TEXT PRIMARY KEY,
        preset        TEXT NOT NULL,
        label         TEXT NOT NULL,
        wire          TEXT NOT NULL CHECK (wire IN ('anthropic', 'responses', 'chat')),
        base_url      TEXT NOT NULL,
        default_model TEXT,
        effort        TEXT,
        quirks_json   TEXT NOT NULL DEFAULT '{}',
        key_cipher    BLOB,
        key_nonce     BLOB,
        key_kid       INTEGER NOT NULL DEFAULT 1,
        key_hint      TEXT,
        test_json     TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_used_at  INTEGER
      );
    `)
  },
}

export default migration

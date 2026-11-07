/**
 * F1 stores (design §3): the auth.db v5, ai.db v1 (+ v2, the issuer session of a change) and audit.db v2
 * migrations; data/ai.db opened like auth.db (owner-only file and sidecars,
 * secure_delete, foreign keys, migrated on open); the operator CLI and the
 * System snapshot know the new store.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { currentVersion, hasColumn, runMigrations, validateMigrations } from '../scripts/db/migrate.mjs'
import { AI_MIGRATIONS } from '../scripts/db/ai/index.mjs'
import { AUTH_MIGRATIONS } from '../scripts/db/auth/index.mjs'
import { AUDIT_MIGRATIONS } from '../scripts/db/audit/index.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const prevCwd = process.cwd()
let tmp = ''

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-stores-'))
  process.chdir(tmp)
})
after(async () => {
  const { closeAiDb } = await import('../lib/ai/db')
  closeAiDb()
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
const indexes = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  )
const modeOf = (p: string) => fs.statSync(p).mode & 0o777
const sidecars = (file: string) => [file, `${file}-wal`, `${file}-shm`]

function withUmask<T>(fn: () => T): T {
  const prev = process.umask(0o022)
  try {
    return fn()
  } finally {
    process.umask(prev)
  }
}

test('the three lists are well formed and the new versions are appended, never renumbered', () => {
  for (const list of [AI_MIGRATIONS, AUTH_MIGRATIONS, AUDIT_MIGRATIONS]) validateMigrations(list)
  assert.deepEqual(
    AUTH_MIGRATIONS.map((m) => `${m.version}-${m.name}`),
    ['1-passkeys-sessions', '2-failure-counts', '3-review-links', '4-cv-share-links', '5-ai-access'],
  )
  assert.deepEqual(AUDIT_MIGRATIONS.map((m) => `${m.version}-${m.name}`), ['1-baseline', '2-ai-actor'])
  assert.deepEqual(AI_MIGRATIONS.map((m) => `${m.version}-${m.name}`), ['1-baseline', '2-change-issuer-session'])
})

test('auth.db v5: the AI tables, and one settings row that starts with everything off', () => {
  const db = new Database(':memory:')
  try {
    runMigrations(db, AUTH_MIGRATIONS, { label: 'auth' })
    assert.equal(currentVersion(db), 5)
    for (const t of ['ai_settings', 'ai_grants', 'ai_tokens', 'ai_oauth_codes', 'ai_provider_keys']) assert.ok(tables(db).includes(t), t)
    // No table for clients or authorize requests: /oauth/authorize and /oauth/register store nothing (§6.4).
    assert.deepEqual(tables(db).filter((t) => /client|request/.test(t)), [])
    const row = db.prepare('SELECT * FROM ai_settings').all() as Array<Record<string, unknown>>
    assert.equal(row.length, 1)
    assert.deepEqual(
      { ...row[0] },
      {
        id: 1,
        enabled: 0,
        mcp_enabled: 0,
        auto_apply_drafts: 1,
        default_provider_id: null,
        keep_conversations_days: 90,
        daily_token_limit: 2_000_000,
        pairing_id: null,
        pairing_app: null,
        pairing_opened_at: null,
        pairing_expires_at: null,
        changed_at: 0,
      },
    )
    // A second settings row is impossible, and replaying the migration keeps the first one as it is.
    assert.throws(() => db.prepare('INSERT INTO ai_settings (id) VALUES (2)').run(), /CHECK constraint/)
    db.prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
    db.exec('BEGIN')
    AUTH_MIGRATIONS[4].up(db)
    db.exec('COMMIT')
    assert.equal((db.prepare('SELECT enabled FROM ai_settings').get() as { enabled: number }).enabled, 1)
    // Kinds and wires are closed sets.
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO ai_grants (id, kind, name, scopes, resource, session_version, created_at, expires_at) VALUES ('g1', 'admin', 'x', 'content:read', 'r', 1, 1, 2)")
          .run(),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.prepare("INSERT INTO ai_provider_keys (id, preset, label, wire, base_url, created_at, updated_at) VALUES ('p1', 'x', 'x', 'grpc', 'https://h', 1, 1)").run(),
      /CHECK constraint/,
    )
    assert.ok(indexes(db).includes('idx_ai_tokens_grant') && indexes(db).includes('idx_ai_grants_session'))
  } finally {
    db.close()
  }
})

test('ai.db v1: every table of §3.2 with its constraints and indexes, idempotent on replay', () => {
  const db = new Database(':memory:')
  try {
    const report = runMigrations(db, AI_MIGRATIONS, { label: 'ai' })
    assert.equal(report.to, AI_MIGRATIONS.length)
    assert.deepEqual(
      tables(db).filter((t) => t !== 'schema_version' && t !== 'sqlite_sequence'),
      ['ai_changes', 'ai_conversations', 'ai_counters', 'ai_grant_daily', 'ai_runs', 'ai_tool_calls', 'ai_turns', 'ai_usage'],
    )
    assert.deepEqual(indexes(db), [
      'idx_ai_calls_actor',
      'idx_ai_calls_at',
      'idx_ai_changes_actor',
      'idx_ai_changes_state',
      'idx_ai_changes_target',
      'idx_ai_conv_updated',
      'idx_ai_usage_day',
    ])
    assert.equal(runMigrations(db, AI_MIGRATIONS, { label: 'ai' }).applied.length, 0)
    db.exec('BEGIN')
    AI_MIGRATIONS[0].up(db)
    db.exec('COMMIT')
    // States, risks, roles and outcomes are closed sets.
    const change = (state: string, risk: string) =>
      db
        .prepare(
          `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at)
           VALUES (?, ?, ?, 'edit_content', 'item.edit-pending', 'mcp', 'g1', 'AI · laptop token', 1, 'blog', 'example', 'Edit post example', 'a', 'p', 1)`,
        )
        .run(`ch_${state}_${risk}`, state, risk)
    change('waiting', 'live')
    assert.throws(() => change('done', 'live'), /CHECK constraint/)
    assert.throws(() => change('waiting', 'read'), /CHECK constraint/)
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO ai_tool_calls (at, actor_kind, actor_id, actor_label, tool, risk, outcome, ms, args_sha256) VALUES (1, 'mcp', 'g', 'l', 't', 'read', 'maybe', 1, 'a')")
          .run(),
      /CHECK constraint/,
    )
  } finally {
    db.close()
  }
})

test('ai.db v2: a change records the session that issued it, as a guarded nullable column; rows from v1 keep NULL', () => {
  const fresh = new Database(':memory:')
  const v1 = new Database(':memory:')
  try {
    runMigrations(fresh, AI_MIGRATIONS, { label: 'ai' })
    assert.ok(hasColumn(fresh, 'ai_changes', 'issuer_session'))
    // A v1 store with a row: v2 adds the column, the row reads NULL (its run still names the session).
    runMigrations(v1, AI_MIGRATIONS.slice(0, 1), { label: 'ai' })
    v1.prepare(
      `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at)
       VALUES ('ch_aaaaaaaaaaaaaaaa', 'waiting', 'live', 'propose_publishing', 'item.publish', 'assistant', 'run_1', 'Model · m', 1, 'blog', 'example', 'Publish post example', 'a', 'p', 1)`,
    ).run()
    const report = runMigrations(v1, AI_MIGRATIONS, { label: 'ai' })
    assert.deepEqual(report.applied.map((a) => a.version), [2])
    assert.equal((v1.prepare('SELECT issuer_session FROM ai_changes').get() as { issuer_session: unknown }).issuer_session, null)
    // Guarded: replaying the step on a store that has the column changes nothing.
    AI_MIGRATIONS[1].up(v1)
    assert.ok(hasColumn(v1, 'ai_changes', 'issuer_session'))
  } finally {
    fresh.close()
    v1.close()
  }
})

test('audit.db v2: the AI actor columns, guarded so a store changed by hand migrates too', () => {
  const columns = [
    'actor_kind',
    'ai_client',
    'ai_grant_id',
    'ai_provider',
    'ai_model',
    'ai_run_id',
    'tool',
    'args_sha256',
    'tool_list_hash',
    'change_id',
    'approved_by_session',
    'approved_at',
  ]
  const fresh = new Database(':memory:')
  const byHand = new Database(':memory:')
  try {
    runMigrations(fresh, AUDIT_MIGRATIONS, { label: 'audit' })
    for (const c of columns) assert.ok(hasColumn(fresh, 'audit_log', c), c)
    assert.ok(indexes(fresh).includes('idx_audit_actor_ts'))
    // A v1 store that already has two of the columns (added by hand): v2 adds the rest.
    runMigrations(byHand, AUDIT_MIGRATIONS.slice(0, 1), { label: 'audit' })
    byHand.exec('ALTER TABLE audit_log ADD COLUMN actor_kind TEXT; ALTER TABLE audit_log ADD COLUMN tool TEXT')
    byHand.prepare("INSERT INTO audit_log (ts, action, area, summary, method, route, status) VALUES (1, 'post.save', 'post', 'Saved post “x”', 'PUT', 'admin/posts', 200)").run()
    const report = runMigrations(byHand, AUDIT_MIGRATIONS, { label: 'audit' })
    assert.deepEqual(report.applied.map((a) => a.version), [2])
    for (const c of columns) assert.ok(hasColumn(byHand, 'audit_log', c), c)
    // Existing rows are a person's writes: every new column is empty.
    const row = byHand.prepare('SELECT * FROM audit_log').get() as Record<string, unknown>
    for (const c of columns) assert.equal(row[c], null, c)
  } finally {
    fresh.close()
    byHand.close()
  }
})

test('data/ai.db opens owner-only (file, -wal, -shm; a new data dir 0700) with secure_delete and foreign keys on', async () => {
  const { aiDbPath, closeAiDb, getAiDb } = await import('../lib/ai/db')
  const file = aiDbPath()
  assert.equal(file, path.join(process.cwd(), 'data', 'ai.db'))
  withUmask(() => {
    const db = getAiDb()
    assert.equal(getAiDb(), db, 'one connection per process')
    assert.equal(modeOf(path.dirname(file)), 0o700)
    db.prepare("INSERT INTO ai_counters (key, window_start, n) VALUES ('probe', 0, 1)").run()
    for (const p of sidecars(file)) assert.equal(modeOf(p), 0o600, p)
    assert.equal(db.pragma('secure_delete', { simple: true }), 1)
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal')
    assert.equal(currentVersion(db), AI_MIGRATIONS.length)
    // Foreign keys: a conversation's turns and runs go with it.
    db.prepare(
      "INSERT INTO ai_conversations (id, title, provider_id, provider_label, wire, model, system_text, tools_json, tool_list_hash, created_at, updated_at) VALUES ('c1', 't', 'p1', 'Test', 'chat', 'm', 's', '[]', 'h', 1, 1)",
    ).run()
    db.prepare("INSERT INTO ai_turns (conversation_id, seq, role, native_json, display_json, created_at) VALUES ('c1', 1, 'user', '{}', '{}', 1)").run()
    db.prepare("INSERT INTO ai_runs (id, conversation_id, session_id, state, started_at) VALUES ('r1', 'c1', 's1', 'running', 1)").run()
    assert.throws(
      () => db.prepare("INSERT INTO ai_turns (conversation_id, seq, role, native_json, display_json, created_at) VALUES ('nope', 1, 'user', '{}', '{}', 1)").run(),
      /FOREIGN KEY/,
    )
    db.prepare("DELETE FROM ai_conversations WHERE id = 'c1'").run()
    assert.equal((db.prepare('SELECT count(*) AS n FROM ai_turns').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM ai_runs').get() as { n: number }).n, 0)
    closeAiDb()
    // A world-readable copy left by hand is repaired on the next open.
    for (const p of sidecars(file)) if (fs.existsSync(p)) fs.chmodSync(p, 0o644)
    getAiDb().prepare("INSERT INTO ai_counters (key, window_start, n) VALUES ('probe', 1, 1)").run()
    for (const p of sidecars(file)) assert.equal(modeOf(p), 0o600, p)
  })
})

test('the operator CLI knows the ai store: status lists it, and a migrated copy stays owner-only', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-stores-cli-'))
  try {
    // A copy of the CLI next to an empty data/ dir, so the status run never opens this checkout's stores.
    fs.cpSync(path.join(ROOT, 'scripts', 'db'), path.join(work, 'scripts', 'db'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'scripts', 'migrate-db.mjs'), path.join(work, 'scripts', 'migrate-db.mjs'))
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'))
    fs.mkdirSync(path.join(work, 'data'))
    const cli = path.join(work, 'scripts', 'migrate-db.mjs')
    const status = spawnSync(process.execPath, [cli, '--status'], { encoding: 'utf8', cwd: work })
    assert.equal(status.status, 0, status.stderr)
    const names = status.stdout
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/)[0])
    assert.deepEqual(names, ['content', 'analytics', 'auth', 'audit', 'ai'])
    assert.match(status.stdout, /^ai\s+\(no data\/ai\.db yet/m)

    const file = path.join(work, 'copy-ai.db')
    withUmask(() => new Database(file).close())
    assert.equal(modeOf(file), 0o644, 'made the ordinary way')
    const migrated = spawnSync(process.execPath, [cli, '--db', 'ai', '--file', file], { encoding: 'utf8' })
    assert.equal(migrated.status, 0, migrated.stderr)
    assert.match(migrated.stdout, /ai: migrated v0 → v2 \(1-baseline, 2-change-issuer-session\)/)
    for (const p of sidecars(file)) if (fs.existsSync(p)) assert.equal(modeOf(p), 0o600, p)
    const again = spawnSync(process.execPath, [cli, '--status', '--db', 'ai', '--file', file], { encoding: 'utf8' })
    assert.match(again.stdout, /^ai\s+v2\/2 {2}current/m)
    const bad = spawnSync(process.execPath, [cli, '--db', 'constructor'], { encoding: 'utf8' })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /content \| analytics \| auth \| audit \| ai/)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('ai.db is wired where every store is: boot, System snapshot, deploy backup, CLI (§3)', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  assert.match(read('instrumentation.ts'), /import\('\.\/lib\/ai\/db'\)[\s\S]*getAiDb\(\)/)
  assert.match(read('lib/systemHealth.ts'), /databaseInfo\('ai', aiDbPath\(\), \(\) => getAiDb\(\), AI_MIGRATIONS\)/)
  assert.match(read('scripts/deploy.sh'), /for db in content\.db analytics\.db auth\.db audit\.db ai\.db; do/)
  // Never in a content snapshot or the R2 mirror: those name content.db only.
  for (const f of ['lib/backup.ts', 'lib/r2.ts', 'scripts/sync-to-r2.mjs', 'scripts/sync-from-r2.mjs']) assert.doesNotMatch(read(f), /ai\.db/, f)
  // data/ is ignored by git and kept out of the image's build context.
  assert.match(read('.gitignore'), /^data\/$/m)
  assert.match(read('.dockerignore'), /^data\/\*$/m)
})

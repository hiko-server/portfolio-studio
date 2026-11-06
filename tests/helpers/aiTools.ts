/**
 * Calls the AI tools the way a surface does (lib/ai/execute executeTool),
 * as a connected app at each access level, on the harness's throw-away
 * store. Import inside a test, after the harness moved the working
 * directory. Test-only.
 */
import assert from 'node:assert/strict'

export type Level = 'read' | 'draft' | 'propose'

export const LEVEL_SCOPES: Record<Level, string[]> = {
  read: ['content:read'],
  draft: ['content:read', 'content:draft'],
  propose: ['content:read', 'content:draft', 'content:propose'],
}

export type ToolCall = { ok: boolean; code: string | null; text: string; json: any }

export async function aiToolCaller(resource = 'http://127.0.0.1:3999/mcp') {
  const access = await import('../../lib/ai/access')
  const { executeTool } = await import('../../lib/ai/execute')
  const { getAuthDb } = await import('../../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
  const grants = {} as Record<Level, { id: string; name: string; scopes: string[] }>
  for (const level of Object.keys(LEVEL_SCOPES) as Level[]) {
    const out = access.createPersonalToken({ name: `${level} level`, scopes: LEVEL_SCOPES[level], days: 30, resource, session: { id: null, device: null } })
    if (!out.ok) throw new Error(JSON.stringify(out))
    grants[level] = { id: out.grant.id, name: out.grant.name, scopes: out.grant.scopes }
  }

  /** A new grant of its own at `level` (its own call budget). */
  function grantAt(level: Level) {
    const out = access.createPersonalToken({ name: `extra ${level}`, scopes: LEVEL_SCOPES[level], days: 30, resource, session: { id: null, device: null } })
    if (!out.ok) throw new Error(JSON.stringify(out))
    return { id: out.grant.id, name: out.grant.name, scopes: out.grant.scopes }
  }

  /**
   * The calls' clock. Budgets are fixed windows of a minute (lib/ai/budgets); a test that should not share them
   * with the one before moves the clock on (nextMinute) instead of waiting.
   */
  let clock = Date.now()
  const nextMinute = () => {
    clock += 61_000
  }

  async function call(name: string, args: unknown, level: Level = 'read', opts: { grant?: { id: string; name: string; scopes: string[] }; loop?: import('../../lib/ai/execute').LoopGuard } = {}): Promise<ToolCall> {
    const g = opts.grant ?? grants[level]
    const res = await executeTool(name, args, {
      now: () => clock,
      actor: { kind: 'mcp', grantId: g.id, label: g.name },
      scopes: new Set(g.scopes as never[]),
      origin: { ipPrefix: '198.51.100.0/24', country: 'HK' },
      era: 'modern',
      requestId: null,
      signal: new AbortController().signal,
      loop: opts.loop,
    })
    let json: any = null
    try {
      json = JSON.parse(res.text)
    } catch {
      json = null
    }
    return { ...res, json }
  }

  /** The data of a successful call (fails the test otherwise). */
  async function data(name: string, args: unknown, level: Level = 'read') {
    const out = await call(name, args, level)
    assert.equal(out.ok, true, `${name} ${JSON.stringify(args)} at ${level}: ${out.text.slice(0, 300)}`)
    return out.json
  }

  return { call, data, grants, grantAt, nextMinute }
}

/** The store helpers the fixtures use, loaded after the harness moved the working directory. */
export async function storeWriters() {
  const store = await import('../../lib/contentStore')
  const pending = await import('../../lib/pendingRevisions')
  const db = (await import('../../lib/db')).getDb()
  return {
    async item(c: 'blog' | 'work', slug: string, frontmatter: Record<string, unknown>, body: string) {
      const out = await store.putItem(c, slug, frontmatter, body)
      assert.ok(out.ok, JSON.stringify(out))
      return store.getItem(c, slug) as NonNullable<ReturnType<typeof store.getItem>>
    },
    pending(c: 'blog' | 'work', slug: string, frontmatter: Record<string, unknown>, body: string) {
      const live = store.getItem(c, slug)
      assert.ok(live)
      return pending.putPendingRevision(c, slug, frontmatter, body, Math.trunc(live.updated_at))
    },
    async page(name: string, frontmatter: Record<string, unknown>, body: string) {
      assert.ok((await store.putPage(name, frontmatter, body)).ok)
    },
    async kv(key: string, value: unknown) {
      const out = await store.putKv(key, value)
      assert.ok(out.ok, JSON.stringify(out))
    },
    asset(name: string, bytes = 1000, width = 800, height = 600) {
      db.prepare(
        `INSERT INTO media_assets (name, bytes, width, height, format, animated, local, added_at, checked_at) VALUES (?, ?, ?, ?, 'webp', 0, 1, ?, ?)
         ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes`,
      ).run(name, bytes, width, height, Date.now(), Date.now())
    },
  }
}

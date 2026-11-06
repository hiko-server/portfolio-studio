/**
 * The AI change store (lib/ai/changes, design §3.2), the parts stage M2
 * builds: change ids, the fail-closed life of an applied row (applying →
 * applied, or removed), the before-state undo needs, and retention — rows
 * 400 days, their stored data 90 days, all stored data at most 256 MB with
 * the oldest finished rows losing theirs first, except the earliest
 * before-state of each target (the state before AI first touched it) and
 * anything still open. Stage M3 adds the state machine of proposals,
 * expiry, voiding, the waiting budgets and undo to this suite.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'

const h = editorialHarness('ai-changes', 'ai-changes-secret-0123456789abcdef0123456789')
let changes: typeof import('../lib/ai/changes')
let db: import('better-sqlite3').Database
const DAY = 86_400_000

before(async () => {
  await h.setup()
  changes = await import('../lib/ai/changes')
  db = (await import('../lib/ai/db')).getAiDb()
})
after(() => h.teardown())

const actor = { kind: 'mcp' as const, grantId: 'gtest', label: 'test token' }
const preview = (title: string) => ({
  kind: 'item.edit-draft',
  risk: 'draft' as const,
  title,
  documents: [{ ref: 'blog/x', label: 'Draft post x', publicUrl: null, format: 'mdx' as const, before: 'a', after: 'b' }],
  newLinks: [],
  newEmbeds: [],
  zeroWidth: 0,
  effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
})

function add(id: string, target: string, at: number, opts: { state?: string; bytes?: number } = {}) {
  changes.beginAppliedChange(
    {
      id,
      risk: 'draft',
      tool: 'edit_content',
      kind: 'item.edit-draft',
      actor,
      issuerVersion: 1,
      target: { kind: 'blog', ref: target },
      title: `Edit of draft post ${target}`,
      baseVersion: '"1"',
      // Random bytes as base64, so the stored arguments are about 4/3 of `bytes`.
      args: { body: Buffer.from(Array.from({ length: opts.bytes ?? 100 }, () => Math.floor(Math.random() * 256))).toString('base64') },
      preview: preview(`Edit ${id}`),
      before: { kind: 'item', collection: 'blog', slug: target, live: { frontmatter: { title: id }, body: id, updatedAt: at }, pending: null },
      rationale: null,
    },
    at,
  )
  if (opts.state !== 'applying') changes.finishAppliedChange(id, { version: '"2"', publicUrls: [] }, at)
  if (opts.state && opts.state !== 'applied' && opts.state !== 'applying') db.prepare('UPDATE ai_changes SET state = ? WHERE id = ?').run(opts.state, id)
}

/** A change id from a readable name (ch_ and 16 letters). */
const ID = (name: string) => `ch_${name.padEnd(16, 'x').slice(0, 16)}`

const blobs = (id: string) => db.prepare('SELECT args_json IS NOT NULL AS a, preview_gz IS NOT NULL AS p, before_gz IS NOT NULL AS b FROM ai_changes WHERE id = ?').get(id) as { a: number; p: number; b: number } | undefined

test('change ids are ch_ and 16 base32 letters, and do not repeat', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => changes.newChangeId()))
  assert.equal(ids.size, 2000)
  for (const id of ids) assert.match(id, /^ch_[a-z2-7]{16}$/)
})

test('an applied row: applying first, applied with its result; a refused write removes it; the before-state and preview read back', () => {
  const now = Date.now()
  add('ch_aaaaaaaaaaaaaaaa', 'one', now, { state: 'applying' })
  assert.equal((db.prepare('SELECT state FROM ai_changes WHERE id = ?').get('ch_aaaaaaaaaaaaaaaa') as { state: string }).state, 'applying')
  assert.equal(changes.finishAppliedChange('ch_aaaaaaaaaaaaaaaa', { version: '"9"' }, now), true)
  assert.equal(changes.finishAppliedChange('ch_aaaaaaaaaaaaaaaa', { version: '"9"' }, now), false, 'only an applying row becomes applied')
  assert.deepEqual(changes.beforeStateOf('ch_aaaaaaaaaaaaaaaa'), { kind: 'item', collection: 'blog', slug: 'one', live: { frontmatter: { title: 'ch_aaaaaaaaaaaaaaaa' }, body: 'ch_aaaaaaaaaaaaaaaa', updatedAt: now }, pending: null })
  assert.equal(changes.previewOf('ch_aaaaaaaaaaaaaaaa')?.title, 'Edit ch_aaaaaaaaaaaaaaaa')
  add('ch_bbbbbbbbbbbbbbbb', 'one', now, { state: 'applying' })
  changes.dropAppliedChange('ch_bbbbbbbbbbbbbbbb')
  assert.equal(blobs('ch_bbbbbbbbbbbbbbbb'), undefined)
  changes.dropAppliedChange('ch_aaaaaaaaaaaaaaaa')
  assert.ok(blobs('ch_aaaaaaaaaaaaaaaa'), 'an applied row is never removed by a drop')
  assert.equal(changes.beforeStateOf('ch_zzzzzzzzzzzzzzzz'), null)
})

test('retention: rows go after 400 days, their stored data after 90 days, open rows keep theirs', () => {
  db.prepare('DELETE FROM ai_changes').run()
  const now = Date.now()
  add(ID('old400days'), 'r1', now - 401 * DAY)
  add(ID('old91days'), 'r2', now - 91 * DAY)
  add(ID('waitingold'), 'r3', now - 91 * DAY, { state: 'waiting' })
  add(ID('recent'), 'r4', now - 10 * DAY)
  const report = changes.pruneChanges(now)
  assert.equal(report.deleted, 1)
  assert.equal(report.expired, 1)
  assert.equal(blobs(ID('old400days')), undefined)
  assert.deepEqual(blobs(ID('old91days')), { a: 0, p: 0, b: 0 }, 'the row stays, its data goes')
  assert.deepEqual(blobs(ID('waitingold')), { a: 1, p: 1, b: 1 }, 'a waiting row keeps its data')
  assert.deepEqual(blobs(ID('recent')), { a: 1, p: 1, b: 1 })
})

test('the storage cap: the oldest finished rows lose their data first; the earliest before-state of each target and open rows are kept', () => {
  db.prepare('DELETE FROM ai_changes').run()
  const now = Date.now()
  // Three edits of target A, two of B, each about 27 KB of stored arguments; one applying row.
  add('ch_aaaaaaaaaaaaaaa1', 'target-a', now - 50 * DAY, { bytes: 20_000 })
  add('ch_aaaaaaaaaaaaaaa2', 'target-a', now - 40 * DAY, { bytes: 20_000 })
  add('ch_bbbbbbbbbbbbbbb1', 'target-b', now - 35 * DAY, { bytes: 20_000 })
  add('ch_aaaaaaaaaaaaaaa3', 'target-a', now - 30 * DAY, { bytes: 20_000 })
  add('ch_bbbbbbbbbbbbbbb2', 'target-b', now - 20 * DAY, { bytes: 20_000 })
  add('ch_cccccccccccccccc', 'target-c', now - 60 * DAY, { bytes: 20_000, state: 'applying' })
  const total = changes.changeStorageBytes()
  assert.ok(total > 150_000, `${total}`)
  const report = changes.pruneChanges(now, Math.floor(total * 0.6))
  assert.ok(report.evicted >= 2, JSON.stringify(report))
  assert.ok(changes.changeStorageBytes() <= Math.floor(total * 0.6))
  // The oldest finished row lost its arguments and preview, but kept the earliest before-state of target A.
  assert.deepEqual(blobs('ch_aaaaaaaaaaaaaaa1'), { a: 0, p: 0, b: 1 })
  assert.ok(changes.beforeStateOf('ch_aaaaaaaaaaaaaaa1'), 'the state before AI first touched target A survives')
  // The next oldest of A lost everything (it is not the earliest); B's first edit keeps its before-state.
  assert.deepEqual(blobs('ch_aaaaaaaaaaaaaaa2'), { a: 0, p: 0, b: 0 })
  assert.equal(blobs('ch_bbbbbbbbbbbbbbb1')?.b, 1)
  // An open (applying) row is never touched, however old.
  assert.deepEqual(blobs('ch_cccccccccccccccc'), { a: 1, p: 1, b: 1 })
  // The newest rows were not needed to get under the cap.
  assert.deepEqual(blobs('ch_bbbbbbbbbbbbbbb2'), { a: 1, p: 1, b: 1 })
})

test('createdDraftTargets lists the applied creations of one actor only', () => {
  db.prepare('DELETE FROM ai_changes').run()
  const now = Date.now()
  add(ID('created'), 'made', now)
  db.prepare("UPDATE ai_changes SET kind = 'item.create'").run()
  assert.deepEqual(changes.createdDraftTargets(actor), [{ collection: 'blog', slug: 'made' }])
  assert.deepEqual(changes.createdDraftTargets({ kind: 'mcp', grantId: 'gother', label: 'x' }), [])
  db.prepare("UPDATE ai_changes SET state = 'undone'").run()
  assert.deepEqual(changes.createdDraftTargets(actor), [], 'an undone creation does not count')
})

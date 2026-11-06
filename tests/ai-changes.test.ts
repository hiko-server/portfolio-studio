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

// ── Stage M3: waiting changes, decisions, expiry, voiding, budgets, undo ─────

type Tools = Awaited<ReturnType<typeof import('./helpers/aiTools').aiToolCaller>>
type Routes = Awaited<ReturnType<typeof import('./helpers/aiChanges').changeRoutes>>
let tools: Tools
let routes: Routes
let w: Awaited<ReturnType<typeof import('./helpers/aiTools').storeWriters>>

const HOME = {
  hero: { welcome: 'Hello', brand: 'Example Person', tagline: 'Builder', avatarUrl: '/uploads/avatar.webp' },
  socials: { github: 'https://github.com/example' },
  brands: [],
  quickAccess: [{ label: 'Blog', url: '/blog' }],
}
const CV = {
  en: [
    { sessionName: 'personalInformation', headerName: 'Personal', firstName: 'Example', lastName: 'Person', introduction: 'Builds things.' },
    { sessionName: 'workExperience', headerName: 'Work', experiences: [{ uid: 'job-a', jobTitle: 'Engineer', companyName: 'Example Co', features: [], relatedSkills: [] }] },
  ],
  zh: [],
}

test('M3 setup: the content, the tools and the routes', async () => {
  const { aiToolCaller, storeWriters } = await import('./helpers/aiTools')
  const { changeRoutes } = await import('./helpers/aiChanges')
  db.prepare('DELETE FROM ai_changes').run()
  w = await storeWriters()
  for (const slug of ['u-draft', 'u-publish', 'u-del']) await w.item('blog', slug, { title: slug, date: '2026-05-01', draft: true }, `Draft ${slug}.`)
  for (const slug of ['u-live', 'u-unpub', 'u-sched', 'u-unsched', 'u-disc', 'u-restore', 'u-held', 'u-since', 'tag-1']) {
    await w.item('blog', slug, { title: slug, date: '2026-04-01', tags: slug === 'tag-1' ? ['undo-tag'] : [] }, `Live ${slug}.`)
  }
  for (const slug of ['u-sched', 'u-unsched', 'u-disc', 'u-held']) w.pending('blog', slug, { title: slug, date: '2026-04-01' }, `Pending ${slug}.`)
  const admin = await import('../lib/mdx-admin')
  await admin.writeOne('blog', 'u-restore', { title: 'u-restore', date: '2026-04-01' }, 'Second version of u-restore.')
  await w.page('now', { title: 'Now' }, 'Doing things.')
  await w.page('uses', { title: 'Uses' }, 'Tools.')
  await admin.writePage('uses', { title: 'Uses' }, 'Different tools.')
  const { saveHomeDoc } = await import('../lib/contentOps/home')
  const { saveCvDoc } = await import('../lib/contentOps/cv')
  const { log } = await import('../lib/log')
  assert.equal((await saveHomeDoc(HOME, {}, { log })).ok, true)
  assert.equal((await saveCvDoc({ en: CV.en, zh: CV.zh }, {}, { log })).ok, true)
  ;(await import('../lib/home')).saveHomeSnapshot()
  ;(await import('../lib/cvdata')).saveSnapshot()
  assert.equal((await saveHomeDoc({ ...HOME, hero: { ...HOME.hero, tagline: 'Builder of tools' } }, {}, { log })).ok, true)
  assert.equal((await saveCvDoc({ en: [{ ...CV.en[0], introduction: 'Builds tools.' }, CV.en[1]], zh: [] }, {}, { log })).ok, true)
  for (const name of ['texts.webp', 'u-trash.webp']) w.asset(name)
  const fs = await import('node:fs')
  const path = await import('node:path')
  fs.mkdirSync(path.join(h.tmp, 'public', 'uploads'), { recursive: true })
  fs.writeFileSync(path.join(h.tmp, 'public', 'uploads', 'u-trash.webp'), Buffer.from('RIFF0000WEBPVP8 '))
  await w.item('blog', 'texts-post', { title: 'texts-post', date: '2026-04-01' }, '![x](/uploads/texts.webp)')
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
})

const grant = () => tools.grantAt('propose')
async function call(name: string, args: Record<string, unknown>) {
  tools.nextMinute()
  const out = await tools.call(name, { ...(name.startsWith('propose_') ? { rationale: 'Requested.' } : {}), ...args }, 'propose', { grant: grant() })
  assert.equal(out.ok, true, `${name}: ${out.text}`)
  return out.json
}
const version = async (c: 'blog' | 'work' | 'page', ref: string) => (await tools.data('get_content', { collection: c, ref, include_body: false }, 'draft')).version as string
const stateOf = (id: string) => (db.prepare('SELECT state, error_code FROM ai_changes WHERE id = ?').get(id) as { state: string; error_code: string | null })

test('the state machine: waiting → applying → applied, or rejected with a note, or expired; single use; an approval stuck in applying reads failed', async () => {
  const out = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'One.' }, base_version: await version('page', 'now') })
  const id = out.change_id as string
  assert.equal(stateOf(id).state, 'waiting')
  assert.equal(changes.claimForApply(id, 'session-a'), true)
  assert.equal(changes.claimForApply(id, 'session-b'), false, 'single use')
  assert.equal(stateOf(id).state, 'applying')
  assert.equal(changes.stateAt({ state: 'applying', expires_at: null, decided_at: Date.now() - 6 * 60_000, created_at: 0 }, Date.now()), 'failed')
  assert.equal(changes.releaseClaim(id), true, 'nothing written: it waits again')
  assert.equal(stateOf(id).state, 'waiting')

  const rejected = await routes.reject(id, 'Not this wording.‮')
  assert.equal(rejected.statusCode, 200, JSON.stringify(rejected.body))
  assert.equal(stateOf(id).state, 'rejected')
  assert.equal((db.prepare('SELECT reject_note FROM ai_changes WHERE id = ?').get(id) as { reject_note: string }).reject_note, 'Not this wording.', 'plain text, bidi controls removed')
  assert.equal((await routes.approve(id)).body.code, 'NOT_WAITING')
  assert.equal((await routes.reject(id)).body.code, 'NOT_WAITING')
  // The app reads the decision and the note.
  const seen = await tools.call('get_change', { change_id: id }, 'propose', { grant: { id: (db.prepare('SELECT actor_id FROM ai_changes WHERE id = ?').get(id) as { actor_id: string }).actor_id, name: 'x', scopes: ['content:read', 'content:draft', 'content:propose'] } })
  assert.equal(seen.json.state, 'rejected')
  assert.equal(seen.json.owner_note, 'Not this wording.')
})

test('expiry at 7 days: a waiting change past it reads expired, cannot be approved or rejected, and is marked expired', async () => {
  const out = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Two.' }, base_version: await version('page', 'now') })
  const id = out.change_id as string
  const row = db.prepare('SELECT created_at, expires_at FROM ai_changes WHERE id = ?').get(id) as { created_at: number; expires_at: number }
  assert.equal(row.expires_at - row.created_at, 7 * DAY)
  assert.equal(new Date(out.expires_at).getTime(), row.expires_at)
  db.prepare('UPDATE ai_changes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id)
  const approve = await routes.approve(id)
  assert.equal(approve.statusCode, 409)
  assert.equal(approve.body.code, 'EXPIRED')
  assert.equal(stateOf(id).state, 'expired')
  assert.equal((await routes.reject(id)).body.code, 'NOT_WAITING')
})

test('turning AI access off voids every waiting change; revoking an app voids its own', async () => {
  const settings = (await import('../pages/api/admin/ai/settings')).default
  const tokens = (await import('../pages/api/admin/ai/tokens')).default
  const a = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Three.' }, base_version: await version('page', 'now') })
  const b = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Four.' }, base_version: await version('page', 'now') })
  const appOf = (id: string) => (db.prepare('SELECT actor_id FROM ai_changes WHERE id = ?').get(id) as { actor_id: string }).actor_id
  const revoked = await h.call(tokens, { method: 'DELETE', body: { id: appOf(a.change_id) } })
  assert.equal(revoked.statusCode, 200, JSON.stringify(revoked.body))
  assert.deepEqual(stateOf(a.change_id), { state: 'voided', error_code: 'ISSUER_ENDED' })
  assert.equal(stateOf(b.change_id).state, 'waiting')
  const off = await h.call(settings, { method: 'PATCH', body: { enabled: false } })
  assert.equal(off.statusCode, 200, JSON.stringify(off.body))
  assert.deepEqual(stateOf(b.change_id), { state: 'voided', error_code: 'ACCESS_OFF' })
  assert.equal((await routes.approve(b.change_id)).body.code, 'NOT_WAITING')
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
})

test('waiting budgets: 10 per connection; 20 site-wide, the last 5 only for the assistant', async () => {
  db.prepare("UPDATE ai_changes SET state = 'rejected' WHERE state = 'waiting'").run()
  const page = async () => version('page', 'now')
  const one = grant()
  for (let i = 0; i < 10; i++) {
    tools.nextMinute()
    const out = await tools.call('propose_page_edit', { name: 'now', frontmatter_patch: { description: `Grant one, ${i}.` }, base_version: await page(), rationale: 'r' }, 'propose', { grant: one })
    assert.equal(out.json?.status, 'waiting_for_owner', out.text)
  }
  const eleventh = await tools.call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Eleven.' }, base_version: await page(), rationale: 'r' }, 'propose', { grant: one })
  assert.equal(eleventh.code, 'BUDGET')
  assert.equal(eleventh.json.error.budget, 'waitingPerGrant')
  const two = grant()
  for (let i = 0; i < 5; i++) {
    const out = await tools.call('propose_page_edit', { name: 'now', frontmatter_patch: { description: `Grant two, ${i}.` }, base_version: await page(), rationale: 'r' }, 'propose', { grant: two })
    assert.equal(out.json?.status, 'waiting_for_owner', out.text)
  }
  const three = await tools.call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Sixteenth.' }, base_version: await page(), rationale: 'r' }, 'propose', { grant: grant() })
  assert.equal(three.code, 'BUDGET')
  assert.equal(three.json.error.budget, 'waitingSite')
  // The assistant still has its five.
  const { createSession } = await import('../lib/adminAuth/sessions')
  const { executeTool } = await import('../lib/ai/execute')
  const session = createSession({ method: 'password', ttlMs: 3_600_000, device: null, ipPrefix: null, country: null })
  const assistant = { kind: 'assistant' as const, runId: 'run-budget-test', sessionId: session.id, provider: 'Example provider', model: 'example-model' }
  const run = async (i: number) =>
    JSON.parse(
      (
        await executeTool(
          'propose_page_edit',
          { name: 'now', frontmatter_patch: { description: `Assistant ${i}.` }, base_version: await page(), rationale: 'r' },
          { actor: assistant, scopes: new Set(['content:read', 'content:draft', 'content:propose'] as const), origin: { ipPrefix: null, country: null }, era: null, requestId: null, signal: new AbortController().signal, now: () => tools.now() },
        )
      ).text,
    )
  for (let i = 0; i < 5; i++) assert.equal((await run(i)).status, 'waiting_for_owner', `assistant ${i}`)
  assert.equal((await run(5)).error?.budget, 'waitingSite', 'and no more')
  db.prepare("UPDATE ai_changes SET state = 'rejected' WHERE state = 'waiting'").run()
})

/** The stored state of a target, without versions and times. */
async function stored(kind: string, ref: string) {
  const admin = await import('../lib/mdx-admin')
  const pend = await import('../lib/pendingRevisions')
  const store = await import('../lib/contentStore')
  if (kind === 'blog') {
    const one = admin.readOne('blog', ref)
    const p = pend.getPendingRevision('blog', ref)
    return JSON.stringify({ live: one && { fm: one.frontmatter, body: one.body }, pending: p && { fm: p.frontmatter, body: p.body } })
  }
  if (kind === 'page') {
    const page = admin.readPage(ref as 'now')
    return JSON.stringify({ fm: page.frontmatter, body: page.body })
  }
  if (kind === 'home') return JSON.stringify(store.getKv('home'))
  if (kind === 'cv') return JSON.stringify((await import('../lib/cvdata')).readCvData())
  if (kind === 'texts') {
    const meta = (await import('../lib/media/metaStore')).readMediaMeta().doc.items[ref]
    return JSON.stringify(meta ? { ...meta, updatedAt: 0 } : null)
  }
  const { getDb } = await import('../lib/db')
  const fs = await import('node:fs')
  const path = await import('node:path')
  return JSON.stringify({ file: fs.existsSync(path.join(h.tmp, 'public', 'uploads', ref)), trashed: !!getDb().prepare('SELECT 1 FROM media_trash WHERE name = ?').get(ref) })
}

/** Make a change, apply it (approving when it waits), then undo it: the target is exactly as before. */
async function roundTrip(label: string, kind: string, ref: string, make: () => Promise<{ change_id: string; status: string }>) {
  const before = await stored(kind, ref)
  const out = await make()
  if (out.status === 'waiting_for_owner') {
    const approved = await routes.approve(out.change_id)
    assert.equal(approved.statusCode, 200, `${label}: ${JSON.stringify(approved.body)}`)
  }
  assert.equal(stateOf(out.change_id).state, 'applied', label)
  assert.notEqual(await stored(kind, ref), before, `${label}: the change was made`)
  const card = await routes.card(out.change_id)
  assert.deepEqual(card.body.undo, { available: true }, `${label}: Undo is offered before the click`)
  const undone = await routes.undo(out.change_id)
  assert.equal(undone.statusCode, 200, `${label}: ${JSON.stringify(undone.body)}`)
  assert.equal(stateOf(out.change_id).state, 'undone', label)
  assert.equal(await stored(kind, ref), before, `${label}: exactly as before`)
  assert.equal((await routes.undo(out.change_id)).statusCode, 409, `${label}: undone once`)
}

test('undo of every single-target kind puts the replaced state back exactly', async () => {
  const later = new Date(Date.now() + 3 * DAY).toISOString()
  await roundTrip('create_draft', 'blog', 'u-new', () => call('create_draft', { collection: 'blog', slug: 'u-new', frontmatter: { title: 'New', date: '2026-06-01' }, body: 'A new draft.' }))
  await roundTrip('edit a draft', 'blog', 'u-draft', async () => call('edit_content', { collection: 'blog', slug: 'u-draft', body: 'Edited draft.', base_version: await version('blog', 'u-draft') }))
  await roundTrip('edit a live item', 'blog', 'u-live', async () => call('edit_content', { collection: 'blog', slug: 'u-live', body: 'Edited live.', base_version: await version('blog', 'u-live') }))
  await roundTrip('image texts', 'texts', 'texts.webp', async () => call('set_media_text', { name: 'texts.webp', alt: 'A desk', expected_updated_at: 0 }))
  await roundTrip('publish', 'blog', 'u-publish', async () => call('propose_publishing', { collection: 'blog', slug: 'u-publish', action: 'publish', base_version: await version('blog', 'u-publish') }))
  await roundTrip('unpublish', 'blog', 'u-unpub', async () => call('propose_publishing', { collection: 'blog', slug: 'u-unpub', action: 'unpublish', base_version: await version('blog', 'u-unpub') }))
  await roundTrip('schedule', 'blog', 'u-sched', async () => call('propose_publishing', { collection: 'blog', slug: 'u-sched', action: 'schedule', publish_at: later, base_version: await version('blog', 'u-sched') }))
  const { applySchedule } = await import('../lib/schedule/store')
  assert.equal((await applySchedule('blog', 'u-unsched', { publishAt: Date.parse(later), unpublishAt: null })).ok, true)
  await roundTrip('unschedule', 'blog', 'u-unsched', async () => call('propose_publishing', { collection: 'blog', slug: 'u-unsched', action: 'unschedule', base_version: await version('blog', 'u-unsched') }))
  await roundTrip('discard changes', 'blog', 'u-disc', async () => call('propose_publishing', { collection: 'blog', slug: 'u-disc', action: 'discard_changes', base_version: await version('blog', 'u-disc') }))
  const admin = await import('../lib/mdx-admin')
  await roundTrip('restore an item', 'blog', 'u-restore', async () =>
    call('propose_restore', { collection: 'blog', ref: 'u-restore', filename: admin.listSnapshots('blog', 'u-restore')[0].filename, base_version: await version('blog', 'u-restore') }),
  )
  const { createReviewLink } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'u-held', variant: 'changes', ttlHours: 24 }).ok, true)
  await roundTrip('a held edit', 'blog', 'u-held', async () => call('edit_content', { collection: 'blog', slug: 'u-held', body: 'Held edit.', base_version: await version('blog', 'u-held') }))
  await roundTrip('delete', 'blog', 'u-del', async () => call('propose_delete', { target: 'post', ref: 'u-del', base_version: await version('blog', 'u-del') }))
  await roundTrip('edit a page', 'page', 'now', async () => call('propose_page_edit', { name: 'now', body: 'Doing other things.', base_version: await version('page', 'now') }))
  await roundTrip('restore a page', 'page', 'uses', async () =>
    call('propose_restore', { collection: 'page', ref: 'uses', filename: admin.listSnapshots('page', 'uses')[0].filename, base_version: await version('page', 'uses') }),
  )
  const homeVersion = async () => (await tools.data('get_home', {}, 'draft')).version
  await roundTrip('edit the home page', 'home', 'home', async () => call('propose_home_edit', { ops: [{ path: 'hero.tagline', value_json: '"Maker"' }], base_version: await homeVersion() }))
  const { listHomeSnapshots } = await import('../lib/home')
  await roundTrip('restore the home page', 'home', 'home', async () => call('propose_restore', { collection: 'home', filename: listHomeSnapshots()[0], base_version: await homeVersion() }))
  const cvVersion = async () => (await tools.data('get_cv', {}, 'draft')).version
  await roundTrip('edit the CV', 'cv', 'cv', async () => call('propose_cv_edit', { ops: [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Lead"' }], base_version: await cvVersion() }))
  const { listSnapshots } = await import('../lib/cvdata')
  await roundTrip('restore the CV', 'cv', 'cv', async () => call('propose_restore', { collection: 'cv', filename: listSnapshots()[0], base_version: await cvVersion() }))
  await roundTrip('move an image to the trash', 'upload', 'u-trash.webp', async () => call('propose_delete', { target: 'image', ref: 'u-trash.webp' }))
})

test('undo is refused once the target changed since ("changed since"), and for changes that touch many documents', async () => {
  const store = await import('../lib/contentStore')
  const out = await call('edit_content', { collection: 'blog', slug: 'u-since', body: 'AI text.', base_version: await version('blog', 'u-since') })
  const pend = await import('../lib/pendingRevisions')
  const admin = await import('../lib/mdx-admin')
  pend.putPendingRevision('blog', 'u-since', { title: 'u-since', date: '2026-04-01' }, 'The owner went on writing.', admin.readOne('blog', 'u-since')!.updatedAt)
  const before = await stored('blog', 'u-since')
  const card = await routes.card(out.change_id)
  assert.deepEqual(card.body.undo, { available: false, code: 'CHANGED_SINCE', message: 'Changed since. Open the history.' })
  const undone = await routes.undo(out.change_id)
  assert.equal(undone.statusCode, 409)
  assert.equal(undone.body.code, 'CHANGED_SINCE')
  assert.equal(await stored('blog', 'u-since'), before, 'nothing written')
  assert.equal(stateOf(out.change_id).state, 'applied')

  const page = await call('propose_page_edit', { name: 'now', body: 'Once more.', base_version: await version('page', 'now') })
  assert.equal((await routes.approve(page.change_id)).statusCode, 200)
  // A page's version is its row's time in ms: let one pass, as any later save would.
  await new Promise((r) => setTimeout(r, 5))
  await store.putPage('now', { title: 'Now' }, 'The owner rewrote it again.')
  assert.equal((await routes.undo(page.change_id)).body.code, 'CHANGED_SINCE')

  const tag = await call('propose_tag_change', { collection: 'blog', from: ['undo-tag'], to: 'Renamed tag' })
  assert.equal((await routes.approve(tag.change_id)).statusCode, 200)
  const multi = await routes.undo(tag.change_id)
  assert.equal(multi.statusCode, 409)
  assert.equal(multi.body.code, 'NO_UNDO')
  assert.match(multi.body.error, /each document has its own history/)
})

test('retention keeps the earliest before-state of a target AI changed through approvals too', async () => {
  const rows = db.prepare("SELECT id FROM ai_changes WHERE target_kind = 'blog' AND target_ref = 'u-live' ORDER BY created_at").all() as Array<{ id: string }>
  assert.ok(rows.length >= 1)
  const report = changes.pruneChanges(Date.now(), 1)
  assert.ok(report.evicted >= 1)
  const first = changes.beforeStateOf(rows[0].id)
  assert.ok(first && first.kind === 'item' && first.live?.body === 'Live u-live.', 'the state before AI first touched it')
  // Waiting changes are never evicted.
  const waiting = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Kept.' }, base_version: await version('page', 'now') })
  changes.pruneChanges(Date.now(), 1)
  assert.ok(changes.previewOf(waiting.change_id), 'a waiting change keeps its preview')
})

test('schedules AI set and still to run are listed for the off and revoke dialogs; cleared ones drop out', async () => {
  const settings = (await import('../pages/api/admin/ai/settings')).default
  const tokensRoute = (await import('../pages/api/admin/ai/tokens')).default
  const later = new Date(Date.now() + 5 * DAY).toISOString()
  const out = await call('propose_publishing', { collection: 'blog', slug: 'u-draft', action: 'schedule', publish_at: later, base_version: await version('blog', 'u-draft') })
  assert.equal((await routes.approve(out.change_id)).statusCode, 200)
  const listed = await h.call(settings, {})
  assert.deepEqual(
    listed.body.schedules.map((s: { slug: string; publishAt: string }) => [s.slug, s.publishAt]),
    [['u-draft', new Date(Date.parse(later)).toISOString()]],
  )
  const app = (db.prepare('SELECT actor_id FROM ai_changes WHERE id = ?').get(out.change_id) as { actor_id: string }).actor_id
  const tokens = await h.call(tokensRoute, {})
  assert.deepEqual(tokens.body.schedules.map((s: { actorId: string; slug: string }) => [s.actorId, s.slug]), [[app, 'u-draft']])
  const { applySchedule } = await import('../lib/schedule/store')
  assert.equal((await applySchedule('blog', 'u-draft', { publishAt: null, unpublishAt: null })).ok, true)
  assert.deepEqual((await h.call(settings, {})).body.schedules, [], 'cleared by the owner: nothing left to offer')
})

/**
 * M3 — approval is bound to what the owner saw (design §2 property 7, §5.3,
 * §12.1 ai-approve-binding).
 *
 *   - For every kind of change: when what it would do changes after the
 *     proposal (the item, the page, the home page or the CV edited, a photo
 *     hidden, a redirect target moved, a default alt text rewritten, an
 *     upload now used, a slug taken), approving with the hash the owner saw
 *     writes nothing and the change becomes `conflict`.
 *   - A posted hash that is not the stored one is STALE_CARD (an old card).
 *   - A revoked or expired grant, and a change made under an older session
 *     version, are `voided`.
 *   - Two approvals at once: one applies, the other is refused; the content
 *     is written once.
 *   - A re-plan the site cannot run just now (the MDX check unavailable)
 *     writes nothing and the change waits; approving again applies it.
 *
 * Everything through the real routes (pages/api/admin/ai/changes/*) on the
 * editorial harness, and the real tools through executeTool.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-approve-binding', 'ai-approve-binding-secret-0123456789abcdef01234567')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>
let w: Awaited<ReturnType<typeof storeWriters>>
const DAY = 86_400_000

const HOME = {
  hero: { welcome: 'Hello', brand: 'Example Person', tagline: 'Builder', avatarUrl: '/uploads/avatar.webp' },
  socials: { github: 'https://github.com/example' },
  brands: [],
  quickAccess: [{ label: 'Blog', url: '/blog' }],
  photos: [
    { url: '/uploads/photo-a.webp', describe: 'Photo A' },
    { url: '/uploads/photo-hidden.webp', describe: 'Hidden photo', visible: false },
    { url: '/uploads/photo-c.webp', describe: 'Photo C' },
  ],
}

const CV = {
  en: [
    { sessionName: 'personalInformation', headerName: 'Personal', firstName: 'Example', lastName: 'Person', introduction: 'Builds things.' },
    {
      sessionName: 'workExperience',
      headerName: 'Work',
      experiences: [{ uid: 'job-a', jobTitle: 'Engineer', companyName: 'Example Co', startDate: '2024-01', endDate: '', jobDescription: 'Built things.', features: [], relatedSkills: [] }],
    },
  ],
  zh: [],
}

before(async () => {
  await h.setup()
  w = await storeWriters()
  const store = await import('../lib/contentStore')
  for (const slug of ['pub-draft', 'del-post', 'held-x', 'restore-post']) await w.item('blog', slug, { title: slug, date: '2026-05-01', ...(slug === 'pub-draft' ? { draft: true } : {}) }, `Body of ${slug}.`)
  for (const slug of ['unpub-live', 'pend-live', 'sched-live', 'disc-live', 'tag-a', 'tag-b']) {
    await w.item('blog', slug, { title: slug, date: '2026-04-01', tags: slug.startsWith('tag') ? ['old-tag'] : [] }, `Body of ${slug}.`)
  }
  for (const slug of ['pend-live', 'sched-live', 'disc-live']) w.pending('blog', slug, { title: slug, date: '2026-04-01' }, `Changes to ${slug}.`)
  await w.item('blog', 'links', { title: 'Links', date: '2026-04-01' }, 'See [the docs](https://moved.example.com/d).')
  await w.item('blog', 'alt-post', { title: 'Alt', date: '2026-04-01' }, 'A picture: ![](/uploads/alt.webp)')
  await w.page('now', { title: 'Now' }, 'Doing things.')
  await w.kv('home', HOME)
  await w.kv('cvdata', CV)
  for (const name of ['avatar.webp', 'photo-a.webp', 'photo-hidden.webp', 'photo-c.webp', 'alt.webp', 'trash-me.webp', 'trash-race.webp']) w.asset(name)
  fs.mkdirSync(path.join(h.tmp, 'public', 'uploads'), { recursive: true })
  for (const name of ['trash-me.webp', 'trash-race.webp']) fs.writeFileSync(path.join(h.tmp, 'public', 'uploads', name), Buffer.from('RIFF0000WEBPVP8 '))
  const { saveMediaText } = await import('../lib/contentOps/media')
  assert.equal((await saveMediaText({ name: 'alt.webp', texts: { alt: 'A desk by a window' } })).ok, true)
  // A second version of restore-post (writeOne keeps the first in the history), and snapshots of home and CV.
  const admin = await import('../lib/mdx-admin')
  await admin.writeOne('blog', 'restore-post', { title: 'restore-post', date: '2026-05-01' }, 'The second version.')
  const home = await import('../lib/home')
  home.saveHomeSnapshot()
  const cv = await import('../lib/cvdata')
  cv.saveSnapshot()
  await store.putKv('home', { ...HOME, hero: { ...HOME.hero, tagline: 'Builder of things' } })
  await store.putKv('cvdata', { ...CV, en: [{ ...CV.en[0], introduction: 'Builds many things.' }, CV.en[1]] })
  const { writeLinkStore } = await import('../lib/contentHealth/linkStore')
  writeLinkStore({ version: 1, lastRun: null, links: { 'https://moved.example.com/d': movedRecord('https://moved.example.com/new-d') } })
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

function movedRecord(finalUrl: string) {
  return { url: 'https://moved.example.com/d', checkedAt: Date.now() - 3_600_000, outcome: 'moved' as const, status: 200, code: null, reason: null, finalUrl, safeMove: true, failures: 0, failingSince: null }
}

/** Each proposal its own grant, so the write budgets (30 attempts an hour per grant) never decide a test. */
async function propose(tool: string, args: Record<string, unknown>) {
  const out = await tools.call(tool, { rationale: 'Requested by the owner.', ...args }, 'propose', { grant: tools.grantAt('propose') })
  assert.equal(out.json?.status, 'waiting_for_owner', `${tool}: ${out.text}`)
  return out.json.change_id as string
}

async function draftVersion(collection: 'blog' | 'work', slug: string) {
  return (await tools.data('get_content', { collection, ref: slug, include_body: false }, 'draft')).version as string
}

async function rowOf(id: string) {
  const { getAiDb } = await import('../lib/ai/db')
  return getAiDb().prepare('SELECT state, error_code FROM ai_changes WHERE id = ?').get(id) as { state: string; error_code: string | null }
}

async function snapshot() {
  const store = await import('../lib/contentStore')
  const { getDb } = await import('../lib/db')
  const db = getDb()
  return JSON.stringify({
    items: db.prepare('SELECT collection, slug, frontmatter, body, updated_at FROM collection_items ORDER BY collection, slug').all(),
    pending: db.prepare('SELECT collection, slug, frontmatter, body, updated_at FROM pending_revisions ORDER BY collection, slug').all(),
    pages: db.prepare('SELECT name, frontmatter, body, updated_at FROM pages ORDER BY name').all(),
    home: store.getKvWithMeta('home'),
    cv: store.getKvWithMeta('cvdata'),
    trash: db.prepare('SELECT name FROM media_trash ORDER BY name').all(),
  })
}

async function aiAuditRows(id: string) {
  const { getAuditDb } = await import('../lib/audit/db')
  return (getAuditDb().prepare('SELECT count(*) AS n FROM audit_log WHERE change_id = ?').get(id) as { n: number }).n
}

/** Approve after `mutate` changed what the change would do: nothing written, `conflict`, no activity row. */
async function expectConflict(label: string, id: string, mutate: () => Promise<void> | void) {
  await mutate()
  const before = await snapshot()
  const out = await routes.approve(id)
  assert.equal(out.statusCode, 409, `${label}: ${JSON.stringify(out.body)}`)
  assert.equal(out.body.code, 'CONFLICT', label)
  assert.equal((await rowOf(id)).state, 'conflict', label)
  assert.equal(await snapshot(), before, `${label}: nothing written`)
  assert.equal(await aiAuditRows(id), 0, `${label}: no activity row`)
  // A conflict has no rebase path: approving again is refused.
  assert.equal((await routes.approve(id)).statusCode, 409, `${label}: once conflicted, never applied`)
}

test('publishing: a draft edited, a pending revision edited, a live item edited, a schedule changed, a schedule cleared, changes rewritten: conflict', async () => {
  const admin = await import('../lib/mdx-admin')
  const pend = await import('../lib/pendingRevisions')
  const { applySchedule } = await import('../lib/schedule/store')
  const store = await import('../lib/contentStore')
  const later = Date.now() + 2 * DAY

  const pub = await propose('propose_publishing', { collection: 'blog', slug: 'pub-draft', action: 'publish', base_version: await draftVersion('blog', 'pub-draft') })
  await expectConflict('publish a draft', pub, async () => void (await store.putItem('blog', 'pub-draft', { title: 'pub-draft', date: '2026-05-01', draft: true }, 'Edited by the owner.')))

  const pubChanges = await propose('propose_publishing', { collection: 'blog', slug: 'pend-live', action: 'publish', mark_updated: true, base_version: await draftVersion('blog', 'pend-live') })
  await expectConflict('publish changes', pubChanges, () => void pend.putPendingRevision('blog', 'pend-live', { title: 'pend-live', date: '2026-04-01' }, 'Rewritten changes.', admin.readOne('blog', 'pend-live')!.updatedAt))

  const unpub = await propose('propose_publishing', { collection: 'blog', slug: 'unpub-live', action: 'unpublish', base_version: await draftVersion('blog', 'unpub-live') })
  await expectConflict('unpublish', unpub, async () => void (await store.putItem('blog', 'unpub-live', { title: 'unpub-live', date: '2026-04-01' }, 'A new live text.')))

  const sched = await propose('propose_publishing', { collection: 'blog', slug: 'sched-live', action: 'schedule', publish_at: new Date(later).toISOString(), base_version: await draftVersion('blog', 'sched-live') })
  await expectConflict('schedule', sched, async () => void assert.equal((await applySchedule('blog', 'sched-live', { publishAt: later + DAY, unpublishAt: null })).ok, true))

  const unsched = await propose('propose_publishing', { collection: 'blog', slug: 'sched-live', action: 'unschedule', base_version: await draftVersion('blog', 'sched-live') })
  await expectConflict('unschedule', unsched, async () => void assert.equal((await applySchedule('blog', 'sched-live', { publishAt: null, unpublishAt: null })).ok, true))

  const disc = await propose('propose_publishing', { collection: 'blog', slug: 'disc-live', action: 'discard_changes', base_version: await draftVersion('blog', 'disc-live') })
  await expectConflict('discard', disc, () => void pend.putPendingRevision('blog', 'disc-live', { title: 'disc-live', date: '2026-04-01' }, 'Newer changes.', admin.readOne('blog', 'disc-live')!.updatedAt))
})

test('a page, the home page (a photo hidden) and the CV edited after the proposal: conflict', async () => {
  const store = await import('../lib/contentStore')
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const pageEdit = await propose('propose_page_edit', { name: 'now', edits: [{ find: 'Doing things', replace: 'Doing other things' }], base_version: page.version })
  await expectConflict('page edit', pageEdit, async () => void (await store.putPage('now', { title: 'Now' }, 'The owner rewrote it.')))

  const home = await tools.data('get_home', {}, 'draft')
  assert.deepEqual(home.home.photos.map((p: { url: string }) => p.url), ['/uploads/photo-a.webp', '/uploads/photo-c.webp'], 'public positions')
  const homeEdit = await propose('propose_home_edit', { ops: [{ path: 'photos[1].describe', value_json: '"Photo C at dusk"' }], base_version: home.version })
  const stored = store.getKv('home') as typeof HOME
  await expectConflict('home edit, the photo hidden meanwhile', homeEdit, async () => {
    await store.putKv('home', { ...stored, photos: stored.photos.map((p) => (p.url === '/uploads/photo-c.webp' ? { ...p, visible: false } : p)) })
  })
  await store.putKv('home', stored)

  const cv = await tools.data('get_cv', {}, 'draft')
  const cvEdit = await propose('propose_cv_edit', { ops: [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Senior engineer"' }], base_version: cv.version })
  const storedCv = store.getKv('cvdata') as { en: Array<Record<string, any>>; zh: unknown[] }
  await expectConflict('CV edit, the entry hidden meanwhile', cvEdit, async () => {
    await store.putKv('cvdata', { ...storedCv, en: [storedCv.en[0], { ...storedCv.en[1], experiences: [{ ...storedCv.en[1].experiences[0], isVisible: false }] }] })
  })
  await store.putKv('cvdata', storedCv)
})

test('a tag change, a restore of each kind, a delete: what they would touch changed after the proposal: conflict', async () => {
  const store = await import('../lib/contentStore')
  const admin = await import('../lib/mdx-admin')
  const tag = await propose('propose_tag_change', { collection: 'blog', from: ['old-tag'], to: 'New tag' })
  await expectConflict('tag change', tag, async () => void (await store.putItem('blog', 'tag-c', { title: 'tag-c', date: '2026-04-01', tags: ['old-tag'] }, 'Another tagged post.')))

  const file = admin.listSnapshots('blog', 'restore-post')[0].filename
  const itemRestore = await propose('propose_restore', { collection: 'blog', ref: 'restore-post', filename: file, base_version: await draftVersion('blog', 'restore-post') })
  await expectConflict('item restore', itemRestore, async () => void (await store.putItem('blog', 'restore-post', { title: 'restore-post', date: '2026-05-01' }, 'A third version.')))

  await store.putPage('now', { title: 'Now' }, 'A version to restore later.')
  await store.putPage('now', { title: 'Now' }, 'The version after it.')
  await admin.writePage('now', { title: 'Now' }, 'Saved through the editor path.')
  const pageFile = admin.listSnapshots('page', 'now')[0].filename
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const pageRestore = await propose('propose_restore', { collection: 'page', ref: 'now', filename: pageFile, base_version: page.version })
  await expectConflict('page restore', pageRestore, async () => void (await store.putPage('now', { title: 'Now' }, 'Rewritten again.')))

  const { listHomeSnapshots } = await import('../lib/home')
  const { listSnapshots } = await import('../lib/cvdata')
  const homeRestore = await propose('propose_restore', { collection: 'home', filename: listHomeSnapshots()[0], base_version: (await tools.data('get_home', {}, 'draft')).version })
  await expectConflict('home restore', homeRestore, async () => void (await store.putKv('home', { ...HOME, hero: { ...HOME.hero, welcome: 'Hi there' } })))
  const cvRestore = await propose('propose_restore', { collection: 'cv', filename: listSnapshots()[0], base_version: (await tools.data('get_cv', {}, 'draft')).version })
  await expectConflict('CV restore', cvRestore, async () => void (await store.putKv('cvdata', { ...CV, en: [{ ...CV.en[0], introduction: 'Rewritten.' }, CV.en[1]] })))

  const del = await propose('propose_delete', { target: 'post', ref: 'del-post', base_version: await draftVersion('blog', 'del-post') })
  await expectConflict('delete', del, async () => void (await store.putItem('blog', 'del-post', { title: 'del-post', date: '2026-05-01' }, 'Edited before the delete.')))
})

test('a content fix whose redirect target moved, an alt fill whose text was rewritten, a trash of an upload now used: conflict', async () => {
  const store = await import('../lib/contentStore')
  const health = await tools.data('get_content_health', { check: 'redirect' }, 'draft')
  const issue = health.issues.find((i: { item: string }) => i.item === 'blog/links')
  assert.ok(issue, JSON.stringify(health.issues))
  const fix = await propose('propose_content_fix', { fixes: [{ id: issue.id, version: health.items[issue.item].version }] })
  const card = await routes.card(fix)
  assert.deepEqual(card.body.preview.newLinks.map((l: { url: string }) => l.url), ['https://moved.example.com/new-d'], 'the new address is listed')
  const { writeLinkStore } = await import('../lib/contentHealth/linkStore')
  await expectConflict('content fix, the redirect target moved', fix, () => writeLinkStore({ version: 1, lastRun: null, links: { 'https://moved.example.com/d': movedRecord('https://elsewhere.example.org/x') } }))

  const alt = await propose('propose_apply_alt', { name: 'alt.webp' })
  const { saveMediaText } = await import('../lib/contentOps/media')
  const { readMediaMeta } = await import('../lib/media/metaStore')
  await expectConflict('alt fill, the default alt rewritten', alt, async () => {
    const out = await saveMediaText({ name: 'alt.webp', texts: { alt: 'A table by a window' }, expectedUpdatedAt: readMediaMeta().doc.items['alt.webp']?.updatedAt })
    assert.equal(out.ok, true)
  })

  const trash = await propose('propose_delete', { target: 'image', ref: 'trash-race.webp' })
  await expectConflict('trash, the upload used meanwhile', trash, async () => void (await store.putItem('blog', 'uses-it', { title: 'uses-it', date: '2026-05-01' }, '![x](/uploads/trash-race.webp)')))
})

test('a held edit edited by the owner, and a waiting draft whose slug was taken: conflict', async () => {
  const store = await import('../lib/contentStore')
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { createReviewLink } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'held-x', variant: 'changes', ttlHours: 24 }).ok, true)
  const held = await propose('edit_content', { collection: 'blog', slug: 'held-x', body: 'An AI text.', base_version: await draftVersion('blog', 'held-x') })
  await expectConflict('held edit', held, async () => void (await store.putItem('blog', 'held-x', { title: 'held-x', date: '2026-05-01' }, 'The owner edited it.')))

  getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 0 WHERE id = 1').run()
  try {
    const draft = await propose('create_draft', { collection: 'blog', slug: 'queued-draft', frontmatter: { title: 'Queued', date: '2026-06-01' }, body: 'A queued draft.' })
    await expectConflict('waiting draft', draft, async () => void (await store.putItem('blog', 'queued-draft', { title: 'Owner’s', date: '2026-06-01', draft: true }, 'The owner took the slug.')))
  } finally {
    getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 1 WHERE id = 1').run()
  }
})

test('a posted hash that is not the stored one is STALE_CARD and the change still waits; the stored hash applies it', async () => {
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const id = await propose('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'What I do now.' }, base_version: page.version })
  for (const hash of ['0'.repeat(64), '', 'x', undefined as unknown as string]) {
    const before = await snapshot()
    const out = await routes.approve(id, hash ?? '')
    assert.equal(out.statusCode, 409)
    assert.equal(out.body.code, 'STALE_CARD')
    assert.equal((await rowOf(id)).state, 'waiting')
    assert.equal(await snapshot(), before)
  }
  const ok = await routes.approve(id)
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  const { readPage } = await import('../lib/mdx-admin')
  assert.equal(readPage('now').frontmatter.description, 'What I do now.')
  assert.equal(await aiAuditRows(id), 1, 'one activity row, approved by this browser')
})

test('a revoked grant, an expired grant and a change made under an older session version are voided; nothing is written', async () => {
  const access = await import('../lib/ai/access')
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { getAiDb } = await import('../lib/ai/db')
  const make = async (grant: { id: string; name: string; scopes: string[] }) => {
    const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
    const out = await tools.call('propose_page_edit', { name: 'now', frontmatter_patch: { updated: '2026-07-01' }, base_version: page.version, rationale: 'r' }, 'propose', { grant })
    assert.equal(out.json?.status, 'waiting_for_owner', out.text)
    return out.json.change_id as string
  }
  const revoked = tools.grantAt('propose')
  const a = await make(revoked)
  access.revokeGrant(revoked.id, 'test')
  const expired = tools.grantAt('propose')
  const b = await make(expired)
  getAuthDb().prepare('UPDATE ai_grants SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expired.id)
  const older = tools.grantAt('propose')
  const c = await make(older)
  getAiDb().prepare('UPDATE ai_changes SET issuer_version = issuer_version - 1 WHERE id = ?').run(c)
  for (const id of [a, b, c]) {
    const before = await snapshot()
    const out = await routes.approve(id)
    assert.equal(out.statusCode, 409, JSON.stringify(out.body))
    assert.equal(out.body.code, 'VOIDED')
    assert.match(out.body.error, /no longer has access/)
    assert.deepEqual(await rowOf(id), { state: 'voided', error_code: 'ISSUER_ENDED' })
    assert.equal(await snapshot(), before)
  }
})

test('stored arguments edited in the database: failed, nothing written', async () => {
  const { getAiDb } = await import('../lib/ai/db')
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const id = await propose('propose_page_edit', { name: 'now', body: 'An honest proposal.', base_version: page.version })
  const args = JSON.parse((getAiDb().prepare('SELECT args_json FROM ai_changes WHERE id = ?').get(id) as { args_json: string }).args_json)
  getAiDb().prepare('UPDATE ai_changes SET args_json = ? WHERE id = ?').run(JSON.stringify({ ...args, body: 'Swapped after the card was shown.' }), id)
  const before = await snapshot()
  const out = await routes.approve(id)
  assert.equal(out.statusCode, 409)
  assert.deepEqual(await rowOf(id), { state: 'failed', error_code: 'ARGS_CHANGED' })
  assert.equal(await snapshot(), before)
})

test('single use: two approvals at once — one applies, the other is refused; the content is written once', async () => {
  const id = await propose('propose_delete', { target: 'image', ref: 'trash-me.webp' })
  const card = await routes.card(id)
  const [x, y] = await Promise.all([routes.approve(id, card.body.preview_sha256), routes.approve(id, card.body.preview_sha256)])
  const statuses = [x.statusCode, y.statusCode].sort()
  assert.deepEqual(statuses, [200, 409], JSON.stringify([x.body, y.body]))
  const refused = x.statusCode === 409 ? x : y
  assert.equal(refused.body.code, 'NOT_WAITING')
  const { getDb } = await import('../lib/db')
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM media_trash WHERE name = 'trash-me.webp'").get() as { n: number }).n, 1)
  assert.equal((await rowOf(id)).state, 'applied')
  assert.equal(await aiAuditRows(id), 1)
})

test('a re-plan the site cannot run just now writes nothing and the change waits; approving again applies it', async () => {
  const compile = await import('../lib/ai/compile')
  const g = globalThis as typeof globalThis & { __aiCompiler?: import('../lib/ai/compile').AiCompiler }
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const id = await propose('propose_page_edit', { name: 'now', body: 'Checked again once the check is back.', base_version: page.version })
  const previous = g.__aiCompiler
  g.__aiCompiler = compile.createAiCompiler({
    spawn: () => {
      throw new Error('no worker here')
    },
  })
  try {
    const before = await snapshot()
    const out = await routes.approve(id)
    assert.equal(out.statusCode, 503, JSON.stringify(out.body))
    assert.equal(out.body.code, 'CHECK_UNAVAILABLE')
    assert.equal(out.body.state, 'waiting')
    assert.deepEqual(await rowOf(id), { state: 'waiting', error_code: null })
    assert.equal(await snapshot(), before, 'nothing written')
    assert.equal(await aiAuditRows(id), 0, 'no activity row')
  } finally {
    await g.__aiCompiler?.close()
    g.__aiCompiler = previous
  }
  const again = await routes.approve(id)
  assert.equal(again.statusCode, 200, JSON.stringify(again.body))
  const { readPage } = await import('../lib/mdx-admin')
  assert.equal(readPage('now').body.trim(), 'Checked again once the check is back.')
})

test('an image import binds the address the card showed: a stale card is refused, a revoked issuer voids it', async () => {
  // The import itself fetches the remote file at approval: the one step these tests do not run (no network here).
  const id = await propose('propose_media_import', { url: 'https://images.example.com/a/photo.png' })
  const card = await routes.card(id)
  assert.deepEqual(card.body.preview.effects.import, { url: 'https://images.example.com/a/photo.png', host: 'images.example.com' })
  assert.deepEqual(card.body.preview.documents, [])
  assert.equal((await routes.approve(id, 'f'.repeat(64))).body.code, 'STALE_CARD')
  const { getAiDb } = await import('../lib/ai/db')
  const grantId = (getAiDb().prepare('SELECT actor_id FROM ai_changes WHERE id = ?').get(id) as { actor_id: string }).actor_id
  ;(await import('../lib/ai/access')).revokeGrant(grantId, 'test')
  assert.equal((await routes.approve(id)).body.code, 'VOIDED')
})

test('a destructive change needs a recent sign-in to approve; a live one does not', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const store = await import('../lib/contentStore')
  await store.putItem('blog', 'step-up', { title: 'step-up', date: '2026-04-01' }, 'Live.')
  const destructive = await propose('propose_publishing', { collection: 'blog', slug: 'step-up', action: 'unpublish', base_version: await draftVersion('blog', 'step-up') })
  const page = await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')
  const live = await propose('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Live risk.' }, base_version: page.version })
  const sessions = getAuthDb().prepare('SELECT id, verified_at FROM auth_sessions').all() as Array<{ id: string; verified_at: number }>
  getAuthDb().prepare('UPDATE auth_sessions SET verified_at = ?').run(Date.now() - 3 * 3_600_000)
  try {
    const before = await snapshot()
    const refused = await routes.approve(destructive)
    assert.equal(refused.statusCode, 403, JSON.stringify(refused.body))
    assert.equal(refused.body.code, 'STEP_UP_REQUIRED')
    assert.equal((await rowOf(destructive)).state, 'waiting', 'still waiting: nothing was claimed')
    assert.equal(await snapshot(), before)
    assert.equal((await routes.approve(live)).statusCode, 200, 'a live change needs no step-up, like the same action by hand')
  } finally {
    for (const s of sessions) getAuthDb().prepare('UPDATE auth_sessions SET verified_at = ? WHERE id = ?').run(s.verified_at, s.id)
  }
  assert.equal((await routes.approve(destructive)).statusCode, 200, 'after verifying again')
  const { readOne } = await import('../lib/mdx-admin')
  assert.equal(readOne('blog', 'step-up')?.frontmatter.draft, true)
})

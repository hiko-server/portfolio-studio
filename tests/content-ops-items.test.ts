/**
 * F1 — the post / case-study write sequences as services
 * (lib/contentOps/items): discriminated results instead of HTTP answers,
 * page regeneration handed back as `needsRefresh`, editorial events through
 * an injected `notify`, and publish / unpublish built on the same save path
 * as the editor's PUT (their route twin), on a throw-away store.
 *
 * The routes' own behaviour is pinned by the existing suites (the parity
 * net: admin-editorial-*, s1-api, r4-authoring-ifmatch, schedule-publish …).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness, type Handler } from './editorialHarness'

const h = editorialHarness('content-ops-items', 'content-ops-items-secret-0123456789abcdef')
let posts: Handler
let work: Handler
let items: typeof import('../lib/contentOps/items')
let admin: typeof import('../lib/mdx-admin')
let pendingStore: typeof import('../lib/pendingRevisions')

before(async () => {
  await h.setup()
  posts = (await import('../pages/api/admin/posts')).default
  work = (await import('../pages/api/admin/work')).default
  items = await import('../lib/contentOps/items')
  admin = await import('../lib/mdx-admin')
  pendingStore = await import('../lib/pendingRevisions')
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

let client = 0
const ip = () => `127.0.2.${++client % 250}`

async function put(handler: Handler, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const out = await h.call(handler, { method: 'PUT', body, headers, ip: ip() })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  return out
}

const versionOf = (c: 'blog' | 'work', slug: string) => {
  const one = admin.readOne(c, slug)
  assert.ok(one, `${c}/${slug} exists`)
  return admin.itemEtag(one.updatedAt, pendingStore.getPendingRevision(c, slug)?.updatedAt)
}

/** Everything a write could change about one item: its row and its pending revision. */
const stateOf = (c: 'blog' | 'work', slug: string) => ({
  live: admin.readOne(c, slug),
  pending: pendingStore.getPendingRevision(c, slug),
  snapshots: admin.listSnapshots(c, slug).length,
})

test('saveItem answers with a result, never a response: a new item, its refresh handed back', async () => {
  const out = await items.saveItem('blog', { slug: 'svc-new', frontmatter: { title: 'Service post', date: '2026-05-01' }, body: 'Hello.', create: true })
  assert.equal(out.ok, true)
  if (!out.ok || out.target !== 'live') throw new Error('expected a live save')
  assert.deepEqual(out.stored, { ok: true })
  assert.equal(out.etag, versionOf('blog', 'svc-new'))
  assert.deepEqual(out.needsRefresh, { collection: 'blog', slug: 'svc-new', previousKeys: [undefined] })
  assert.equal(admin.readOne('blog', 'svc-new')?.body, 'Hello.')
})

test('saveItem refuses with the admin API’s codes and statuses, writing nothing', async () => {
  await put(posts, { slug: 'svc-refuse', frontmatter: { title: 'Refusals', date: '2026-05-01' }, body: 'Live.', create: true })
  const before = stateOf('blog', 'svc-refuse')
  const bad = async (input: Record<string, unknown>, error: string) => {
    const out = await items.saveItem('blog', input as never)
    assert.deepEqual(out, { ok: false, status: 400, code: 'BAD_REQUEST', error }, JSON.stringify(input))
  }
  await bad({ frontmatter: { title: 'x' } }, 'Missing slug')
  await bad({ slug: 'Bad Slug', frontmatter: { title: 'x' } }, 'Invalid slug (use a-z, 0-9, -, _)')
  await bad({ slug: 'svc-refuse', frontmatter: ['x'] }, 'Missing frontmatter')
  await bad({ slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01' }, target: 'elsewhere' }, 'target must be "live" or "pending"')
  await bad({ slug: 'svc-refuse', frontmatter: { date: '2026-05-01' } }, 'frontmatter.title required')
  await bad({ slug: 'svc-refuse', frontmatter: { title: 'No date' } }, 'frontmatter.date required')
  await bad({ slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01' }, body: 7 }, 'body must be a string')
  // A case study needs no date.
  const study = await items.saveItem('work', { slug: 'svc-study', frontmatter: { title: 'Study' }, body: '', create: true })
  assert.equal(study.ok && study.target, 'live')

  const mdx = await items.saveItem('blog', { slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01' }, body: 'Text <Broken attr="x"\n\nmore' })
  assert.equal(mdx.ok, false)
  if (mdx.ok || mdx.code !== 'MDX_INVALID') throw new Error('expected MDX_INVALID')
  assert.equal(mdx.status, 422)
  assert.equal(mdx.problem.code, 'MDX_INVALID')
  assert.equal(typeof mdx.problem.line, 'number', 'with its position')
  assert.equal(mdx.error, mdx.problem.error)

  const taken = await items.saveItem('blog', { slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01' }, body: '', create: true })
  assert.deepEqual(taken, { ok: false, status: 409, code: 'SLUG_EXISTS', error: 'A post with this slug already exists' })
  const stale = await items.saveItem('blog', { slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01' }, body: '', ifMatch: '"1"' })
  assert.deepEqual(stale, { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'This was changed elsewhere since you loaded it', etag: versionOf('blog', 'svc-refuse') })
  const unpublishPending = await items.saveItem('blog', { slug: 'svc-refuse', frontmatter: { title: 'x', date: '2026-05-01', draft: true }, body: '', target: 'pending' })
  assert.deepEqual(unpublishPending, { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Unpublishing is a direct save (target "live")' })
  assert.deepEqual(stateOf('blog', 'svc-refuse'), before, 'nothing was written')
})

test('saveItem: a draft cannot hold pending changes (NOT_PUBLISHED); "Publish changes" notifies once', async () => {
  await put(posts, { slug: 'svc-draft', frontmatter: { title: 'Draft', date: '2026-05-01', draft: true }, body: 'Draft.', create: true })
  const refused = await items.saveItem('blog', { slug: 'svc-draft', frontmatter: { title: 'Draft', date: '2026-05-01' }, body: 'x', target: 'pending' })
  assert.deepEqual(refused, { ok: false, status: 409, code: 'NOT_PUBLISHED', error: 'This post is not published — save it directly' })

  await put(posts, { slug: 'svc-live', frontmatter: { title: 'Live', date: '2026-05-01' }, body: 'Live.', create: true })
  const pend = await items.saveItem('blog', { slug: 'svc-live', frontmatter: { title: 'Live 2', date: '2026-05-01' }, body: 'Changed.', target: 'pending', ifMatch: versionOf('blog', 'svc-live') })
  assert.equal(pend.ok && pend.target, 'pending')
  assert.equal(admin.readOne('blog', 'svc-live')?.body, 'Live.', 'the public row is unchanged')
  const events: unknown[] = []
  const live = await items.saveItem(
    'blog',
    { slug: 'svc-live', frontmatter: { title: 'Live 2', date: '2026-05-01', updated: '2026-05-02' }, body: 'Changed.', target: 'live', ifMatch: versionOf('blog', 'svc-live') },
    { notify: (e) => events.push(e) },
  )
  assert.equal(live.ok && live.target, 'live')
  assert.deepEqual(events, [{ action: 'publish-changes', collection: 'blog', slug: 'svc-live', markedUpdated: true }])
  assert.equal(pendingStore.getPendingRevision('blog', 'svc-live'), null)
})

test('publishItem: a draft goes live exactly as its route twin (the editor’s Publish) leaves it', async () => {
  const fm = { title: 'Twin', date: '2026-05-01', tags: ['a'], draft: true, seoTitle: 'Kept' }
  await put(posts, { slug: 'twin-route', frontmatter: fm, body: 'Same body.', create: true })
  await put(posts, { slug: 'twin-svc', frontmatter: fm, body: 'Same body.', create: true })

  // The route twin: the editor sends the stored frontmatter without `draft` (itemFrontmatter toServer) and its version.
  const loaded = await h.call(posts, { query: { slug: 'twin-route' } })
  const { draft: _draft, ...published } = loaded.body.frontmatter
  void _draft
  const viaRoute = await put(posts, { slug: 'twin-route', frontmatter: published, body: loaded.body.body }, { 'if-match': loaded.headers.etag })

  assert.deepEqual(await items.publishItem('blog', 'twin-svc', { version: '' }), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'The version of the item is required' })
  const stale = await items.publishItem('blog', 'twin-svc', { version: '"1"' })
  assert.equal(!stale.ok && stale.code, 'VERSION_CONFLICT')
  assert.equal(admin.readOne('blog', 'twin-svc')?.frontmatter.draft, true, 'a stale version publishes nothing')

  const out = await items.publishItem('blog', 'twin-svc', { version: versionOf('blog', 'twin-svc') })
  if (!out.ok || out.target !== 'live') throw new Error(JSON.stringify(out))
  const a = admin.readOne('blog', 'twin-route')
  const b = admin.readOne('blog', 'twin-svc')
  assert.deepEqual(b?.frontmatter, a?.frontmatter)
  assert.equal(b?.body, a?.body)
  assert.equal('draft' in (b?.frontmatter ?? {}), false)
  assert.equal(admin.listSnapshots('blog', 'twin-svc').length, admin.listSnapshots('blog', 'twin-route').length)
  // Same regeneration as the route's answer (the item's own address aside).
  const { refreshCollection } = await import('../lib/contentOps/refresh')
  const revalidated: string[] = []
  const res = { revalidate: async (p: string) => void revalidated.push(p) } as never
  const refreshed = await refreshCollection(res, out.needsRefresh.collection, out.needsRefresh.slug, out.needsRefresh.previousKeys)
  const neutral = (paths: string[]) => paths.map((p) => p.replace(/twin-(route|svc)/, 'twin')).sort()
  assert.deepEqual(neutral(refreshed.revalidated), neutral(viaRoute.body.revalidated))
  assert.deepEqual(neutral(revalidated), neutral(viaRoute.body.revalidated))

  const nothing = await items.publishItem('blog', 'twin-svc', { version: versionOf('blog', 'twin-svc') })
  assert.deepEqual(nothing, { ok: false, status: 409, code: 'NOTHING_TO_PUBLISH', error: 'This post is live and has no saved changes — there is nothing to publish.' })
  assert.deepEqual(await items.publishItem('blog', 'no-such-post', { version: '"0"' }), { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' })
})

test('publishItem: pending changes go live (marked updated on request), the revision is dropped, the event fires', async () => {
  await put(posts, { slug: 'svc-changes', frontmatter: { title: 'Changes', date: '2026-05-01', updated: '2026-05-01' }, body: 'Old.', create: true })
  await put(posts, { slug: 'svc-changes', frontmatter: { title: 'Changes v2', date: '2026-05-01', updated: '2026-05-01' }, body: 'New.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-changes') })
  const now = Date.UTC(2026, 9, 25, 20, 0) // 26 Oct in Hong Kong
  const events: unknown[] = []
  const out = await items.publishItem('blog', 'svc-changes', { version: versionOf('blog', 'svc-changes'), markUpdated: true }, { notify: (e) => events.push(e), now: () => now })
  assert.equal(out.ok && out.target, 'live')
  const stored = admin.readOne('blog', 'svc-changes')
  assert.equal(stored?.body, 'New.')
  assert.equal(stored?.frontmatter.title, 'Changes v2')
  assert.equal(stored?.frontmatter.updated, '2026-10-26', 'the site’s day (Hong Kong)')
  assert.equal(pendingStore.getPendingRevision('blog', 'svc-changes'), null)
  assert.deepEqual(events, [{ action: 'publish-changes', collection: 'blog', slug: 'svc-changes', markedUpdated: true }])

  // A case study has no `updated`: markUpdated changes nothing there.
  await put(work, { slug: 'svc-study-2', frontmatter: { title: 'Study' }, body: 'Old.', create: true })
  await put(work, { slug: 'svc-study-2', frontmatter: { title: 'Study' }, body: 'New.', target: 'pending' }, { 'if-match': versionOf('work', 'svc-study-2') })
  const study = await items.publishItem('work', 'svc-study-2', { version: versionOf('work', 'svc-study-2'), markUpdated: true })
  assert.equal(study.ok, true)
  assert.equal(admin.readOne('work', 'svc-study-2')?.frontmatter.updated, undefined)
})

test('unpublishItem: what the editor shows (the pending revision) becomes the draft; the schedule ends', async () => {
  await put(posts, { slug: 'svc-down', frontmatter: { title: 'Down', date: '2026-05-01' }, body: 'Live.', create: true })
  const { applySchedule } = await import('../lib/schedule/store')
  const later = Date.now() + 86_400_000
  assert.equal((await applySchedule('blog', 'svc-down', { publishAt: null, unpublishAt: later })).ok, true)
  await put(posts, { slug: 'svc-down', frontmatter: { title: 'Down v2', date: '2026-05-01' }, body: 'Pending.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-down') })
  assert.deepEqual(await items.unpublishItem('blog', 'svc-down', { version: '' }), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'The version of the item is required' })
  const out = await items.unpublishItem('blog', 'svc-down', { version: versionOf('blog', 'svc-down') })
  assert.equal(out.ok && out.target, 'live')
  const stored = admin.readOne('blog', 'svc-down')
  assert.equal(stored?.frontmatter.draft, true)
  assert.equal(stored?.frontmatter.title, 'Down v2')
  assert.equal(stored?.body, 'Pending.')
  assert.equal(stored?.frontmatter.unpublishAt, undefined, 'unpublished by hand: the schedule ends')
  assert.equal(pendingStore.getPendingRevision('blog', 'svc-down'), null)
  assert.deepEqual(await items.unpublishItem('blog', 'svc-down', { version: versionOf('blog', 'svc-down') }), { ok: false, status: 409, code: 'NOT_PUBLISHED', error: 'This post is not published' })
})

test('discardPending: version-checked; reports whether there was anything; notifies only then', async () => {
  await put(posts, { slug: 'svc-discard', frontmatter: { title: 'Discard', date: '2026-05-01' }, body: 'Live.', create: true })
  const events: unknown[] = []
  const notify = (e: unknown) => events.push(e)
  const none = items.discardPending('blog', 'svc-discard', { ifMatch: versionOf('blog', 'svc-discard') }, { notify })
  assert.deepEqual(none, { ok: true, discarded: false, etag: versionOf('blog', 'svc-discard') })
  assert.deepEqual(events, [])
  await put(posts, { slug: 'svc-discard', frontmatter: { title: 'Discard v2', date: '2026-05-01' }, body: 'Pending.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-discard') })
  const stale = items.discardPending('blog', 'svc-discard', { ifMatch: `"${admin.readOne('blog', 'svc-discard')?.updatedAt}"` }, { notify })
  assert.equal(!stale.ok && stale.code, 'VERSION_CONFLICT')
  assert.ok(pendingStore.getPendingRevision('blog', 'svc-discard'), 'kept on a conflict')
  const out = items.discardPending('blog', 'svc-discard', { ifMatch: versionOf('blog', 'svc-discard') }, { notify })
  assert.deepEqual(out, { ok: true, discarded: true, etag: `"${admin.readOne('blog', 'svc-discard')?.updatedAt}"` })
  assert.deepEqual(events, [{ action: 'discard-changes', collection: 'blog', slug: 'svc-discard' }])
  assert.deepEqual(items.discardPending('blog', 'nope-nope'), { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' })
  assert.deepEqual(items.discardPending('blog', '../x'), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Invalid slug' })
})

test('deleteItem: history kept, pending dropped, review links of every address ended; the refresh carries the old key', async () => {
  await put(posts, { slug: 'svc-delete', frontmatter: { title: 'Delete me', date: '2026-05-01', translationKey: 'pair' }, body: 'Live.', create: true })
  await put(posts, { slug: 'svc-delete', frontmatter: { title: 'Pending', date: '2026-05-01', translationKey: 'pair' }, body: 'P.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-delete') })
  const { createReviewLink, listReviewLinks } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'svc-delete', variant: 'changes', ttlHours: 24 }).ok, true)

  assert.deepEqual(await items.deleteItem('blog', ''), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Missing slug' })
  assert.deepEqual(await items.deleteItem('blog', '../etc'), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Invalid slug' })
  assert.deepEqual(await items.deleteItem('blog', 'never-was'), { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' })
  const stale = await items.deleteItem('blog', 'svc-delete', { version: '"1"' })
  assert.equal(!stale.ok && stale.code, 'VERSION_CONFLICT')
  assert.ok(admin.readOne('blog', 'svc-delete'), 'a stale version deletes nothing')

  const out = await items.deleteItem('blog', 'svc-delete', { version: versionOf('blog', 'svc-delete') })
  if (!out.ok) throw new Error(JSON.stringify(out))
  assert.match(String(out.deleted.snapshot), /^svc-delete_\d{4}-/)
  assert.deepEqual(out.needsRefresh, { collection: 'blog', slug: 'svc-delete', previousKeys: ['pair'] })
  assert.equal(admin.readOne('blog', 'svc-delete'), null)
  assert.equal(pendingStore.getPendingRevision('blog', 'svc-delete'), null)
  assert.deepEqual(listReviewLinks({ collection: 'blog', slugs: ['svc-delete'] }), [], 'no active link left')
  assert.ok(admin.listDeleted('blog').some((d) => d.slug === 'svc-delete'), 'restorable from "Recently deleted"')
})

test('the route maps every result to today’s answer: DELETE through the route and the service agree', async () => {
  await put(posts, { slug: 'svc-route-del', frontmatter: { title: 'Route delete', date: '2026-05-01' }, body: 'x', create: true })
  // The harness session signed in just now, so the route's step-up check passes.
  const del = await h.call(posts, { method: 'DELETE', query: { slug: 'svc-route-del' }, ip: ip() })
  assert.equal(del.statusCode, 200, JSON.stringify(del.body))
  assert.equal(del.body.ok, true)
  assert.match(del.body.snapshot, /^svc-route-del_/)
  assert.ok(del.body.revalidated.includes('/blog/svc-route-del'))
  const missing = await h.call(posts, { method: 'DELETE', query: { slug: 'svc-route-del' }, ip: ip() })
  assert.deepEqual([missing.statusCode, missing.body], [404, { error: 'Not found' }])
  const unsafe = await h.call(posts, { method: 'DELETE', query: { slug: '../x' }, ip: ip() })
  assert.deepEqual([unsafe.statusCode, unsafe.body], [400, { error: 'Invalid slug' }])
  const none = await h.call(posts, { method: 'DELETE', query: {}, ip: ip() })
  assert.deepEqual([none.statusCode, none.body], [400, { error: 'Missing slug' }])
})

test('publish, unpublish, discard and delete act on one exact version: "*" and lists are refused, nothing written', async () => {
  // If-Match semantics (the admin routes' header) let "*" match any version and a list any of several; an action that
  // must act on exactly what its caller saw cannot accept either (what goes live is exactly what was read).
  await put(posts, { slug: 'svc-exact', frontmatter: { title: 'Exact', date: '2026-05-01', draft: true }, body: 'Draft.', create: true })
  await put(posts, { slug: 'svc-exact-live', frontmatter: { title: 'Exact live', date: '2026-05-01' }, body: 'Live.', create: true })
  await put(posts, { slug: 'svc-exact-live', frontmatter: { title: 'Exact live', date: '2026-05-01' }, body: 'Pending.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-exact-live') })
  const draftBefore = stateOf('blog', 'svc-exact')
  const liveBefore = stateOf('blog', 'svc-exact-live')
  const current = versionOf('blog', 'svc-exact-live')
  const refused = { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Name exactly one version of the item, as it was read ("*" and lists are refused)' }
  for (const version of ['*', ' * ', `${current}, "1"`, `"1", ${current}`, `${current},${current}`, 'W/' + current, '"abc"', '"1.2.3"']) {
    assert.deepEqual(await items.publishItem('blog', 'svc-exact', { version }), refused, `publish ${version}`)
    assert.deepEqual(await items.publishItem('blog', 'svc-exact-live', { version }), refused, `publish changes ${version}`)
    assert.deepEqual(await items.unpublishItem('blog', 'svc-exact-live', { version }), refused, `unpublish ${version}`)
    assert.deepEqual(items.discardPending('blog', 'svc-exact-live', { version }), refused, `discard ${version}`)
    assert.deepEqual(await items.deleteItem('blog', 'svc-exact-live', { version }), refused, `delete ${version}`)
  }
  assert.deepEqual(items.discardPending('blog', 'svc-exact-live', { version: ' ' }), { ok: false, status: 400, code: 'BAD_REQUEST', error: 'The version of the item is required' })
  assert.deepEqual(stateOf('blog', 'svc-exact'), draftBefore, 'the draft is as it was')
  assert.deepEqual(stateOf('blog', 'svc-exact-live'), liveBefore, 'the live item and its pending revision are as they were')

  // One exact version, with or without its quotes, still acts.
  const discarded = items.discardPending('blog', 'svc-exact-live', { version: current.replace(/"/g, '') })
  assert.equal(discarded.ok && discarded.discarded, true)
  const published = await items.publishItem('blog', 'svc-exact', { version: versionOf('blog', 'svc-exact') })
  assert.equal(published.ok && published.target, 'live')
  const deleted = await items.deleteItem('blog', 'svc-exact', { version: versionOf('blog', 'svc-exact').replace(/"/g, '') })
  assert.equal(deleted.ok, true)

  // The admin routes keep their If-Match header semantics: "*" still discards through the route.
  await put(posts, { slug: 'svc-exact-live', frontmatter: { title: 'Exact live', date: '2026-05-01' }, body: 'Pending again.', target: 'pending' }, { 'if-match': versionOf('blog', 'svc-exact-live') })
  const viaRoute = await h.call(posts, { method: 'POST', body: { slug: 'svc-exact-live', action: 'discard-pending' }, headers: { 'if-match': '*' }, ip: ip() })
  assert.equal(viaRoute.statusCode, 200, JSON.stringify(viaRoute.body))
  assert.equal(pendingStore.getPendingRevision('blog', 'svc-exact-live'), null)
})

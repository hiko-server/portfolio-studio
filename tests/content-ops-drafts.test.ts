/**
 * F1 — draft-safe writes (lib/contentOps/drafts): a new draft, an edit of a
 * draft, an edit of a live item as its pending revision. Nothing a visitor
 * or a review-link holder can see changes; a new draft never takes over an
 * address that redirects, has active review links or holds a deleted item;
 * scheduled and shared items are held; the version is mandatory. On a
 * throw-away store.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness, type Handler } from './editorialHarness'

const h = editorialHarness('content-ops-drafts', 'content-ops-drafts-secret-0123456789abcdef')
let posts: Handler
let drafts: typeof import('../lib/contentOps/drafts')
let admin: typeof import('../lib/mdx-admin')
let pendingStore: typeof import('../lib/pendingRevisions')
let review: typeof import('../lib/review/store')

before(async () => {
  await h.setup()
  posts = (await import('../pages/api/admin/posts')).default
  drafts = await import('../lib/contentOps/drafts')
  admin = await import('../lib/mdx-admin')
  pendingStore = await import('../lib/pendingRevisions')
  review = await import('../lib/review/store')
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

let client = 0
async function put(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const out = await h.call(posts, { method: 'PUT', body, headers, ip: `127.0.3.${++client % 250}` })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  return out
}

const versionOf = (slug: string) => {
  const one = admin.readOne('blog', slug)
  assert.ok(one, `blog/${slug} exists`)
  return admin.itemEtag(one.updatedAt, pendingStore.getPendingRevision('blog', slug)?.updatedAt)
}
const stateOf = (slug: string) => ({
  live: admin.readOne('blog', slug),
  pending: pendingStore.getPendingRevision('blog', slug),
  snapshots: admin.listSnapshots('blog', slug).length,
})

test('createDraftItem: always a draft, never scheduled; the public readers do not list it', async () => {
  const out = await drafts.createDraftItem('blog', {
    slug: 'ai-new',
    frontmatter: { title: 'New draft', date: '2026-05-01', draft: false, publishAt: '2030-01-01T00:00:00Z', unpublishAt: '2031-01-01T00:00:00Z', tags: ['x'] },
    body: 'Words.',
  })
  assert.deepEqual(out, { ok: true, target: 'draft', version: versionOf('ai-new'), changed: true })
  const stored = admin.readOne('blog', 'ai-new')
  assert.deepEqual(stored?.frontmatter, { title: 'New draft', date: '2026-05-01', draft: true, tags: ['x'] })
  const { listPosts } = await import('../lib/mdx')
  assert.equal(listPosts().some((p) => p.slug === 'ai-new'), false)

  assert.deepEqual(await drafts.createDraftItem('blog', { slug: 'ai-new', frontmatter: { title: 'Again', date: '2026-05-01' }, body: '' }), {
    ok: false,
    code: 'SLUG_EXISTS',
    error: 'A post with this slug already exists',
  })
  const invalid = async (input: Record<string, unknown>, error: string) =>
    assert.deepEqual(await drafts.createDraftItem('blog', input as never), { ok: false, code: 'INVALID_INPUT', error })
  await invalid({ slug: 'Bad Slug', frontmatter: { title: 'x', date: '2026-05-01' }, body: '' }, 'slug must use a-z, 0-9, - and _ and start with a letter or digit')
  await invalid({ slug: 'ok-slug', frontmatter: ['x'], body: '' }, 'frontmatter must be an object')
  await invalid({ slug: 'ok-slug', frontmatter: { title: 'x', date: '2026-05-01' }, body: 4 }, 'body must be text')
  await invalid({ slug: 'ok-slug', frontmatter: { date: '2026-05-01' }, body: '' }, 'frontmatter.title is required')
  // Only spaces is no title: the editor's "Add a title" check would block publishing it.
  await invalid({ slug: 'ok-slug', frontmatter: { title: ' \t ', date: '2026-05-01' }, body: '' }, 'frontmatter.title is required')
  await invalid({ slug: 'ok-slug', frontmatter: { title: 'x' }, body: '' }, 'frontmatter.date is required')
  await invalid({ slug: 'ok-slug', frontmatter: JSON.parse('{"title":"x","date":"2026-05-01","__proto__":{"draft":false}}'), body: '' }, 'frontmatter cannot have a key named __proto__')
  assert.equal(admin.readOne('blog', 'ok-slug'), null)
  const study = await drafts.createDraftItem('work', { slug: 'ai-study', frontmatter: { title: 'A study' }, body: '' })
  assert.equal(study.ok, true, 'a case study needs no date')
})

test('createDraftItem refuses a redirecting address: the 308 stays, nothing is written', async () => {
  await put({ slug: 'moved-from', frontmatter: { title: 'Moved', date: '2026-05-01' }, body: 'x', create: true })
  const rename = await h.call(posts, { method: 'POST', body: { action: 'rename', slug: 'moved-from', to: 'moved-to' }, ip: '127.0.3.251' })
  assert.equal(rename.statusCode, 200, JSON.stringify(rename.body))
  const { redirectTarget } = await import('../lib/redirects')
  assert.equal(redirectTarget('blog', 'moved-from'), 'moved-to')
  const out = await drafts.createDraftItem('blog', { slug: 'moved-from', frontmatter: { title: 'Squatter', date: '2026-05-01' }, body: '' })
  assert.deepEqual(out, { ok: false, code: 'SLUG_RESERVED', reason: 'redirect', error: 'This address still redirects to another item; pick another slug' })
  assert.equal(redirectTarget('blog', 'moved-from'), 'moved-to', 'the old address still redirects')
  assert.equal(admin.readOne('blog', 'moved-from'), null)
})

test('createDraftItem refuses an address with active review links, and leaves them on', async () => {
  // A link made for an item whose row is gone without the delete path (which would end its links).
  await put({ slug: 'shared-gone', frontmatter: { title: 'Shared', date: '2026-05-01', draft: true }, body: 'x', create: true })
  assert.equal(review.createReviewLink({ collection: 'blog', slug: 'shared-gone', variant: 'draft', ttlHours: 24 }).ok, true)
  const { removeItem } = await import('../lib/contentStore')
  assert.equal((await removeItem('blog', 'shared-gone')).ok, true)
  assert.equal(admin.hasItemSnapshots('blog', 'shared-gone'), false)
  const out = await drafts.createDraftItem('blog', { slug: 'shared-gone', frontmatter: { title: 'Squatter', date: '2026-05-01' }, body: '' })
  assert.deepEqual(out, { ok: false, code: 'SLUG_RESERVED', reason: 'review_link', error: 'Review links are active at this address; pick another slug' })
  assert.equal(review.listReviewLinks({ collection: 'blog', slugs: ['shared-gone'] }).length, 1, 'the link is still active')
  assert.equal(admin.readOne('blog', 'shared-gone'), null)
})

test('createDraftItem refuses a deleted item’s address (it can still be restored there)', async () => {
  await put({ slug: 'was-here', frontmatter: { title: 'Deleted', date: '2026-05-01' }, body: 'x', create: true })
  assert.equal((await admin.deleteOne('blog', 'was-here')).ok, true)
  assert.ok(admin.listDeleted('blog').some((d) => d.slug === 'was-here'))
  const out = await drafts.createDraftItem('blog', { slug: 'was-here', frontmatter: { title: 'Squatter', date: '2026-05-01' }, body: '' })
  assert.deepEqual(out, { ok: false, code: 'SLUG_RESERVED', reason: 'deleted', error: 'A deleted item can still be restored at this address; pick another slug' })
  assert.equal(admin.readOne('blog', 'was-here'), null)
})

test('saveDraftEdit on a draft: merged into the stored row, still a draft; the version is mandatory and checked', async () => {
  await put({ slug: 'ai-draft', frontmatter: { title: 'Draft', date: '2026-05-01', draft: true, seoTitle: 'Kept', coverAlt: 'Old alt' }, body: 'Body one.', create: true })
  const v1 = versionOf('ai-draft')
  assert.deepEqual(await drafts.saveDraftEdit('blog', { slug: 'ai-draft', baseVersion: '', body: 'x' }), { ok: false, code: 'INVALID_INPUT', error: 'base_version is required: read the item first' })
  const stale = await drafts.saveDraftEdit('blog', { slug: 'ai-draft', baseVersion: '"1"', body: 'x' })
  assert.deepEqual(stale, { ok: false, code: 'VERSION_CONFLICT', error: 'The item changed since that version was read: read it again', version: v1 })

  const out = await drafts.saveDraftEdit('blog', { slug: 'ai-draft', baseVersion: v1.replace(/"/g, ''), frontmatterPatch: { title: 'Draft, edited' }, removeFrontmatter: ['coverAlt'] })
  assert.deepEqual(out, { ok: true, target: 'draft', version: versionOf('ai-draft'), changed: true })
  const stored = admin.readOne('blog', 'ai-draft')
  assert.deepEqual(stored?.frontmatter, { title: 'Draft, edited', date: '2026-05-01', draft: true, seoTitle: 'Kept' })
  assert.equal(stored?.body, 'Body one.', 'no body given: the stored one stays')

  // The same edit again changes nothing: no write, no new version, no history entry.
  const snapshots = admin.listSnapshots('blog', 'ai-draft').length
  const again = await drafts.saveDraftEdit('blog', { slug: 'ai-draft', baseVersion: versionOf('ai-draft'), frontmatterPatch: { title: 'Draft, edited' } })
  assert.deepEqual(again, { ok: true, target: 'draft', version: versionOf('ai-draft'), changed: false })
  assert.equal(admin.listSnapshots('blog', 'ai-draft').length, snapshots)
})

test('saveDraftEdit refuses what only the owner sets: the published state, the schedule, prototype keys, a missing or blank title', async () => {
  await put({ slug: 'ai-owned', frontmatter: { title: 'Owned', date: '2026-05-01', draft: true }, body: 'x', create: true })
  const before = JSON.stringify(admin.readOne('blog', 'ai-owned'))
  const v = versionOf('ai-owned')
  const refused = async (edit: Record<string, unknown>, error: string) =>
    assert.deepEqual(await drafts.saveDraftEdit('blog', { slug: 'ai-owned', baseVersion: v, ...edit } as never), { ok: false, code: 'INVALID_INPUT', error }, JSON.stringify(edit))
  await refused({ frontmatterPatch: { draft: false } }, 'draft cannot be edited: publishing and scheduling are separate actions')
  await refused({ removeFrontmatter: ['draft'] }, 'draft cannot be edited: publishing and scheduling are separate actions')
  await refused({ frontmatterPatch: { publishAt: '2030-01-01T00:00:00Z' } }, 'publishAt cannot be edited: publishing and scheduling are separate actions')
  await refused({ removeFrontmatter: ['unpublishAt'] }, 'unpublishAt cannot be edited: publishing and scheduling are separate actions')
  await refused({ frontmatterPatch: JSON.parse('{"__proto__":{"draft":false}}') }, 'frontmatter cannot have a key named __proto__')
  await refused({ removeFrontmatter: ['title'] }, 'frontmatter.title is required')
  await refused({ frontmatterPatch: { title: '   ' } }, 'frontmatter.title is required')
  await refused({}, 'Nothing to change: send a body or frontmatter changes')
  await refused({ body: 5 }, 'body must be text')
  await refused({ frontmatterPatch: [] }, 'frontmatter_patch must be an object')
  await refused({ removeFrontmatter: [1] }, 'remove_frontmatter must be a list of keys')
  assert.equal(JSON.stringify(admin.readOne('blog', 'ai-owned')), before, 'nothing was written')
  assert.deepEqual(await drafts.saveDraftEdit('blog', { slug: 'no-such', baseVersion: '"1"', body: 'x' }), { ok: false, code: 'NOT_FOUND', error: 'No such post' })
  assert.deepEqual(await drafts.saveDraftEdit('blog', { slug: '../x', baseVersion: '"1"', body: 'x' }), { ok: false, code: 'NOT_FOUND', error: 'No such post' })
})

test('saveDraftEdit on a live item: a pending revision; the public row stays byte-identical; edits stack on the pending one', async () => {
  await put({ slug: 'ai-live', frontmatter: { title: 'Live', date: '2026-05-01', tags: ['a'] }, body: 'Published body.', create: true })
  const live = JSON.stringify(admin.readOne('blog', 'ai-live'))
  const first = await drafts.saveDraftEdit('blog', { slug: 'ai-live', baseVersion: versionOf('ai-live'), body: 'Edited body.' })
  assert.deepEqual(first, { ok: true, target: 'pending', version: versionOf('ai-live'), changed: true })
  assert.equal(JSON.stringify(admin.readOne('blog', 'ai-live')), live, 'the live row is untouched')
  const rev = pendingStore.getPendingRevision('blog', 'ai-live')
  assert.equal(rev?.body, 'Edited body.')
  assert.deepEqual(rev?.frontmatter, { title: 'Live', date: '2026-05-01', tags: ['a'] })
  assert.equal(rev?.baseUpdatedAt, admin.readOne('blog', 'ai-live')?.updatedAt)

  // The next edit applies to what the editor shows: the pending revision.
  const second = await drafts.saveDraftEdit('blog', { slug: 'ai-live', baseVersion: versionOf('ai-live'), frontmatterPatch: { tags: ['a', 'b'] } })
  assert.equal(second.ok && second.target, 'pending')
  const rev2 = pendingStore.getPendingRevision('blog', 'ai-live')
  assert.equal(rev2?.body, 'Edited body.')
  assert.deepEqual(rev2?.frontmatter.tags, ['a', 'b'])
  assert.equal(JSON.stringify(admin.readOne('blog', 'ai-live')), live)
  const { getPost } = await import('../lib/mdx')
  assert.match(JSON.stringify((await getPost('ai-live'))?.frontmatter), /"tags":\["a"\]/, 'visitors still read the published version')

  // A no-op edit of a live item without pending changes stores no revision.
  await put({ slug: 'ai-live-2', frontmatter: { title: 'Live 2', date: '2026-05-01', draft: false }, body: 'Same.', create: true })
  const noop = await drafts.saveDraftEdit('blog', { slug: 'ai-live-2', baseVersion: versionOf('ai-live-2'), body: 'Same.' })
  assert.deepEqual(noop, { ok: true, target: 'pending', version: versionOf('ai-live-2'), changed: false })
  assert.equal(pendingStore.getPendingRevision('blog', 'ai-live-2'), null)
  const real = await drafts.saveDraftEdit('blog', { slug: 'ai-live-2', baseVersion: versionOf('ai-live-2'), body: 'Different.' })
  assert.equal(real.ok && real.changed, true)
  assert.equal(pendingStore.getPendingRevision('blog', 'ai-live-2')?.frontmatter.draft, false, 'the published state is the live row’s')
})

test('heldReason: scheduled drafts and scheduled changes; active review links (counted, never their addresses)', async () => {
  const { applySchedule } = await import('../lib/schedule/store')
  const at = Date.now() + 3 * 86_400_000
  await put({ slug: 'held-draft', frontmatter: { title: 'Held', date: '2026-05-01', draft: true }, body: 'x', create: true })
  assert.equal(drafts.heldReason('blog', 'held-draft'), null)
  assert.equal((await applySchedule('blog', 'held-draft', { publishAt: at, unpublishAt: null })).ok, true)
  assert.deepEqual(drafts.heldReason('blog', 'held-draft'), { code: 'ITEM_SCHEDULED', publishAt: at })

  await put({ slug: 'held-changes', frontmatter: { title: 'Held changes', date: '2026-05-01' }, body: 'Live.', create: true })
  await put({ slug: 'held-changes', frontmatter: { title: 'Held changes', date: '2026-05-01' }, body: 'Pending.', target: 'pending' }, { 'if-match': versionOf('held-changes') })
  assert.equal(drafts.heldReason('blog', 'held-changes'), null)
  assert.equal((await applySchedule('blog', 'held-changes', { publishAt: at, unpublishAt: null })).ok, true)
  assert.deepEqual(drafts.heldReason('blog', 'held-changes'), { code: 'ITEM_SCHEDULED', publishAt: at })

  // Only a scheduled publish holds an item: an unpublish time alone does not (the edit stays pending).
  await put({ slug: 'ends-later', frontmatter: { title: 'Ends', date: '2026-05-01' }, body: 'x', create: true })
  assert.equal((await applySchedule('blog', 'ends-later', { publishAt: null, unpublishAt: at })).ok, true)
  assert.equal(drafts.heldReason('blog', 'ends-later'), null)

  await put({ slug: 'held-shared', frontmatter: { title: 'Shared', date: '2026-05-01', draft: true }, body: 'x', create: true })
  const a = review.createReviewLink({ collection: 'blog', slug: 'held-shared', variant: 'draft', ttlHours: 24 })
  const b = review.createReviewLink({ collection: 'blog', slug: 'held-shared', variant: 'draft', ttlHours: 24 })
  assert.ok(a.ok && b.ok)
  assert.deepEqual(drafts.heldReason('blog', 'held-shared'), { code: 'ITEM_IN_REVIEW', activeLinks: 2 })
  review.revokeReviewLink(a.link.id)
  assert.deepEqual(drafts.heldReason('blog', 'held-shared'), { code: 'ITEM_IN_REVIEW', activeLinks: 1 })
  assert.equal(drafts.heldReason('blog', 'held-shared', b.link.expiresAt + 1), null, 'an expired link holds nothing')
})

test('saveDraftEdit on a held item: refused and nothing written; with the owner’s approval it saves and keeps the schedule', async () => {
  const draftState = JSON.stringify(stateOf('held-draft'))
  const scheduled = await drafts.saveDraftEdit('blog', { slug: 'held-draft', baseVersion: versionOf('held-draft'), body: 'Sneaky.' })
  assert.equal(!scheduled.ok && scheduled.code, 'ITEM_SCHEDULED')
  assert.match(!scheduled.ok ? scheduled.error : '', /scheduled to go live/)
  assert.equal(JSON.stringify(stateOf('held-draft')), draftState)

  const changesState = JSON.stringify(stateOf('held-changes'))
  const changes = await drafts.saveDraftEdit('blog', { slug: 'held-changes', baseVersion: versionOf('held-changes'), body: 'Sneaky.' })
  assert.equal(!changes.ok && changes.code, 'ITEM_SCHEDULED')
  assert.equal(JSON.stringify(stateOf('held-changes')), changesState)

  const sharedState = JSON.stringify(stateOf('held-shared'))
  const shared = await drafts.saveDraftEdit('blog', { slug: 'held-shared', baseVersion: versionOf('held-shared'), body: 'Sneaky.' })
  assert.deepEqual(shared, { ok: false, code: 'ITEM_IN_REVIEW', activeLinks: 1, error: "Active review links show this post: changing it needs the owner's approval" })
  assert.equal(JSON.stringify(stateOf('held-shared')), sharedState)

  // Approved by the owner: the same path writes, and the schedule is kept on both kinds of row.
  const publishAt = admin.readOne('blog', 'held-draft')?.frontmatter.publishAt
  const approved = await drafts.saveDraftEdit('blog', { slug: 'held-draft', baseVersion: versionOf('held-draft'), body: 'Approved.' }, { allowHeld: true })
  assert.equal(approved.ok && approved.target, 'draft')
  assert.equal(admin.readOne('blog', 'held-draft')?.body, 'Approved.')
  assert.equal(admin.readOne('blog', 'held-draft')?.frontmatter.publishAt, publishAt)
  const pendingAt = pendingStore.getPendingRevision('blog', 'held-changes')?.frontmatter.publishAt
  const approvedChanges = await drafts.saveDraftEdit('blog', { slug: 'held-changes', baseVersion: versionOf('held-changes'), body: 'Approved changes.' }, { allowHeld: true })
  assert.equal(approvedChanges.ok && approvedChanges.target, 'pending')
  assert.equal(pendingStore.getPendingRevision('blog', 'held-changes')?.body, 'Approved changes.')
  assert.equal(pendingStore.getPendingRevision('blog', 'held-changes')?.frontmatter.publishAt, pendingAt)
})

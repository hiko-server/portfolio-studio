/**
 * M3 — an approved AI change does what the owner's own action does (design
 * §2, §5.6, §12.1 ai-apply-parity): for each kind with a route twin, the same
 * input through the admin route and through an approved proposal gives the
 * same stored state, the same history snapshots, the same regenerated pages
 * and the same activity action. Twin items (one for the route, one for the
 * proposal) stand in for "the same input" where an item is the target; the
 * home page, the CV and the pages are reset between the two runs.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness, type Handler } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-apply-parity', 'ai-apply-parity-secret-0123456789abcdef0123456789')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>
let admin: typeof import('../lib/mdx-admin')
let pend: typeof import('../lib/pendingRevisions')
let posts: Handler
const DAY = 86_400_000
let ip = 0
const nextIp = () => `127.1.${Math.floor(++ip / 200)}.${(ip % 200) + 20}`

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

before(async () => {
  await h.setup()
  admin = await import('../lib/mdx-admin')
  pend = await import('../lib/pendingRevisions')
  posts = (await import('../pages/api/admin/posts')).default as Handler
  const w = await storeWriters()
  for (const twin of ['r', 'a']) {
    await w.item('blog', `draft-${twin}`, { title: 'A draft', date: '2026-05-01', draft: true }, 'Draft text.')
    for (const s of ['live', 'unpub', 'sched', 'disc', 'restore', 'del', 'fix', 'alt', 'tag']) {
      const body = s === 'fix' ? 'See [the docs](https://moved.example.com/d).' : s === 'alt' ? `![](/uploads/alt-${twin}.webp)` : `Text of ${s}.`
      await w.item('blog', `${s}-${twin}`, { title: `Post ${s}`, date: '2026-04-01', ...(s === 'tag' ? { tags: [`twin-${twin}`] } : {}) }, body)
    }
    for (const s of ['live', 'unpub', 'sched', 'disc']) w.pending('blog', `${s}-${twin}`, { title: `Post ${s} v2`, date: '2026-04-01' }, `Changed text of ${s}.`)
    await admin.writeOne('blog', `restore-${twin}`, { title: 'Post restore', date: '2026-04-01' }, 'The second version.')
    w.asset(`alt-${twin}.webp`)
    w.asset(`trash-${twin}.webp`)
  }
  fs.mkdirSync(path.join(h.tmp, 'public', 'uploads'), { recursive: true })
  // Real files: the media library's own actions re-index the uploads from the disk.
  for (const twin of ['r', 'a']) for (const n of [`trash-${twin}.webp`, `alt-${twin}.webp`]) fs.writeFileSync(path.join(h.tmp, 'public', 'uploads', n), Buffer.from('RIFF0000WEBPVP8 '))
  const { saveMediaText } = await import('../lib/contentOps/media')
  for (const twin of ['r', 'a']) assert.equal((await saveMediaText({ name: `alt-${twin}.webp`, texts: { alt: 'A desk by a window' } })).ok, true)
  await w.page('now', { title: 'Now' }, 'Doing things.')
  const { log } = await import('../lib/log')
  assert.equal((await (await import('../lib/contentOps/home')).saveHomeDoc(HOME, {}, { log })).ok, true)
  assert.equal((await (await import('../lib/contentOps/cv')).saveCvDoc({ en: CV.en, zh: CV.zh }, {}, { log })).ok, true)
  const { writeLinkStore } = await import('../lib/contentHealth/linkStore')
  writeLinkStore({
    version: 1,
    lastRun: null,
    links: { 'https://moved.example.com/d': { url: 'https://moved.example.com/d', checkedAt: Date.now() - 3_600_000, outcome: 'moved', status: 200, code: null, reason: null, finalUrl: 'https://moved.example.com/new-d', safeMove: true, failures: 0, failingSince: null } },
  })
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

/** An item as stored, without times; `slug` names in it read as the twin's. */
function item(slug: string) {
  const live = admin.readOne('blog', slug)
  const p = pend.getPendingRevision('blog', slug)
  return { live: live && { fm: live.frontmatter, body: live.body }, pending: p && { fm: p.frontmatter, body: p.body }, snapshots: admin.listSnapshots('blog', slug).length }
}
const twin = (value: unknown) => JSON.stringify(value).replaceAll('-r', '-T').replaceAll('-a', '-T')
const paths = (list: string[], base?: string) => Array.from(new Set(base ? list.map((p) => p.replace(new RegExp(`${base}-[ar]$`), `${base}-T`)) : list)).sort()

async function lastAction(routeLike: RegExp) {
  const { getAuditDb } = await import('../lib/audit/db')
  const rows = getAuditDb().prepare('SELECT action, route, target FROM audit_log WHERE status != 0 ORDER BY id DESC LIMIT 5').all() as Array<{ action: string; route: string; target: string | null }>
  return rows.find((r) => routeLike.test(r.route))?.action ?? null
}

async function propose(tool: string, args: Record<string, unknown>) {
  const out = await tools.call(tool, { rationale: 'Requested by the owner.', ...args }, 'propose', { grant: tools.grantAt('propose') })
  assert.equal(out.json?.status, 'waiting_for_owner', `${tool}: ${out.text}`)
  return out.json.change_id as string
}

async function approveAndTell(id: string) {
  const out = await routes.approve(id)
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  return out
}

const etag = (slug: string) => admin.itemEtag(admin.readOne('blog', slug)!.updatedAt, pend.getPendingRevision('blog', slug)?.updatedAt)

/**
 * The route twin and the proposal on twin items. `action`: the activity action both record — the route's own,
 * unless the design names the AI's (publishing unpublished changes reads `post.publish`, where the editor's PUT
 * is recorded as a save).
 */
async function pair(
  label: string,
  slugBase: string,
  viaRoute: (slug: string) => Promise<{ revalidated: string[] }>,
  viaAi: (slug: string) => Promise<string>,
  opts: { route?: RegExp; action?: string } = {},
) {
  const r = await viaRoute(`${slugBase}-r`)
  const routeAction = opts.action ?? (await lastAction(opts.route ?? /^admin\/(posts|work)$/))
  const id = await viaAi(`${slugBase}-a`)
  const a = await approveAndTell(id)
  const aiAction = await lastAction(/^admin\/ai\/changes$/)
  assert.equal(twin(item(`${slugBase}-a`)), twin(item(`${slugBase}-r`)), `${label}: the same stored rows and snapshots`)
  assert.deepEqual(paths(a.revalidated, slugBase), paths(r.revalidated, slugBase), `${label}: the same pages regenerated`)
  if (routeAction !== null) assert.equal(aiAction, routeAction, `${label}: the same activity action`)
  return { route: r, ai: a }
}

test('publish a draft, publish unpublished changes, unpublish: as the editor does it', async () => {
  await pair(
    'publish a draft',
    'draft',
    async (slug) => {
      const one = admin.readOne('blog', slug)!
      const fm = { ...one.frontmatter }
      delete fm.draft
      return h.call(posts, { method: 'PUT', body: { slug, frontmatter: fm, body: one.body }, headers: { 'if-match': etag(slug) }, ip: nextIp() })
    },
    async (slug) => propose('propose_publishing', { collection: 'blog', slug, action: 'publish', base_version: etag(slug) }),
  )
  await pair(
    'publish changes',
    'live',
    async (slug) => {
      const p = pend.getPendingRevision('blog', slug)!
      return h.call(posts, { method: 'PUT', body: { slug, frontmatter: p.frontmatter, body: p.body }, headers: { 'if-match': etag(slug) }, ip: nextIp() })
    },
    async (slug) => propose('propose_publishing', { collection: 'blog', slug, action: 'publish', base_version: etag(slug) }),
    { action: 'post.publish' },
  )
  await pair(
    'unpublish',
    'unpub',
    async (slug) => {
      const p = pend.getPendingRevision('blog', slug)!
      return h.call(posts, { method: 'PUT', body: { slug, frontmatter: { ...p.frontmatter, draft: true }, body: p.body }, headers: { 'if-match': etag(slug) }, ip: nextIp() })
    },
    async (slug) => propose('propose_publishing', { collection: 'blog', slug, action: 'unpublish', base_version: etag(slug) }),
  )
})

test('schedule and discard unpublished changes: as the editor does it', async () => {
  const when = new Date(Date.now() + 3 * DAY).toISOString()
  await pair(
    'schedule',
    'sched',
    async (slug) => h.call(posts, { method: 'POST', body: { action: 'schedule', slug, publishAt: when, unpublishAt: null }, headers: { 'if-match': etag(slug) }, ip: nextIp() }),
    async (slug) => propose('propose_publishing', { collection: 'blog', slug, action: 'schedule', publish_at: when, base_version: etag(slug) }),
  )
  await pair(
    'discard',
    'disc',
    async (slug) => h.call(posts, { method: 'POST', body: { action: 'discard-pending', slug }, headers: { 'if-match': etag(slug) }, ip: nextIp() }),
    async (slug) => propose('propose_publishing', { collection: 'blog', slug, action: 'discard_changes', base_version: etag(slug) }),
  )
})

test('restore a version and delete: as the history drawer and the editor do it', async () => {
  const versions = (await import('../pages/api/versions')).default as Handler
  await pair(
    'restore',
    'restore',
    async (slug) => h.call(versions, { method: 'POST', query: { type: 'blog' }, body: { action: 'restore', slug, filename: admin.listSnapshots('blog', slug)[0].filename }, ip: nextIp() }),
    async (slug) => propose('propose_restore', { collection: 'blog', ref: slug, filename: admin.listSnapshots('blog', slug)[0].filename, base_version: etag(slug) }),
    { route: /^versions$/ },
  )
  const r = await h.call(posts, { method: 'DELETE', query: { slug: 'del-r' }, ip: nextIp() })
  assert.equal(r.statusCode, 200, JSON.stringify(r.body))
  const routeAction = await lastAction(/^admin\/posts$/)
  const a = await approveAndTell(await propose('propose_delete', { target: 'post', ref: 'del-a', base_version: etag('del-a') }))
  assert.equal(twin(item('del-a')), twin(item('del-r')), 'gone, with the same history')
  assert.deepEqual(paths(a.revalidated, 'del'), paths(r.revalidated, 'del'))
  assert.equal(await lastAction(/^admin\/ai\/changes$/), routeAction)
})

test('a page, the home page and the CV: the same stored document, snapshots and pages as their editors’ saves', async () => {
  const store = await import('../lib/contentStore')
  const page = (await import('../pages/api/admin/page')).default as Handler
  const home = (await import('../pages/api/home')).default as Handler
  const cvdata = (await import('../pages/api/cvdata')).default as Handler
  const homeLib = await import('../lib/home')
  const cvLib = await import('../lib/cvdata')

  // /now: the route first, then back to the original, then the proposal.
  const original = admin.readPage('now')
  const snapsBefore = admin.listSnapshots('page', 'now').length
  const r = await h.call(page, { method: 'PUT', body: { name: 'now', frontmatter: { title: 'Now', description: 'What I do.' }, body: 'Doing other things.' }, headers: { 'if-match': admin.versionEtag(original.updatedAt) }, ip: nextIp() })
  assert.equal(r.statusCode, 200, JSON.stringify(r.body))
  const afterRoute = admin.readPage('now')
  const routeSnaps = admin.listSnapshots('page', 'now').length - snapsBefore
  await store.putPage('now', original.frontmatter, original.body)
  const snapsMid = admin.listSnapshots('page', 'now').length
  const a = await approveAndTell(await propose('propose_page_edit', { name: 'now', body: 'Doing other things.', frontmatter_patch: { description: 'What I do.' }, base_version: (await tools.data('get_content', { collection: 'page', ref: 'now', include_body: false }, 'draft')).version }))
  const afterAi = admin.readPage('now')
  assert.deepEqual({ fm: afterAi.frontmatter, body: afterAi.body }, { fm: afterRoute.frontmatter, body: afterRoute.body })
  assert.equal(admin.listSnapshots('page', 'now').length - snapsMid, routeSnaps)
  assert.deepEqual(paths(a.revalidated), paths(r.revalidated))

  // Home: the editor's PUT sends the whole document; the proposal names one path.
  const homeBefore = store.getKv('home') as typeof HOME
  const homeSnaps = homeLib.listHomeSnapshots().length
  const hr = await h.call(home, { method: 'PUT', body: { ...homeBefore, hero: { ...homeBefore.hero, tagline: 'Maker' } }, ip: nextIp() })
  assert.equal(hr.statusCode, 200, JSON.stringify(hr.body))
  const homeAfterRoute = JSON.stringify(store.getKv('home'))
  const homeRouteSnaps = homeLib.listHomeSnapshots().length - homeSnaps
  await store.putKv('home', homeBefore)
  const homeMid = homeLib.listHomeSnapshots().length
  const ha = await approveAndTell(await propose('propose_home_edit', { ops: [{ path: 'hero.tagline', value_json: '"Maker"' }], base_version: (await tools.data('get_home', {}, 'draft')).version }))
  assert.equal(JSON.stringify(store.getKv('home')), homeAfterRoute, 'the same stored home document')
  // Both keep the state they replaced in the history first (a snapshot identical to the newest is not written twice).
  assert.equal(homeRouteSnaps, 1)
  assert.ok(homeLib.listHomeSnapshots().length - homeMid <= 1)
  assert.deepEqual(JSON.parse(homeLib.readHomeSnapshot(homeLib.listHomeSnapshots()[0]) ?? 'null'), homeBefore)
  assert.deepEqual(paths(ha.revalidated), paths(hr.revalidated))

  // CV.
  const cvBefore = cvLib.readCvData()
  const cvSnaps = cvLib.listSnapshots().length
  const nextCv = { en: [cvBefore.en[0], { ...cvBefore.en[1], experiences: [{ ...cvBefore.en[1].experiences[0], jobTitle: 'Lead engineer' }] }], zh: cvBefore.zh }
  const cr = await h.call(cvdata, { method: 'PUT', body: nextCv, ip: nextIp() })
  assert.equal(cr.statusCode, 200, JSON.stringify(cr.body))
  const cvAfterRoute = JSON.stringify(cvLib.readCvData())
  const cvRouteSnaps = cvLib.listSnapshots().length - cvSnaps
  await store.putKv('cvdata', cvBefore)
  const cvMid = cvLib.listSnapshots().length
  const ca = await approveAndTell(await propose('propose_cv_edit', { ops: [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Lead engineer"' }], base_version: (await tools.data('get_cv', {}, 'draft')).version }))
  assert.equal(JSON.stringify(cvLib.readCvData()), cvAfterRoute, 'the same stored CV')
  assert.equal(cvRouteSnaps, 1)
  assert.ok(cvLib.listSnapshots().length - cvMid <= 1)
  assert.deepEqual(JSON.parse(cvLib.readSnapshot(cvLib.listSnapshots()[0]) ?? 'null'), cvBefore)
  assert.deepEqual(paths(ca.revalidated), paths(cr.revalidated))
})

test('a tag rename, a content fix, an alt fill, a trash: as the Tags page, Content health and the media library do them', async () => {
  const tags = (await import('../pages/api/admin/tags')).default as Handler
  const health = (await import('../pages/api/admin/content-health')).default as Handler
  const media = (await import('../pages/api/admin/media/index')).default as Handler

  const tr = await h.call(tags, { method: 'POST', body: { collection: 'blog', from: ['twin-r'], to: 'Renamed T' }, ip: nextIp() })
  assert.equal(tr.statusCode, 200, JSON.stringify(tr.body))
  const ta = await approveAndTell(await propose('propose_tag_change', { collection: 'blog', from: ['twin-a'], to: 'Renamed T' }))
  assert.equal(twin(item('tag-a')).replace('twin', ''), twin(item('tag-r')).replace('twin', ''))
  assert.deepEqual(item('tag-a').live?.fm.tags, ['Renamed T'])
  assert.deepEqual(paths(ta.revalidated), paths(tr.revalidated), 'every page tags feed')

  const report = await tools.data('get_content_health', { check: 'redirect' }, 'draft')
  const issueOf = (slug: string) => report.issues.find((i: { item: string }) => i.item === `blog/${slug}`)
  const fr = await h.call(health, { method: 'POST', body: { action: 'fix', fixes: [{ id: issueOf('fix-r').id, version: report.items['blog/fix-r'].version }] }, ip: nextIp() })
  assert.equal(fr.statusCode, 200, JSON.stringify(fr.body))
  const fa = await approveAndTell(await propose('propose_content_fix', { fixes: [{ id: issueOf('fix-a').id, version: report.items['blog/fix-a'].version }] }))
  assert.equal(twin(item('fix-a')), twin(item('fix-r')))
  assert.match(item('fix-a').live!.body, /https:\/\/moved\.example\.com\/new-d/)
  assert.deepEqual(paths(fa.revalidated, 'fix'), paths(fr.revalidated, 'fix'))

  const ar = await h.call(media, { method: 'POST', body: { action: 'apply-alt', name: 'alt-r.webp' }, ip: nextIp() })
  assert.equal(ar.statusCode, 200, JSON.stringify(ar.body))
  const aa = await approveAndTell(await propose('propose_apply_alt', { name: 'alt-a.webp' }))
  assert.equal(twin(item('alt-a')), twin(item('alt-r')))
  assert.match(item('alt-a').live!.body, /!\[A desk by a window\]\(\/uploads\/alt-a\.webp\)/)
  assert.deepEqual(paths(aa.revalidated, 'alt'), paths(ar.revalidated, 'alt'))

  const mr = await h.call(media, { method: 'POST', body: { action: 'delete', names: ['trash-r.webp'] }, ip: nextIp() })
  assert.equal(mr.statusCode, 200, JSON.stringify(mr.body))
  await approveAndTell(await propose('propose_delete', { target: 'image', ref: 'trash-a.webp' }))
  const { getDb } = await import('../lib/db')
  const trashed = getDb().prepare("SELECT name, reason FROM media_trash WHERE name IN ('trash-r.webp', 'trash-a.webp') ORDER BY name").all()
  assert.deepEqual(trashed, [
    { name: 'trash-a.webp', reason: 'deleted' },
    { name: 'trash-r.webp', reason: 'deleted' },
  ])
  for (const n of ['trash-r.webp', 'trash-a.webp']) assert.equal(fs.existsSync(path.join(h.tmp, 'public', 'uploads', n)), false)
})

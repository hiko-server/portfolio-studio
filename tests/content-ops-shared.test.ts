/**
 * F1 — the shared pieces under the content services, on a throw-away store:
 *
 *   - the moves (frontmatterMerge and docOps to lib/, forwardedScheme to
 *     lib/security) keep every old import working with the same functions;
 *   - lib/contentOps/refresh is the one place pages are regenerated from
 *     (the routes keep their path lists only as re-exports);
 *   - saveMediaText carries the route's checks: a name such as
 *     `constructor` passes the upload-name pattern and is still refused;
 *   - publicCvDoc's keepUids option shows the uids of visible entries only;
 *   - factsFor is exported for callers without a request, and the activity
 *     log now names rename, discard, redirect removal, the home snapshot and
 *     restore, and unpublished changes as what they are.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness, type Handler } from './editorialHarness'
import { ROOT } from './helpers/importGraph'

// The home save mails the owner: never anyone real from a test.
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'FROM_EMAIL']) delete process.env[k]
process.env.NOTIFY_EMAIL = 'owner@example.test'

const h = editorialHarness('content-ops-shared', 'content-ops-shared-secret-0123456789abcdef')
let posts: Handler
let home: Handler

before(async () => {
  await h.setup()
  posts = (await import('../pages/api/admin/posts')).default
  home = (await import('../pages/api/home')).default
})
after(async () => {
  // A home or CV save warms the PDF exports in the background; that work reads the store, and would open it again
  // (recreating <tmp>/data/content.db) after the teardown removed it.
  await (await import('../lib/cvExport/service')).cvExportsSettled()
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fs.existsSync(h.tmp), false, 'nothing of the temporary store is left behind')
})

let client = 0
const ip = () => `127.0.4.${++client % 250}`

test('the moved modules: every old import path hands out the very same functions', async () => {
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
    [await import('../components/Admin/shell/frontmatterMerge'), await import('../lib/frontmatterMerge'), 'frontmatterMerge'],
    [await import('../components/Admin/cvStudio/docOps'), await import('../lib/cvDocOps'), 'docOps'],
  ]
  for (const [old, moved, name] of pairs) {
    assert.deepEqual(Object.keys(old).sort(), Object.keys(moved).sort(), name)
    for (const key of Object.keys(moved)) assert.equal(old[key], moved[key], `${name}.${key}`)
  }
  const proxy = await import('../proxy')
  const scheme = await import('../lib/security/forwardedScheme')
  assert.equal(proxy.forwardedScheme, scheme.forwardedScheme)
  const audit = await import('../lib/audit/capture')
  assert.equal(typeof audit.factsFor, 'function')
})

test('forwardedScheme reads fetch headers and Node’s header record alike', async () => {
  const { forwardedScheme } = await import('../lib/security/forwardedScheme')
  const both = (headers: Record<string, string>) => [forwardedScheme(new Headers(headers)), forwardedScheme(headers)]
  assert.deepEqual(both({ 'cf-visitor': '{"scheme":"HTTP"}', 'x-forwarded-proto': 'https' }), ['http', 'http'])
  assert.deepEqual(both({ 'cf-visitor': 'not json', 'x-forwarded-proto': 'HTTP, https' }), ['http', 'http'])
  assert.deepEqual(both({ 'cf-visitor': '{"scheme":""}', 'x-forwarded-proto': 'https' }), ['https', 'https'])
  assert.deepEqual(both({}), ['', ''])
  assert.equal(forwardedScheme({ 'x-forwarded-proto': ['http', 'https'] }), 'http')
})

test('refresh: the routes’ path lists are the service’s, and the routes regenerate only through it', async () => {
  const refresh = await import('../lib/contentOps/refresh')
  const admin = await import('../lib/mdx-admin')
  const homeRoute = await import('../pages/api/home')
  const cvRoute = await import('../pages/api/cvdata')
  const { HOME_PAGE_PATHS, CV_PAGE_PATHS } = await import('../lib/revalidate')
  assert.equal(homeRoute.HOME_STATIC_PATHS, refresh.HOME_STATIC_PATHS)
  assert.equal(cvRoute.CV_STATIC_PATHS, refresh.CV_STATIC_PATHS)
  assert.deepEqual([...refresh.HOME_STATIC_PATHS], [...HOME_PAGE_PATHS])
  assert.deepEqual([...refresh.CV_STATIC_PATHS], [...CV_PAGE_PATHS])
  assert.equal(admin.refreshCollection, refresh.refreshCollection)
  assert.equal(admin.translationPartners, refresh.translationPartners)

  const ts = (await import('typescript')).default
  const calls = (file: string) => {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const out = new Set<string>()
    const visit = (n: import('typescript').Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text)
      n.forEachChild(visit)
    }
    visit(sf)
    return out
  }
  const expected: Record<string, string[]> = {
    'pages/api/home.ts': ['refreshHome'],
    'pages/api/cvdata.ts': ['refreshCv'],
    'pages/api/versions.ts': ['refreshCollection', 'refreshPage', 'refreshRestoredDoc'],
    'pages/api/internal/scheduled-publish.ts': ['refreshCollection'],
    'lib/collectionApi.ts': ['refreshCollection'],
  }
  for (const [file, helpers] of Object.entries(expected)) {
    const found = calls(file)
    for (const helper of helpers) assert.ok(found.has(helper), `${file} calls ${helper}`)
    for (const own of ['warmCvExports', 'pageRevalidatePaths']) assert.ok(!found.has(own), `${file} keeps no private copy (${own})`)
  }
  for (const file of ['pages/api/home.ts', 'pages/api/cvdata.ts', 'pages/api/versions.ts']) assert.ok(!calls(file).has('revalidatePaths'), `${file} regenerates through lib/contentOps/refresh`)
})

test('refresh helpers: what each regenerates, and a page that fails is reported, never thrown', async () => {
  const refresh = await import('../lib/contentOps/refresh')
  const { pageRevalidatePaths } = await import('../lib/revalidate')
  const fakeRes = (failOn: string | null = null) => {
    const seen: string[] = []
    const res = {
      revalidate: async (p: string) => {
        seen.push(p)
        if (p === failOn) throw new Error('render failed')
      },
    }
    return { res: res as never, seen }
  }
  const page = fakeRes()
  assert.deepEqual(await refresh.refreshPage(page.res, 'about-zh'), { revalidated: pageRevalidatePaths('about-zh') })
  const homeRun = fakeRes('/contact')
  const homeOut = await refresh.refreshHome(homeRun.res)
  assert.deepEqual(homeOut.revalidateFailed, ['/contact'])
  assert.deepEqual([...homeOut.revalidated, '/contact'].sort(), [...refresh.HOME_STATIC_PATHS].sort())
  const nav = { pathsIfChanged: () => ['/blog', '/cv'] }
  const cvRun = fakeRes()
  const cvOut = await refresh.refreshCv(cvRun.res, nav)
  assert.deepEqual([...cvOut.revalidated].sort(), Array.from(new Set([...refresh.CV_STATIC_PATHS, '/blog'])).sort(), 'the nav follow-ups, once each')
  const restored = fakeRes()
  const restoredOut = await refresh.refreshRestoredDoc(restored.res, 'home', null)
  assert.deepEqual([...restoredOut.revalidated].sort(), [...refresh.HOME_STATIC_PATHS].sort())
})

test('saveMediaText: only an existing original upload gets texts; `constructor` and friends are refused', async () => {
  const { saveMediaText } = await import('../lib/contentOps/media')
  const { readMediaMeta } = await import('../lib/media/metaStore')
  const { isValidUploadName } = await import('../lib/security/uploadName')
  const uploads = path.join(h.tmp, 'public', 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  fs.writeFileSync(path.join(uploads, 'synthetic-card.png'), Buffer.from('not really a png'))
  fs.writeFileSync(path.join(uploads, 'synthetic-card.png.w640.webp'), Buffer.from('variant'))

  for (const name of ['constructor', '__proto__', 'toString']) {
    assert.equal(isValidUploadName(name), true, `${name} passes the name pattern`)
    assert.deepEqual(await saveMediaText({ name, texts: { alt: 'x' } }), { ok: false, status: 404, code: 'NOT_FOUND', error: 'No such upload' })
  }
  assert.deepEqual(await saveMediaText({ name: '../x', texts: { alt: 'x' } }), { ok: false, status: 400, code: 'INVALID_NAME', error: 'Invalid name' })
  assert.deepEqual(await saveMediaText({ name: 7, texts: { alt: 'x' } }), { ok: false, status: 400, code: 'INVALID_NAME', error: 'Invalid name' })
  assert.deepEqual(await saveMediaText({ name: 'synthetic-card.png.w640.webp', texts: { alt: 'x' } }), { ok: false, status: 400, code: 'INVALID_NAME', error: 'Invalid name' })
  assert.deepEqual(await saveMediaText({ name: 'synthetic-card.png', texts: { alt: 5 } }), { ok: false, status: 400, code: 'INVALID_TEXT', error: 'alt must be text' })
  assert.deepEqual(Object.keys(readMediaMeta().doc.items), [], 'nothing stored')

  const saved = await saveMediaText({ name: 'synthetic-card.png', texts: { alt: 'A synthetic card', captionZh: '示例', ignored: 'x' }, expectedUpdatedAt: 0 })
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  assert.deepEqual({ ...saved.meta, updatedAt: 0 }, { alt: 'A synthetic card', altZh: '', caption: '', captionZh: '示例', updatedAt: 0 })
  const stale = await saveMediaText({ name: 'synthetic-card.png', texts: { alt: 'Other' }, expectedUpdatedAt: 0 })
  assert.equal(!stale.ok && stale.code, 'CONFLICT')
  assert.equal(!stale.ok && stale.status === 409 && stale.current?.alt, 'A synthetic card')
  const anyVersion = await saveMediaText({ name: 'synthetic-card.png', texts: { caption: 'Card' }, expectedUpdatedAt: 'not a number' })
  assert.equal(anyVersion.ok && anyVersion.meta?.caption, 'Card', 'no usable version: last write wins, as the route did')
})

test('publicCvDoc keepUids: the uids of what the view shows, nothing else changes', async () => {
  const { publicCvDoc } = await import('../lib/cvVisibility')
  const doc = {
    en: [
      {
        sessionName: 'workExperience',
        hiddenItems: { experiences: [2] },
        experiences: [
          { uid: 'role-visible', jobTitle: 'Visible role', hiddenFields: ['company'], company: 'Hidden Co' },
          { uid: 'role-hidden', jobTitle: 'Hidden role', isVisible: false },
          { uid: 'role-hidden-item', jobTitle: 'Hidden item' },
          { uid: 'role-private', jobTitle: 'Private role', onlyIn: ['private'] },
        ],
      },
      { sessionName: 'education', isVisible: false, showOnWebsite: false, educations: [{ uid: 'edu-hidden', schoolName: 'Hidden school' }] },
    ],
    zh: [],
  }
  const plain = publicCvDoc(doc, 'any', 'web')
  const withUids = publicCvDoc(doc, 'any', 'web', { keepUids: true })
  assert.doesNotMatch(JSON.stringify(plain), /"uid"/, 'by default no view carries a uid')
  const uids = JSON.stringify(withUids).match(/"uid":"[^"]+"/g)
  assert.deepEqual(uids, ['"uid":"role-visible"'])
  const stripUids = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stripUids) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'uid').map(([k, x]) => [k, stripUids(x)])) : v
  assert.deepEqual(stripUids(withUids), plain, 'everything else is the same public view')
  assert.doesNotMatch(JSON.stringify(withUids), /Hidden Co|Hidden role|Hidden item|Private role|Hidden school/)

  // The stored CV through readPublicCvData, with the option passed on.
  const { writeCvData, readPublicCvData } = await import('../lib/cvdata')
  assert.equal((await writeCvData({ en: doc.en as never, zh: [] })).ok, true)
  assert.doesNotMatch(JSON.stringify(readPublicCvData('any', 'web')), /"uid"/)
  assert.deepEqual(JSON.stringify(readPublicCvData('any', 'web', undefined, { keepUids: true })).match(/"uid":"[^"]+"/g), ['"uid":"role-visible"'])
})

test('factsFor: what the activity label needs, from the method and body alone', async () => {
  const { factsFor } = await import('../lib/audit/capture')
  const put = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const out = await h.call(posts, { method: 'PUT', body, headers, ip: ip() })
    assert.equal(out.statusCode, 200, JSON.stringify(out.body))
    return out
  }
  await put({ slug: 'facts-draft', frontmatter: { title: 'Facts', date: '2026-05-01', draft: true }, body: 'x', create: true })
  const live = await put({ slug: 'facts-live', frontmatter: { title: 'Facts live', date: '2026-05-01' }, body: 'x', create: true })
  assert.deepEqual(factsFor('admin/posts', { method: 'PUT', body: { slug: 'facts-draft' } }), { existingDraft: true })
  assert.deepEqual(factsFor('admin/posts', { method: 'put', body: { slug: 'facts-live' } }), { existingDraft: false })
  assert.deepEqual(factsFor('admin/posts', { method: 'PUT', body: { slug: 'nothing-here' } }), { existingDraft: null })
  assert.deepEqual(factsFor('admin/posts', { method: 'POST', body: { action: 'schedule', slug: 'facts-draft' } }), { existingDraft: true })
  assert.deepEqual(factsFor('admin/posts', { method: 'POST', body: { action: 'discard-pending', slug: 'facts-live' } }), { hasPending: false })
  await put({ slug: 'facts-live', frontmatter: { title: 'Facts live', date: '2026-05-01' }, body: 'y', target: 'pending' }, { 'if-match': live.headers.etag })
  assert.deepEqual(factsFor('admin/posts', { method: 'POST', body: { action: 'discard-pending', slug: 'facts-live' } }), { hasPending: true })
  assert.deepEqual(factsFor('admin/posts', { method: 'POST', body: { action: 'rename', slug: 'facts-live' } }), {})
  assert.deepEqual(factsFor('admin/work', { method: 'PUT', body: { slug: 'facts-draft' } }), { existingDraft: null })
  assert.deepEqual(factsFor('home', { method: 'PUT', body: { slug: 'facts-draft' } }), {})
  assert.deepEqual(factsFor('admin/posts', { method: 'PUT', body: 'not an object' }), {})
})

test('describeAdminWrite: rename, discard, redirect removal, the home snapshot and restore, and unpublished changes', async () => {
  const { describeAdminWrite } = await import('../lib/audit/describe')
  const post = (body: Record<string, unknown>, facts = {}) => describeAdminWrite('admin/posts', { method: 'POST', query: {}, body }, facts)
  assert.deepEqual(post({ action: 'rename', slug: 'old-name', to: ' New-Name ' }), {
    action: 'post.rename',
    area: 'post',
    target: 'new-name',
    summary: 'Renamed post “old-name” to “new-name”',
  })
  assert.equal(describeAdminWrite('admin/work', { method: 'POST', query: {}, body: { action: 'rename', slug: 'a', to: 'b', redirect: false } })?.summary, 'Renamed case study “a” to “b” without a redirect from the old address')
  assert.equal(post({ action: 'rename', slug: 'a', to: 'b', dryRun: true }), null, 'a dry run changes nothing')
  assert.equal(post({ action: 'rename', slug: 'a' }), null)
  assert.equal(post({ action: 'rename', slug: 'a', to: 'Not a slug!' }), null)
  assert.deepEqual(post({ action: 'discard-pending', slug: 'kept' }, { hasPending: true }), {
    action: 'post.discard-changes',
    area: 'post',
    target: 'kept',
    summary: 'Discarded the unpublished changes to post “kept”',
  })
  assert.equal(post({ action: 'discard-pending', slug: 'kept' }, { hasPending: false }), null, 'nothing to discard: nothing to record')
  assert.deepEqual(post({ action: 'remove-redirect', slug: 'item', from: 'old-address' }), {
    action: 'post.remove-redirect',
    area: 'post',
    target: 'item',
    summary: 'Stopped redirecting /blog/old-address to post “item”',
  })
  assert.equal(describeAdminWrite('admin/work', { method: 'POST', query: {}, body: { action: 'remove-redirect', slug: 'item', from: 'x' } })?.summary, 'Stopped redirecting /work/x to case study “item”')
  assert.equal(post({ action: 'remove-redirect', slug: 'item', from: '../x' }), null)
  assert.equal(post({ action: 'something-else', slug: 'item' }), null)

  const homeWrite = (body: Record<string, unknown>) => describeAdminWrite('home', { method: 'POST', query: {}, body })
  assert.deepEqual(homeWrite({ action: 'snapshot' }), { action: 'home.snapshot', area: 'home', target: null, summary: 'Took a snapshot of the home page' })
  assert.deepEqual(homeWrite({ action: 'restore', filename: 'home_2026-10-14_08-31-02-123.json' }), {
    action: 'home.restore',
    area: 'home',
    target: 'home_2026-10-14_08-31-02-123.json',
    summary: 'Restored the home page from 2026-10-14 08:31 UTC',
  })
  assert.equal(homeWrite({ action: 'import' }), null)

  const pending = describeAdminWrite('admin/posts', { method: 'PUT', query: {}, body: { slug: 'live', target: 'pending', frontmatter: { title: 'Live post' }, body: 'Secret draft text' } }, { existingDraft: false })
  assert.deepEqual(pending, { action: 'post.save-pending', area: 'post', target: 'live', summary: 'Saved unpublished changes to post “Live post”' })
  assert.ok(!JSON.stringify(pending).includes('Secret draft text'))
  // A save that goes live keeps its old label.
  assert.equal(describeAdminWrite('admin/posts', { method: 'PUT', query: {}, body: { slug: 'live', target: 'live', frontmatter: { title: 'Live post' } } }, { existingDraft: false })?.summary, 'Saved post “Live post”')
})

test('the activity log records these writes through the real routes, and nothing for a discard with nothing to drop', async () => {
  const { listAudit } = await import('../lib/audit/store')
  const actions = () => listAudit({ limit: 100 }).entries.map((e) => `${e.action} ${e.target ?? ''}`.trim())
  const start = actions().length
  const created = await h.call(posts, { method: 'PUT', body: { slug: 'logged', frontmatter: { title: 'Logged', date: '2026-05-01' }, body: 'x', create: true }, ip: ip() })
  assert.equal(created.statusCode, 200)
  const pend = await h.call(posts, { method: 'PUT', body: { slug: 'logged', frontmatter: { title: 'Logged', date: '2026-05-01' }, body: 'y', target: 'pending' }, headers: { 'if-match': created.headers.etag }, ip: ip() })
  assert.equal(pend.statusCode, 200)
  const discard = await h.call(posts, { method: 'POST', body: { action: 'discard-pending', slug: 'logged' }, ip: ip() })
  assert.deepEqual([discard.statusCode, discard.body.discarded], [200, true])
  const again = await h.call(posts, { method: 'POST', body: { action: 'discard-pending', slug: 'logged' }, ip: ip() })
  assert.deepEqual([again.statusCode, again.body.discarded], [200, false])
  const renamed = await h.call(posts, { method: 'POST', body: { action: 'rename', slug: 'logged', to: 'logged-2' }, ip: ip() })
  assert.equal(renamed.statusCode, 200, JSON.stringify(renamed.body))
  const removed = await h.call(posts, { method: 'POST', body: { action: 'remove-redirect', slug: 'logged-2', from: 'logged' }, ip: ip() })
  assert.equal(removed.statusCode, 200, JSON.stringify(removed.body))
  const homeDoc = (brand: string) => ({ hero: { welcome: '', brand, tagline: 't', avatarUrl: '', currentlyCoding: '' }, socials: {}, brands: [] })
  const saved = await h.call(home, { method: 'PUT', body: homeDoc('Example Person'), ip: ip() })
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body))
  const snap = await h.call(home, { method: 'POST', body: { action: 'snapshot' }, ip: ip() })
  assert.equal(snap.statusCode, 200)
  assert.equal((await h.call(home, { method: 'PUT', body: homeDoc('Example Studio'), headers: { 'if-match': saved.body.etag }, ip: ip() })).statusCode, 200)
  const restore = await h.call(home, { method: 'POST', body: { action: 'restore', filename: snap.body.file }, ip: ip() })
  assert.equal(restore.statusCode, 200, JSON.stringify(restore.body))

  const recorded = actions().slice(0, actions().length - start).reverse()
  assert.deepEqual(recorded, [
    'post.publish logged',
    'post.save-pending logged',
    'post.discard-changes logged',
    'post.rename logged-2',
    'post.remove-redirect logged-2',
    'home.save',
    'home.snapshot',
    'home.save',
    `home.restore ${snap.body.file}`,
  ])
})

test('doc drift: the share-link store names the migration that creates its table', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/cvShare/store.ts'), 'utf8')
  const cited = /scripts\/db\/auth\/(\d{3}-[a-z-]+\.mjs)/.exec(src)?.[1]
  assert.equal(cited, '004-cv-share-links.mjs')
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/db/auth', cited)))
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/db/auth', cited), 'utf8'), /cv_share_links/)
})

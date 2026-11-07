/**
 * M3 — what the owner's change pages read (stage M3b), through the real
 * routes on the editorial harness:
 *
 *   - GET /api/admin/ai/changes/<id>/preview?doc=n: the review sheet's
 *     Preview tab, compiled in the real AI worker and made inert — an image
 *     from another site, a player and a link in the owner's draft come back
 *     as placeholders and text; only an MDX document that has an after-state
 *     has one; nothing is written;
 *   - the card's display-only publish checks (never hashed);
 *   - GET /api/admin/overview's `ai` field: on or off, apps, waiting (the
 *     portal card and its "AI changes are waiting" row).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness, type Handler } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-change-review', 'ai-change-review-secret-0123456789abcdef0123456789')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>
let previewRoute: Handler
let publishId = ''
let homeId = ''

const DRAFT_BODY = [
  '## A heading',
  '',
  'Text with [a link](https://example.com/out) and one [to the admin](/api/admin/draft?slug=x).',
  '',
  '![A remote picture](https://images.example.com/remote.png)',
  '',
  '![A local picture](/uploads/local.webp)',
  '',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  '',
].join('\n')

before(async () => {
  await h.setup()
  const w = await storeWriters()
  await w.item('blog', 'owner-draft', { title: 'An owner draft', date: '2026-05-01', draft: true }, DRAFT_BODY)
  await w.kv('home', { hero: { welcome: 'Hello', brand: 'Example Person', tagline: 'Builder', avatarUrl: '/uploads/avatar.webp' }, socials: {}, brands: [], quickAccess: [{ label: 'Blog', url: '/blog' }], photos: [] })
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
  previewRoute = (await import('../pages/api/admin/ai/changes/[id]/preview')).default as Handler
  const version = (await tools.data('get_content', { collection: 'blog', ref: 'owner-draft', include_body: false }, 'draft')).version
  const pub = await tools.call('propose_publishing', { collection: 'blog', slug: 'owner-draft', action: 'publish', base_version: version, rationale: 'Ready.' }, 'propose')
  assert.equal(pub.json?.status, 'waiting_for_owner', pub.text)
  publishId = pub.json.change_id
  const home = await tools.data('get_home', {}, 'draft')
  const edit = await tools.call('propose_home_edit', { ops: [{ path: 'hero.tagline', value_json: '"Builder of careful things"' }], base_version: home.version, rationale: 'A clearer tagline.' }, 'propose', { grant: tools.grantAt('propose') })
  assert.equal(edit.json?.status, 'waiting_for_owner', edit.text)
  homeId = edit.json.change_id
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

test('the Preview tab: the proposed body compiled in the AI worker, with the remote image, the player and the links made inert; nothing written', async () => {
  const { getDb } = await import('../lib/db')
  const before = JSON.stringify(getDb().prepare('SELECT slug, frontmatter, body, updated_at FROM collection_items ORDER BY slug').all())
  const out = await h.call(previewRoute, { query: { id: publishId, doc: '0' } })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  assert.equal(out.headers['cache-control'], 'no-store')
  const tree = JSON.stringify(out.body.tree)
  assert.match(tree, /"tagName":"h2"/, 'rendered by the site’s compile')
  assert.match(tree, /\[image not loaded\] https:\/\/images\.example\.com\/remote\.png/)
  assert.match(tree, /"src":"\/uploads\/local\.webp"/, 'an upload of this site stays')
  assert.doesNotMatch(tree, /"src":"https?:/, 'no image off this site')
  assert.match(tree, /\[player not loaded\]/, 'the video link’s player facade is replaced')
  assert.doesNotMatch(tree, /"tagName":"(a|iframe|youtube-embed)"/)
  assert.doesNotMatch(tree, /"href":/)
  assert.match(tree, /"title":"\/api\/admin\/draft\?slug=x"/, 'a same-site link reads as text, its address in a title')
  // Links: the two in the text and the heading's own anchor (lib/rehype/headings).
  assert.deepEqual(out.body.replaced, { images: 1, embeds: 1, links: 3 })
  assert.equal(JSON.stringify(getDb().prepare('SELECT slug, frontmatter, body, updated_at FROM collection_items ORDER BY slug').all()), before, 'nothing written')
})

test('only an MDX document with an after-state has a preview: a JSON document, a document that does not exist and a malformed id are 404', async () => {
  for (const query of [{ id: homeId, doc: '0' }, { id: publishId, doc: '1' }, { id: publishId, doc: 'x' }, { id: publishId, doc: '-1' }, { id: 'ch_nope', doc: '0' }, { id: 'ch_abcdefghijklmnop', doc: '0' }]) {
    const out = await h.call(previewRoute, { query })
    assert.equal(out.statusCode, 404, JSON.stringify(query))
    assert.equal(out.body.code, 'NOT_FOUND')
  }
  assert.equal((await h.call(previewRoute, { method: 'POST', query: { id: publishId, doc: '0' } })).statusCode, 405)
  assert.equal((await h.call(previewRoute, { query: { id: publishId, doc: '0' }, auth: false })).statusCode, 401)
})

test('a waiting publish’s card carries the editor’s publish checks, display-only: the hash is the stored one whatever they say', async () => {
  const card = await routes.card(publishId)
  assert.equal(card.statusCode, 200)
  const checks = card.body.notes.publish_checks as Array<{ id: string; level: string; label: string }>
  assert.ok(Array.isArray(checks) && checks.length > 0)
  assert.ok(checks.some((c) => c.id === 'description' && c.level === 'warning'), 'no description: a warning, as in the Publish sheet')
  assert.ok(checks.some((c) => c.id.startsWith('remote-') && /images\.example\.com/.test(c.label)), 'the remote image is named')
  const { getAiDb } = await import('../lib/ai/db')
  const stored = getAiDb().prepare('SELECT preview_sha256 FROM ai_changes WHERE id = ?').get(publishId) as { preview_sha256: string }
  assert.equal(card.body.preview_sha256, stored.preview_sha256)
  // Other kinds and decided changes carry none.
  assert.equal((await routes.card(homeId)).body.notes.publish_checks, null)
})

test('the overview’s ai field: on, the connected apps, the changes waiting; it follows a decision', async () => {
  const { readOverview } = await import('../pages/api/admin/overview')
  const o = readOverview()
  assert.ok(o.ai)
  assert.equal(o.ai.on, true)
  assert.ok(o.ai.apps >= 3, 'the test grants')
  assert.equal(o.ai.waiting, 2)
  assert.equal((await routes.reject(homeId, 'Not now.')).statusCode, 200)
  assert.equal(readOverview().ai?.waiting, 1)
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_settings SET enabled = 0 WHERE id = 1').run()
  try {
    assert.equal(readOverview().ai?.on, false)
  } finally {
    getAuthDb().prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
  }
})

test('the worker answers a tree only when a preview asks for one: a write’s check is unchanged', async () => {
  const { compileForAi } = await import('../lib/ai/compile')
  const check = await compileForAi({ body: '# Title\n\nText.' })
  assert.equal(check.ok, true)
  assert.equal('rendered' in check, false, 'the check of a write carries no tree')
  const shown = await compileForAi({ body: '# Title\n\nText.', render: true })
  assert.equal(shown.ok, true)
  assert.match(JSON.stringify(shown.ok && shown.rendered?.tree), /"tagName":"h1"|"tagName":"h2"/)
  // A body the check refuses is refused for the preview too, with the same answer.
  const bad = await compileForAi({ body: '<div>', render: true })
  assert.equal(bad.ok, false)
  assert.equal(!bad.ok && bad.code, 'MDX_INVALID')
})

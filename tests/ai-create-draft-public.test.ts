/**
 * M2 — create_draft and the public site (design §4.2, §12.1; the colophon's
 * "Nothing they write goes public until I approve it"):
 *
 *   - a new draft never takes over an address with a public or shared
 *     meaning: a slug that still redirects (its 308 stays a 308), a slug
 *     with active review links (they stay active), a deleted item's slug
 *     (it can still be restored there) — SLUG_RESERVED, nothing written;
 *   - a successful draft, an edit of a draft and unpublished changes to a
 *     published post change no public output: the indexes, the feeds,
 *     llms.txt, the Markdown twins and the article pages read the same;
 *   - at most 50 drafts a connection created may exist at once.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness, type Handler } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'

const h = editorialHarness('ai-create-draft-public', 'ai-create-draft-public-secret-0123456789abcdef')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let posts: Handler
let admin: typeof import('../lib/mdx-admin')

before(async () => {
  await h.setup()
  posts = (await import('../pages/api/admin/posts')).default
  admin = await import('../lib/mdx-admin')
  const w = await storeWriters()
  await w.item('blog', 'published-one', { title: 'Published one', date: '2026-04-01', description: 'The first public post' }, 'Public text one.')
  await w.item('blog', 'published-two', { title: 'Published two', date: '2026-04-02', description: 'The second public post' }, 'Public text two.')
  await w.item('blog', 'owner-draft', { title: 'Owner draft', date: '2026-04-03', draft: true }, 'The owner’s draft.')
  await w.item('work', 'public-case', { title: 'Public case', description: 'A case study' }, 'Case text.')
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

let client = 0
async function put(body: Record<string, unknown>) {
  const out = await h.call(posts, { method: 'PUT', body, ip: `127.0.5.${++client % 250}` })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
}
const draft = (slug: string) => ({ collection: 'blog', slug, frontmatter: { title: 'Squatter', date: '2026-06-01' }, body: 'Taking over the address.' })

test('a slug that still redirects is reserved: the old address keeps answering 308 to the renamed post', async () => {
  await put({ slug: 'moved-from', frontmatter: { title: 'Moved', date: '2026-05-01' }, body: 'x', create: true })
  const rename = await h.call(posts, { method: 'POST', body: { action: 'rename', slug: 'moved-from', to: 'moved-to' }, ip: '127.0.5.251' })
  assert.equal(rename.statusCode, 200, JSON.stringify(rename.body))
  const { missingItemProps } = await import('../lib/redirects')
  const redirect = { redirect: { destination: '/blog/moved-to', permanent: true }, revalidate: 60 }
  assert.deepEqual(missingItemProps('blog', 'moved-from'), redirect)
  const out = await tools.call('create_draft', draft('moved-from'), 'draft')
  assert.deepEqual([out.code, out.json.error.reason], ['SLUG_RESERVED', 'redirect'])
  assert.deepEqual(missingItemProps('blog', 'moved-from'), redirect, 'still a permanent redirect')
  assert.equal(admin.readOne('blog', 'moved-from'), null)
})

test('a slug with active review links is reserved, and the links stay active', async () => {
  await put({ slug: 'shared-gone', frontmatter: { title: 'Shared', date: '2026-05-01', draft: true }, body: 'x', create: true })
  const review = await import('../lib/review/store')
  assert.equal(review.createReviewLink({ collection: 'blog', slug: 'shared-gone', variant: 'draft', ttlHours: 24 }).ok, true)
  const { removeItem } = await import('../lib/contentStore')
  assert.equal((await removeItem('blog', 'shared-gone')).ok, true)
  const out = await tools.call('create_draft', draft('shared-gone'), 'draft')
  assert.deepEqual([out.code, out.json.error.reason], ['SLUG_RESERVED', 'review_link'])
  assert.equal(review.listReviewLinks({ collection: 'blog', slugs: ['shared-gone'] }).length, 1)
  assert.equal(admin.readOne('blog', 'shared-gone'), null)
})

test('a deleted item’s slug is reserved: it can still be restored there', async () => {
  await put({ slug: 'was-here', frontmatter: { title: 'Deleted', date: '2026-05-01' }, body: 'x', create: true })
  const del = await h.call(posts, { method: 'DELETE', query: { slug: 'was-here' }, ip: '127.0.5.252' })
  assert.equal(del.statusCode, 200, JSON.stringify(del.body))
  const out = await tools.call('create_draft', draft('was-here'), 'draft')
  assert.deepEqual([out.code, out.json.error.reason], ['SLUG_RESERVED', 'deleted'])
  assert.equal(admin.readOne('blog', 'was-here'), null)
  assert.ok(admin.listDeleted('blog').some((d) => d.slug === 'was-here'), 'still restorable')
})

/** Everything a visitor, a feed reader or a crawler can read. */
async function publicOutput() {
  const { loadBlogIndex, loadWorkIndex } = await import('../lib/indexPages')
  const { buildBlogRss } = await import('../lib/feedHtml')
  const { loadLlmsTxt, loadLlmsFullTxt, loadMarkdownTwin } = await import('../lib/llms')
  const { getPost, listPosts, listWork } = await import('../lib/mdx')
  const { publishedItemSlugs } = await import('../lib/contentStore')
  return JSON.stringify({
    blogIndex: [await loadBlogIndex('en'), await loadBlogIndex('zh-Hans' as never)],
    workIndex: await loadWorkIndex('en'),
    rss: await buildBlogRss('https://site.example', 'https://site.example/feed.xml'),
    llms: await loadLlmsTxt(),
    llmsFull: loadLlmsFullTxt(),
    twins: ['published-one', 'published-two', 'ai-public-draft', 'owner-draft'].map((s) => loadMarkdownTwin('blog', s)),
    posts: listPosts().map((p) => [p.slug, p.frontmatter.title]),
    work: listWork().map((p) => [p.slug, p.frontmatter.title]),
    pages: await Promise.all(['published-one', 'published-two', 'ai-public-draft', 'owner-draft'].map(async (s) => (await getPost(s))?.tree ?? null)),
    slugs: [publishedItemSlugs('blog'), publishedItemSlugs('work')],
  })
}

test('a new draft, an edit of a draft and unpublished changes to a published post change no public output', async () => {
  const before = await publicOutput()
  const created = await tools.call('create_draft', { collection: 'blog', slug: 'ai-public-draft', frontmatter: { title: 'An AI draft', date: '2026-06-01', description: 'Not public' }, body: '## Hidden\n\nNot for visitors yet.' }, 'draft')
  assert.equal(created.ok, true, created.text)
  tools.nextMinute()
  const edited = await tools.call('edit_content', { collection: 'blog', slug: 'ai-public-draft', edits: [{ find: 'Not for visitors yet.', replace: 'Still not for visitors.' }], base_version: created.json.version }, 'draft')
  assert.equal(edited.ok, true, edited.text)
  const owner = await tools.data('get_content', { collection: 'blog', ref: 'owner-draft' }, 'draft')
  assert.equal((await tools.call('edit_content', { collection: 'blog', slug: 'owner-draft', body: 'Rewritten by a model.', base_version: owner.version }, 'draft')).ok, true)
  const live = await tools.data('get_content', { collection: 'blog', ref: 'published-one' }, 'draft')
  const pending = await tools.call(
    'edit_content',
    { collection: 'blog', slug: 'published-one', edits: [{ find: 'Public text one.', replace: 'Changed text one.' }], frontmatter_patch: { title: 'Changed title', description: 'Changed' }, base_version: live.version },
    'draft',
  )
  assert.equal(pending.ok, true, pending.text)
  const work = await tools.data('get_content', { collection: 'work', ref: 'public-case' }, 'draft')
  assert.equal((await tools.call('edit_content', { collection: 'work', slug: 'public-case', body: 'Changed case text.', base_version: work.version }, 'draft')).ok, true)
  assert.equal(await publicOutput(), before, 'byte for byte the same public output')
  const { missingItemProps } = await import('../lib/redirects')
  assert.deepEqual(missingItemProps('blog', 'ai-public-draft'), { notFound: true, revalidate: 60 }, 'the draft’s address is a 404 for visitors')
  // And the owner sees all of it in the editor's view.
  assert.equal((await tools.data('get_content', { collection: 'blog', ref: 'published-one' }, 'draft')).body, 'Changed text one.')
})

test('at most 50 drafts a connection created may exist: the 51st is refused until one is published or deleted', async () => {
  const { getAiDb } = await import('../lib/ai/db')
  const w = await storeWriters()
  const g = tools.grantAt('draft')
  const insert = getAiDb().prepare(
    `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at, applied_at)
     VALUES (?, 'applied', 'draft', 'create_draft', 'item.create', 'mcp', ?, 'cap', 0, 'blog', ?, ?, 'a', 'b', ?, ?)`,
  )
  const now = Date.now()
  for (let i = 0; i < 50; i++) {
    const slug = `capped-${i}`
    await w.item('blog', slug, { title: `Capped ${i}`, date: '2026-06-01', draft: true }, 'x')
    insert.run(`ch_${String(i).padStart(16, 'a').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)])}`, g.id, slug, `New draft post ${slug}`, now - 1000, now - 1000)
  }
  const over = await tools.call('create_draft', draft('capped-new'), 'draft', { grant: g })
  assert.deepEqual([over.code, over.json.error.budget], ['BUDGET', 'aiDraftsPerGrant'])
  assert.equal(admin.readOne('blog', 'capped-new'), null)
  assert.equal((await tools.call('create_draft', draft('other-grant-draft'), 'draft')).ok, true, 'another connection has its own count')

  // The owner publishes one: it is no longer a draft this connection holds.
  const one = admin.readOne('blog', 'capped-0')!
  const published: Record<string, unknown> = { ...one.frontmatter }
  delete published.draft
  await w.item('blog', 'capped-0', published, one.body)
  tools.nextMinute()
  const now50 = await tools.call('create_draft', draft('capped-new'), 'draft', { grant: g })
  assert.equal(now50.ok, true, now50.text)
  tools.nextMinute()
  assert.equal((await tools.call('create_draft', draft('capped-newer'), 'draft', { grant: g })).code, 'BUDGET', 'back at 50')
})

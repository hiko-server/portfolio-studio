/**
 * M2 — held items, the refusal half (design §4.6, §12.1): an item that
 * would reach someone without the owner's approval is never edited in
 * place by AI, whatever saving drafts without asking says.
 *
 *   - a scheduled draft, and a published item's scheduled changes: the
 *     scheduler publishes exactly the stored revision, with no card for the
 *     owner. edit_content answers ITEM_SCHEDULED, nothing is stored, and
 *     when the time comes the scheduler publishes the owner's text;
 *   - an item that active review links show: ITEM_IN_REVIEW, and the review
 *     page shows the same text as before.
 *
 * Stage M2 has no approval queue, so the refusal holds at every access
 * level (M3 turns it into a waiting change for a caller with
 * content:propose, and adds the approval half of this suite).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters, type Level } from './helpers/aiTools'

const h = editorialHarness('ai-held-edits', 'ai-held-edits-secret-0123456789abcdef0123456789')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let admin: typeof import('../lib/mdx-admin')
let pending: typeof import('../lib/pendingRevisions')
const DAY = 86_400_000
const at = Date.now() + 3 * DAY

before(async () => {
  await h.setup()
  admin = await import('../lib/mdx-admin')
  pending = await import('../lib/pendingRevisions')
  const { applySchedule } = await import('../lib/schedule/store')
  const w = await storeWriters()
  await w.item('blog', 'sched-draft', { title: 'Scheduled draft', date: '2026-05-01', draft: true }, 'The owner’s scheduled text.')
  assert.equal((await applySchedule('blog', 'sched-draft', { publishAt: at, unpublishAt: null })).ok, true)
  await w.item('blog', 'sched-changes', { title: 'Live post', date: '2026-04-01' }, 'Published text.')
  w.pending('blog', 'sched-changes', { title: 'Live post', date: '2026-04-01' }, 'The owner’s scheduled changes.')
  assert.equal((await applySchedule('blog', 'sched-changes', { publishAt: at, unpublishAt: null })).ok, true)
  await w.item('blog', 'shared-draft', { title: 'Shared draft', date: '2026-05-02', draft: true }, 'The text reviewers read.')
  const { createReviewLink } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'shared-draft', variant: 'draft', ttlHours: 24 }).ok, true)
  await w.item('blog', 'shared-live', { title: 'Shared live', date: '2026-04-02' }, 'Published.')
  w.pending('blog', 'shared-live', { title: 'Shared live', date: '2026-04-02' }, 'Changes reviewers read.')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'shared-live', variant: 'changes', ttlHours: 24 }).ok, true)
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

const stateOf = (slug: string) => JSON.stringify({ live: admin.readOne('blog', slug), pending: pending.getPendingRevision('blog', slug) })
const versionOf = async (slug: string) => (await tools.data('get_content', { collection: 'blog', ref: slug, include_body: false }, 'draft')).version as string

async function counts() {
  const { getAiDb } = await import('../lib/ai/db')
  const { getAuditDb } = await import('../lib/audit/db')
  return {
    changes: (getAiDb().prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n,
    audit: (getAuditDb().prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n,
  }
}

for (const level of ['draft', 'propose'] as Level[]) {
  test(`at ${level} level: a scheduled draft and scheduled changes answer ITEM_SCHEDULED; nothing is stored`, async () => {
    const before = await counts()
    for (const slug of ['sched-draft', 'sched-changes']) {
      const state = stateOf(slug)
      const out = await tools.call('edit_content', { collection: 'blog', slug, edits: [{ find: 'The owner’s', replace: 'The model’s' }], base_version: await versionOf(slug) }, level)
      assert.equal(out.code, 'ITEM_SCHEDULED', out.text)
      assert.equal(out.json.error.scheduled_at, new Date(at).toISOString())
      assert.match(out.json.error.message, /owner|unschedule/)
      assert.equal(stateOf(slug), state, `${slug}: nothing stored`)
      const fm = await tools.call('edit_content', { collection: 'blog', slug, frontmatter_patch: { description: 'Sneaked in' }, base_version: await versionOf(slug) }, level)
      assert.equal(fm.code, 'ITEM_SCHEDULED')
      assert.equal(stateOf(slug), state)
    }
    assert.deepEqual(await counts(), before, 'no change row, no activity row')
  })

  test(`at ${level} level: an item shown by active review links answers ITEM_IN_REVIEW; the review page reads the same text`, async () => {
    const { listReviewLinks } = await import('../lib/review/store')
    const { getAuthDb } = await import('../lib/adminAuth/db')
    for (const slug of ['shared-draft', 'shared-live']) {
      const state = stateOf(slug)
      const out = await tools.call('edit_content', { collection: 'blog', slug, body: 'Replaced by a model.', base_version: await versionOf(slug) }, level)
      assert.equal(out.code, 'ITEM_IN_REVIEW', out.text)
      assert.equal(out.json.error.active_review_links, 1)
      assert.equal(stateOf(slug), state)
      assert.equal(listReviewLinks({ collection: 'blog', slugs: [slug] }).length, 1, 'the link stays active')
    }
    // What the review page renders for each link (pages/review/[token] → the article's getStaticProps with the
    // link's variant → lib/mdx getPost with lib/review/render's read options): the stored text, unchanged.
    const { reviewTarget } = await import('../lib/review/store')
    const { reviewReadOptions } = await import('../lib/review/render')
    const { getPost } = await import('../lib/mdx')
    const links = getAuthDb().prepare("SELECT collection, slug, variant FROM review_links WHERE slug IN ('shared-draft', 'shared-live') ORDER BY slug").all() as Array<{ collection: 'blog'; slug: string; variant: 'draft' | 'changes' }>
    assert.equal(links.length, 2)
    for (const link of links) {
      const target = reviewTarget(link)
      assert.equal(target.kind, 'render', link.slug)
      if (target.kind !== 'render') continue
      const rendered = await getPost(target.slug, reviewReadOptions({ variant: target.variant }))
      assert.match(JSON.stringify(rendered), link.slug === 'shared-draft' ? /The text reviewers read\./ : /Changes reviewers read\./)
      assert.doesNotMatch(JSON.stringify(rendered), /Replaced by a model/)
    }
  })
}

test('saving drafts without asking does not matter: a held item is refused either way', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  for (const auto of [1, 0]) {
    getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = ? WHERE id = 1').run(auto)
    const out = await tools.call('edit_content', { collection: 'blog', slug: 'sched-draft', body: 'x', base_version: await versionOf('sched-draft') }, 'draft')
    assert.equal(out.code, 'ITEM_SCHEDULED', `auto_apply_drafts ${auto}`)
  }
  getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 1 WHERE id = 1').run()
})

test('when the time comes, the scheduler publishes the owner’s text, exactly as stored', async () => {
  const { runDueSchedules } = await import('../lib/schedule/run')
  const recorded: string[] = []
  const out = await runDueSchedules({ now: () => at + 1000, refresh: async () => undefined, record: (entry) => recorded.push(entry.action) })
  assert.deepEqual(out.actions.map((a) => [a.slug, a.outcome]).sort(), [
    ['sched-changes', 'published-changes'],
    ['sched-draft', 'published'],
  ])
  assert.equal(admin.readOne('blog', 'sched-draft')?.body, 'The owner’s scheduled text.')
  assert.equal(admin.readOne('blog', 'sched-changes')?.body, 'The owner’s scheduled changes.')
  assert.ok(!JSON.stringify([admin.readOne('blog', 'sched-draft'), admin.readOne('blog', 'sched-changes')]).includes('model'))
})

test('the held refusal names the way forward, and get_content told the model beforehand', async () => {
  const shared = await tools.data('get_content', { collection: 'blog', ref: 'shared-draft' }, 'draft')
  assert.equal(shared.in_review, true, 'a writer knows before it tries')
  const out = await tools.call('edit_content', { collection: 'blog', slug: 'shared-draft', body: 'x', base_version: shared.version }, 'draft')
  assert.match(out.json.error.message, /Ask the owner/)
  assert.equal(out.json.error.edit_url, '/admin/blog/edit?slug=shared-draft')
})

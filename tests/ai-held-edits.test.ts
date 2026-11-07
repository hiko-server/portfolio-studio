/**
 * M2 + M3 — held items (design §4.6, §12.1): an item that would reach
 * someone without the owner's approval is never edited in place by AI,
 * whatever saving drafts without asking says.
 *
 *   - a scheduled draft, and a published item's scheduled changes: the
 *     scheduler publishes exactly the stored revision, with no card for the
 *     owner. An item shown by active review links: the link shows the stored
 *     text to anyone holding it.
 *   - Without content:propose, edit_content answers ITEM_SCHEDULED or
 *     ITEM_IN_REVIEW and stores nothing.
 *   - With content:propose, the edit becomes a waiting change (kind
 *     item.edit-held, risk live): nothing is stored, the scheduler publishes
 *     the owner's text, the review page reads the same text.
 *   - The owner approves it on the site: it is saved through the same draft
 *     path, keeping the schedule, and when the schedule runs, the activity
 *     line says the published text was AI-edited and which browser approved
 *     it.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters, type Level } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-held-edits', 'ai-held-edits-secret-0123456789abcdef0123456789')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>
let admin: typeof import('../lib/mdx-admin')
let pending: typeof import('../lib/pendingRevisions')
const DAY = 86_400_000
const at = Date.now() + 3 * DAY
/** The items the owner approves an edit of are scheduled a day later, so the first scheduler run leaves them. */
const later = at + DAY

before(async () => {
  await h.setup()
  admin = await import('../lib/mdx-admin')
  pending = await import('../lib/pendingRevisions')
  const { applySchedule } = await import('../lib/schedule/store')
  const w = await storeWriters()
  for (const [prefix, when] of [['sched', at], ['approve', later]] as const) {
    await w.item('blog', `${prefix}-draft`, { title: 'Scheduled draft', date: '2026-05-01', draft: true }, 'The owner’s scheduled text.')
    assert.equal((await applySchedule('blog', `${prefix}-draft`, { publishAt: when, unpublishAt: null })).ok, true)
    await w.item('blog', `${prefix}-changes`, { title: 'Live post', date: '2026-04-01' }, 'Published text.')
    w.pending('blog', `${prefix}-changes`, { title: 'Live post', date: '2026-04-01' }, 'The owner’s scheduled changes.')
    assert.equal((await applySchedule('blog', `${prefix}-changes`, { publishAt: when, unpublishAt: null })).ok, true)
  }
  await w.item('blog', 'shared-draft', { title: 'Shared draft', date: '2026-05-02', draft: true }, 'The text reviewers read.')
  const { createReviewLink } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'shared-draft', variant: 'draft', ttlHours: 24 }).ok, true)
  await w.item('blog', 'shared-live', { title: 'Shared live', date: '2026-04-02' }, 'Published.')
  w.pending('blog', 'shared-live', { title: 'Shared live', date: '2026-04-02' }, 'Changes reviewers read.')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'shared-live', variant: 'changes', ttlHours: 24 }).ok, true)
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
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
    waiting: (getAiDb().prepare("SELECT count(*) AS n FROM ai_changes WHERE state = 'waiting'").get() as { n: number }).n,
    audit: (getAuditDb().prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n,
  }
}

async function changeOf(id: string) {
  const { getAiDb } = await import('../lib/ai/db')
  return getAiDb().prepare('SELECT state, risk, kind, tool FROM ai_changes WHERE id = ?').get(id) as { state: string; risk: string; kind: string; tool: string }
}

test('at draft level: a scheduled draft and scheduled changes answer ITEM_SCHEDULED; nothing is stored', async () => {
  const before = await counts()
  for (const slug of ['sched-draft', 'sched-changes']) {
    const state = stateOf(slug)
    const out = await tools.call('edit_content', { collection: 'blog', slug, edits: [{ find: 'The owner’s', replace: 'The model’s' }], base_version: await versionOf(slug) }, 'draft')
    assert.equal(out.code, 'ITEM_SCHEDULED', out.text)
    assert.equal(out.json.error.scheduled_at, new Date(at).toISOString())
    assert.match(out.json.error.message, /owner|unschedule/)
    assert.equal(stateOf(slug), state, `${slug}: nothing stored`)
    const fm = await tools.call('edit_content', { collection: 'blog', slug, frontmatter_patch: { description: 'Sneaked in' }, base_version: await versionOf(slug) }, 'draft')
    assert.equal(fm.code, 'ITEM_SCHEDULED')
    assert.equal(stateOf(slug), state)
  }
  assert.deepEqual(await counts(), before, 'no change row, no activity row')
})

test('at draft level: an item shown by active review links answers ITEM_IN_REVIEW; the link stays active', async () => {
  const { listReviewLinks } = await import('../lib/review/store')
  for (const slug of ['shared-draft', 'shared-live']) {
    const state = stateOf(slug)
    const out = await tools.call('edit_content', { collection: 'blog', slug, body: 'Replaced by a model.', base_version: await versionOf(slug) }, 'draft')
    assert.equal(out.code, 'ITEM_IN_REVIEW', out.text)
    assert.equal(out.json.error.active_review_links, 1)
    assert.equal(stateOf(slug), state)
    assert.equal(listReviewLinks({ collection: 'blog', slugs: [slug] }).length, 1, 'the link stays active')
  }
})

/** What a review link renders for each link (pages/review/[token] with lib/review/render's read options). */
async function reviewTexts() {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { reviewTarget } = await import('../lib/review/store')
  const { reviewReadOptions } = await import('../lib/review/render')
  const { getPost } = await import('../lib/mdx')
  const links = getAuthDb().prepare("SELECT collection, slug, variant FROM review_links WHERE slug IN ('shared-draft', 'shared-live') ORDER BY slug").all() as Array<{ collection: 'blog'; slug: string; variant: 'draft' | 'changes' }>
  assert.equal(links.length, 2)
  const out: Record<string, string> = {}
  for (const link of links) {
    const target = reviewTarget(link)
    assert.equal(target.kind, 'render', link.slug)
    if (target.kind !== 'render') continue
    out[link.slug] = JSON.stringify(await getPost(target.slug, reviewReadOptions({ variant: target.variant })))
  }
  return out
}

test('at propose level: a held edit becomes a waiting change (item.edit-held, risk live); nothing is stored; the review page reads the same text', async () => {
  const before = await counts()
  const ids: string[] = []
  for (const slug of ['sched-draft', 'sched-changes', 'shared-draft', 'shared-live']) {
    const state = stateOf(slug)
    const out = await tools.call('edit_content', { collection: 'blog', slug, edits: [{ find: slug.startsWith('sched') ? 'The owner’s' : 'reviewers read', replace: slug.startsWith('sched') ? 'The model’s' : 'a model wrote' }], base_version: await versionOf(slug) }, 'propose')
    assert.equal(out.ok, true, out.text)
    assert.equal(out.json.status, 'waiting_for_owner')
    assert.equal(out.json.held, slug.startsWith('sched') ? 'scheduled' : 'review_link')
    assert.match(out.json.message, /Not applied/)
    assert.match(out.json.review_url, /\/ai\/review\/ch_[a-z2-7]{16}$|\/admin\/ai\/change\/ch_[a-z2-7]{16}$/)
    assert.equal(stateOf(slug), state, `${slug}: nothing stored`)
    assert.deepEqual(await changeOf(out.json.change_id), { state: 'waiting', risk: 'live', kind: 'item.edit-held', tool: 'edit_content' })
    // The card says why it waits.
    const card = await routes.card(out.json.change_id)
    assert.equal(card.statusCode, 200)
    assert.deepEqual(card.body.preview.effects.schedule, slug.startsWith('sched') ? { held: 'scheduled', publish_at: new Date(at).toISOString() } : { held: 'review_link', active_links: 1 })
    ids.push(out.json.change_id)
  }
  const texts = await reviewTexts()
  assert.match(texts['shared-draft'], /The text reviewers read\./)
  assert.match(texts['shared-live'], /Changes reviewers read\./)
  assert.doesNotMatch(JSON.stringify(texts), /a model wrote/)
  const after = await counts()
  assert.equal(after.waiting - before.waiting, 4)
  assert.equal(after.audit, before.audit, 'a proposal writes no activity row: nothing changed')
  // Leave them waiting for the scheduler test below, but reject the review-link ones explicitly.
  for (const id of ids.slice(2)) assert.equal((await routes.reject(id, 'Not while it is being reviewed.')).statusCode, 200)
})

test('saving drafts without asking does not matter: a held item waits with content:propose and is refused without it', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  for (const auto of [1, 0]) {
    getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = ? WHERE id = 1').run(auto)
    const refused = await tools.call('edit_content', { collection: 'blog', slug: 'sched-draft', body: `x ${auto}`, base_version: await versionOf('sched-draft') }, 'draft')
    assert.equal(refused.code, 'ITEM_SCHEDULED', `auto_apply_drafts ${auto}`)
    const waits = await tools.call('edit_content', { collection: 'blog', slug: 'sched-draft', body: `y ${auto}`, base_version: await versionOf('sched-draft') }, 'propose', { grant: tools.grantAt('propose') })
    assert.equal(waits.json?.status, 'waiting_for_owner', `auto_apply_drafts ${auto}: ${waits.text}`)
    assert.equal((await changeOf(waits.json.change_id)).kind, 'item.edit-held')
  }
  getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 1 WHERE id = 1').run()
})

test('when the time comes, the scheduler publishes the owner’s text, exactly as stored, while the AI edits still wait', async () => {
  const { runDueSchedules } = await import('../lib/schedule/run')
  const { withAiProvenance } = await import('../lib/ai/provenance')
  const recorded: string[] = []
  const out = await runDueSchedules({
    now: () => at + 1000,
    refresh: async () => undefined,
    record: (entry, _snapshots, source) => recorded.push((source ? withAiProvenance(entry, source) : entry).summary),
  })
  const mine = out.actions.filter((a) => a.slug.startsWith('sched-'))
  assert.deepEqual(mine.map((a) => [a.slug, a.outcome]).sort(), [
    ['sched-changes', 'published-changes'],
    ['sched-draft', 'published'],
  ])
  assert.equal(admin.readOne('blog', 'sched-draft')?.body, 'The owner’s scheduled text.')
  assert.equal(admin.readOne('blog', 'sched-changes')?.body, 'The owner’s scheduled changes.')
  assert.ok(!JSON.stringify([admin.readOne('blog', 'sched-draft'), admin.readOne('blog', 'sched-changes')]).includes('model'))
  for (const line of recorded.filter((l) => /sched|Scheduled draft|Live post/.test(l))) assert.doesNotMatch(line, /AI-edited/, 'the owner’s own text')
})

test('a waiting held edit cannot be approved after the scheduler published the item: conflict, nothing written', async () => {
  const { getAiDb } = await import('../lib/ai/db')
  const rows = getAiDb().prepare("SELECT id FROM ai_changes WHERE state = 'waiting' AND target_ref = 'sched-draft' ORDER BY created_at").all() as Array<{ id: string }>
  assert.ok(rows.length >= 1)
  const state = stateOf('sched-draft')
  const out = await routes.approve(rows[0].id)
  assert.equal(out.statusCode, 409, JSON.stringify(out.body))
  assert.equal(out.body.code, 'CONFLICT')
  assert.equal((await changeOf(rows[0].id)).state, 'conflict')
  assert.equal(stateOf('sched-draft'), state)
})

test('the owner approves a held edit: saved through the draft path, the schedule kept; the scheduler then names the AI edit and the approving browser', async () => {
  const { scheduleOf } = await import('../lib/schedule/store')
  const { listAudit } = await import('../lib/audit/store')
  const ids: Record<string, string> = {}
  for (const slug of ['approve-draft', 'approve-changes']) {
    const before = scheduleOf('blog', slug)
    const live = admin.readOne('blog', slug)
    const out = await tools.call('edit_content', { collection: 'blog', slug, edits: [{ find: 'The owner’s', replace: 'The approved' }], base_version: await versionOf(slug) }, 'propose')
    assert.equal(out.json?.status, 'waiting_for_owner', out.text)
    ids[slug] = out.json.change_id
    const approved = await routes.approve(out.json.change_id)
    assert.equal(approved.statusCode, 200, JSON.stringify(approved.body))
    assert.equal(approved.body.state, 'applied')
    assert.equal((await changeOf(out.json.change_id)).state, 'applied')
    assert.deepEqual(scheduleOf('blog', slug), before, `${slug}: the schedule is kept`)
    if (slug === 'approve-draft') {
      assert.equal(admin.readOne('blog', slug)?.body, 'The approved scheduled text.')
      assert.equal(admin.readOne('blog', slug)?.frontmatter.draft, true, 'still a draft until the schedule runs')
    } else {
      assert.deepEqual(admin.readOne('blog', slug), live, 'the public row is untouched')
      assert.equal(pending.getPendingRevision('blog', slug)?.body, 'The approved scheduled changes.')
    }
    // The activity row: the draft save, by the AI actor, approved by this browser.
    const { getAuditDb } = await import('../lib/audit/db')
    const row = getAuditDb().prepare('SELECT id FROM audit_log WHERE change_id = ?').get(out.json.change_id) as { id: number } | undefined
    assert.ok(row, 'an activity row linked to the change')
    const entry = listAudit({ q: slug }).entries.find((e) => e.id === row.id)
    assert.ok(entry, 'listed in Activity')
    assert.match(String(entry.device), /^AI · .+ · approved on /)
    assert.equal(entry.route, 'admin/ai/changes')
  }
  const { runDueSchedules } = await import('../lib/schedule/run')
  const { withAiProvenance } = await import('../lib/ai/provenance')
  const recorded: Array<{ target?: string | null; summary: string }> = []
  await runDueSchedules({
    now: () => later + 1000,
    refresh: async () => undefined,
    record: (entry, _snapshots, source) => recorded.push(source ? withAiProvenance(entry, source) : entry),
  })
  const lines = recorded.filter((r) => r.target === 'approve-draft' || r.target === 'approve-changes')
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line.summary, /on schedule.*\(AI-edited, approved on .+\)$|\(AI-edited, approved on .+\)$/, line.summary)
  assert.equal(admin.readOne('blog', 'approve-draft')?.body, 'The approved scheduled text.')
  assert.equal(admin.readOne('blog', 'approve-changes')?.body, 'The approved scheduled changes.')
  // The route supplies the provenance through its record callback.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'pages/api/internal/scheduled-publish.ts'), 'utf8')
  assert.match(src, /record: \(entry, snapshots, source\) => \{\s*recordAdminAudit\(req, res, source \? withAiProvenance\(entry, source\) : entry/)
})

test('the held refusal names the way forward, and get_content told the model beforehand', async () => {
  const shared = await tools.data('get_content', { collection: 'blog', ref: 'shared-draft' }, 'draft')
  assert.equal(shared.in_review, true, 'a writer knows before it tries')
  const out = await tools.call('edit_content', { collection: 'blog', slug: 'shared-draft', body: 'x', base_version: shared.version }, 'draft' as Level)
  assert.match(out.json.error.message, /Ask the owner/)
  assert.equal(out.json.error.edit_url, '/admin/blog/edit?slug=shared-draft')
})

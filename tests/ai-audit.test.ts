/**
 * The activity log for AI writes (design §5.6, tests/ai-audit of §12.1):
 * the intent row is written BEFORE the write and refuses it when it cannot
 * be; a status-0 row is hidden for a minute, then reads as interrupted;
 * labels name the slug, never a model-written title or a body; the actor
 * shows through `device`; the AI columns are stored; Activity filters by AI.
 * Through the real drafts service on a throw-away store. (Reads never reach
 * audit_log and list_versions returns action codes only: those are tool
 * properties, tested with the tools in stage M1.)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness, type Handler } from './editorialHarness'

const h = editorialHarness('ai-audit', 'ai-audit-secret-0123456789abcdef0123456789')
let ai: typeof import('../lib/ai/audit')
let store: typeof import('../lib/audit/store')
let activity: typeof import('../lib/audit/activity')
let drafts: typeof import('../lib/contentOps/drafts')
let admin: typeof import('../lib/mdx-admin')
let pending: typeof import('../lib/pendingRevisions')
let activityRoute: Handler

before(async () => {
  await h.setup()
  ai = await import('../lib/ai/audit')
  store = await import('../lib/audit/store')
  activity = await import('../lib/audit/activity')
  drafts = await import('../lib/contentOps/drafts')
  admin = await import('../lib/mdx-admin')
  pending = await import('../lib/pendingRevisions')
  activityRoute = (await import('../pages/api/admin/activity')).default
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

const MODEL_TITLE = 'Typo fix only, safe to approve'
const BODY_SENTINEL = 'BODY-SENTINEL words the model wrote'
const laptop = { kind: 'mcp', grantId: 'g_laptop0001', label: 'laptop token' } as const
const origin = { ipPrefix: '203.0.113.0/24', country: 'HK' }
const base = { surfaceRoute: 'mcp', tool: 'edit_content', argsSha256: 'a'.repeat(64), toolListHash: 'b'.repeat(64), requestId: 'req-1' }

const versionOf = (slug: string) => admin.itemEtag(admin.readOne('blog', slug)!.updatedAt, pending.getPendingRevision('blog', slug)?.updatedAt)
const rawRow = async (id: number) => (await import('../lib/audit/db')).getAuditDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as Record<string, unknown> | undefined

test('an AI draft edit: intent row first, hidden while in flight, then the label names the slug and the actor shows', async () => {
  const created = await drafts.createDraftItem('blog', { slug: 'example-ai-post', frontmatter: { title: 'Example post', date: '2026-05-01' }, body: 'First words.' })
  assert.equal(created.ok, true)
  const t0 = Date.now()
  const begun = ai.beginAiWrite({
    ...base,
    actor: laptop,
    origin,
    write: { route: 'admin/posts', method: 'PUT', body: { slug: 'example-ai-post', frontmatter: { title: MODEL_TITLE, date: '2026-05-01', draft: true }, body: BODY_SENTINEL } },
  })
  assert.ok(begun.ok)
  const intent = begun.ok ? begun.intent : null!
  // The row exists before the write runs: status 0, AI columns set.
  const row = (await rawRow(intent.id))!
  assert.equal(row.status, 0)
  assert.deepEqual(
    [row.actor_kind, row.ai_client, row.ai_grant_id, row.tool, row.args_sha256, row.tool_list_hash, row.route, row.method, row.ip_prefix, row.country, row.session_id],
    ['mcp', 'laptop token', 'g_laptop0001', 'edit_content', 'a'.repeat(64), 'b'.repeat(64), 'mcp', 'PUT', '203.0.113.0/24', 'HK', null],
  )
  assert.equal(row.device, 'AI · laptop token')
  // In flight: not listed, not counted.
  assert.equal(store.listAudit({ now: t0 }).entries.some((e) => e.id === intent.id), false)
  assert.equal(activity.activityPage({ now: t0 }).items.some((i) => i.id === `a:${intent.id}`), false)
  assert.equal(activity.activityPage({ now: t0 }).ai, 0)

  const out = await intent.run(() =>
    drafts.saveDraftEdit('blog', { slug: 'example-ai-post', baseVersion: versionOf('example-ai-post'), body: BODY_SENTINEL, frontmatterPatch: { title: MODEL_TITLE } }),
  )
  assert.equal(out.ok, true)
  assert.equal(intent.finish(200), true)
  assert.equal(intent.finish(200), false, 'once')

  const entry = store.listAudit({ actor: 'ai' }).entries.find((e) => e.id === intent.id)
  assert.ok(entry)
  assert.deepEqual([entry.action, entry.area, entry.target, entry.status, entry.actorKind, entry.interrupted], ['post.save', 'post', 'example-ai-post', 200, 'mcp', false])
  assert.equal(entry.summary, 'Saved post “example-ai-post”')
  for (const text of [entry.summary, entry.target ?? '', JSON.stringify(row)]) {
    assert.doesNotMatch(text, /Typo fix only|BODY-SENTINEL/)
  }
  // The version the edit replaced is linked: the history drawer names the AI actor.
  const snapshots = admin.listSnapshots('blog', 'example-ai-post').map((s) => s.filename)
  assert.equal(snapshots.length, 1)
  const note = store.versionNotes('blog', snapshots).get(snapshots[0])
  assert.equal(note?.device, 'AI · laptop token')
  assert.equal(note?.summary, 'Saved post “example-ai-post”')
})

test('a write refused before it changed anything leaves no row; one that never finished reads as interrupted', async () => {
  const before = store.listAudit({ limit: 200 }).entries.length
  const refused = ai.beginAiWrite({ ...base, actor: laptop, origin, write: { route: 'admin/posts', method: 'PUT', body: { slug: 'example-ai-post', frontmatter: {}, body: 'x' } } })
  assert.ok(refused.ok)
  const result = await refused.intent.run(() => drafts.saveDraftEdit('blog', { slug: 'example-ai-post', baseVersion: '"stale"', body: 'x' }))
  assert.equal(result.ok, false)
  refused.intent.discard()
  assert.equal(await rawRow(refused.intent.id), undefined)
  assert.equal(store.listAudit({ limit: 200 }).entries.length, before)

  const t0 = Date.now()
  const stuck = ai.beginAiWrite({ ...base, actor: laptop, origin, write: { route: 'admin/posts', method: 'PUT', body: { slug: 'example-ai-post', frontmatter: {}, body: 'y' } } }, t0)
  assert.ok(stuck.ok)
  assert.equal(store.listAudit({ now: t0 + 59_000 }).entries.some((e) => e.id === stuck.intent.id), false, 'hidden for a minute')
  const later = store.listAudit({ now: t0 + 61_000 }).entries.find((e) => e.id === stuck.intent.id)
  assert.ok(later)
  assert.equal(later.interrupted, true)
  const item = activity.activityPage({ now: t0 + 61_000 }).items.find((i) => i.id === `a:${stuck.intent.id}`)
  assert.equal(item?.interrupted, true)
  // A late finish still records the outcome.
  assert.equal(stuck.intent.finish(200), true)
  assert.equal(store.listAudit({ now: t0 + 61_000 }).entries.find((e) => e.id === stuck.intent.id)?.interrupted, false)
})

test('fail closed: an unwritable activity log or an unlabelled write refuses before anything is written', async () => {
  const { closeAuditDb, auditDbPath } = await import('../lib/audit/db')
  closeAuditDb()
  const file = auditDbPath()
  const aside = `${file}.aside`
  for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(p)) fs.renameSync(p, `${p}.aside`)
  fs.mkdirSync(file)
  let ran = false
  try {
    const r = ai.beginAiWrite({ ...base, actor: laptop, origin, write: { route: 'admin/posts', method: 'PUT', body: { slug: 'example-ai-post', frontmatter: {}, body: 'z' } } })
    assert.deepEqual(r, { ok: false, code: 'AUDIT_UNAVAILABLE' })
    if (r.ok) ran = true
  } finally {
    fs.rmdirSync(file)
    for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(`${p}.aside`)) fs.renameSync(`${p}.aside`, p)
    closeAuditDb()
  }
  assert.equal(ran, false)
  assert.equal(fs.existsSync(aside), false)
  // A write no label describes is refused the same way.
  assert.deepEqual(ai.beginAiWrite({ ...base, actor: laptop, origin, write: { route: 'admin/unknown', method: 'PUT', body: {} } }), { ok: false, code: 'AUDIT_UNAVAILABLE' })
  assert.deepEqual(ai.beginAiWrite({ ...base, actor: laptop, origin, write: { route: 'admin/posts', method: 'GET', body: {} } }), { ok: false, code: 'AUDIT_UNAVAILABLE' })
})

test('actor labels: owner label or provider and model, approvals read as the approving browser, text is cleaned and capped', () => {
  assert.equal(ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: 'claude.ai' }), 'AI · claude.ai')
  assert.equal(ai.aiDeviceLabel({ kind: 'assistant', runId: 'r1', conversationId: 'c1', sessionId: 's1', provider: 'DeepSeek', model: 'deepseek-v4-pro' }), 'AI · DeepSeek · deepseek-v4-pro')
  assert.equal(ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: 'claude.ai' }, 'Chrome on macOS'), 'AI · claude.ai · approved on Chrome on macOS')
  assert.equal(ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: 'claude.ai' }, ''), 'AI · claude.ai · approved on this browser')
  assert.equal(ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: 'claude.ai' }, null), 'AI · claude.ai', 'no approval')
  // Line breaks, bidi controls, zero-width and TAG characters never reach the log; long names are capped.
  const hostile = `laptop\ntoken\u202eevil\u200b\u{e0041}x`
  const cleaned = ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: hostile })
  assert.equal(cleaned, 'AI · laptop token evil x')
  assert.equal(Array.from(ai.cleanLabelPart('x'.repeat(500), 48)).length, 48)
  assert.equal(ai.aiDeviceLabel({ kind: 'mcp', grantId: 'g1', label: '\n\u200b' }), 'AI · connected app')
})

test('labels: the route twin\'s words with the slug for any AI title; a ready entry is validated', () => {
  const describe = ai.describeAiWrite
  assert.equal(
    describe({ route: 'admin/posts', method: 'PUT', body: { slug: 'new-one', create: true, frontmatter: { title: MODEL_TITLE, draft: true } } })?.summary,
    'Created draft post “new-one”',
  )
  assert.equal(
    describe({ route: 'admin/work', method: 'PUT', body: { slug: 'study', target: 'pending', frontmatter: { title: MODEL_TITLE } } })?.summary,
    'Saved unpublished changes to case study “study”',
  )
  assert.equal(describe({ route: 'admin/posts', method: 'POST', body: { slug: 'new-one', action: 'schedule', publishAt: null, unpublishAt: null } })?.action, 'post.unschedule')
  assert.deepEqual(describe({ entry: { action: 'media.texts', area: 'media', target: 'photo.webp', summary: 'Changed the texts of photo.webp' } }), {
    action: 'media.texts',
    area: 'media',
    target: 'photo.webp',
    summary: 'Changed the texts of photo.webp',
  })
  assert.equal(describe({ entry: { action: 'Bad Action', area: 'media', summary: 'x' } }), null)
})

test('approvals and the assistant: session, approval time and the run are stored; Activity filters by AI', async () => {
  const at = Date.now()
  const approved = ai.beginAiWrite({
    ...base,
    actor: { kind: 'mcp', grantId: 'g_claude0001', label: 'claude.ai' },
    origin,
    surfaceRoute: 'admin/ai/changes',
    tool: 'propose_publishing',
    changeId: 'ch_abcdefghijklmnop',
    approval: { sessionId: 'sess-approver', device: 'Chrome on macOS', at },
    write: { route: 'admin/posts', method: 'POST', body: { slug: 'example-ai-post', action: 'schedule', publishAt: null, unpublishAt: null } },
  })
  assert.ok(approved.ok)
  approved.intent.finish()
  // An approving browser with no device label still reads as approved, never as AI acting alone.
  const unlabelled = ai.beginAiWrite({
    ...base,
    actor: { kind: 'mcp', grantId: 'g_claude0001', label: 'claude.ai' },
    origin,
    approval: { sessionId: 'sess-approver', device: null, at },
    write: { route: 'admin/posts', method: 'POST', body: { slug: 'example-ai-post', action: 'schedule', publishAt: null, unpublishAt: null } },
  })
  assert.ok(unlabelled.ok)
  assert.equal((await rawRow(unlabelled.intent.id))!.device, 'AI · claude.ai · approved on this browser')
  unlabelled.intent.discard()
  const a = (await rawRow(approved.intent.id))!
  assert.deepEqual([a.device, a.session_id, a.approved_by_session, a.approved_at, a.change_id, a.route], [
    'AI · claude.ai · approved on Chrome on macOS',
    'sess-approver',
    'sess-approver',
    at,
    'ch_abcdefghijklmnop',
    'admin/ai/changes',
  ])

  const assistant = ai.beginAiWrite({
    ...base,
    actor: { kind: 'assistant', runId: 'run_1', conversationId: 'conv_1', sessionId: 'sess-owner', provider: 'DeepSeek', model: 'deepseek-v4-pro' },
    origin,
    surfaceRoute: 'admin/ai/runs',
    write: { route: 'admin/posts', method: 'PUT', body: { slug: 'assistant-draft', create: true, frontmatter: { title: MODEL_TITLE, draft: true } } },
  })
  assert.ok(assistant.ok)
  assistant.intent.finish()
  const b = (await rawRow(assistant.intent.id))!
  assert.deepEqual([b.actor_kind, b.ai_provider, b.ai_model, b.ai_run_id, b.session_id, b.ai_grant_id, b.device], [
    'assistant',
    'DeepSeek',
    'deepseek-v4-pro',
    'run_1',
    'sess-owner',
    null,
    'AI · DeepSeek · deepseek-v4-pro',
  ])

  // A person's own write and a sign-in: present in "Everything", absent from the AI filter.
  store.recordAudit({ action: 'post.save', area: 'post', target: 'by-hand', summary: 'Saved post “by-hand”', method: 'PUT', route: 'admin/posts', status: 200, requestId: null, sessionId: 's', device: 'Safari on macOS', ipPrefix: null, country: null })
  const everything = activity.activityPage({})
  assert.ok(everything.items.some((i) => i.target === 'by-hand' && i.actorKind === null))
  const byAi = activity.activityPage({ actor: 'ai' })
  assert.ok(byAi.items.length >= 3)
  assert.ok(byAi.items.every((i) => i.kind === 'write' && (i.actorKind === 'mcp' || i.actorKind === 'assistant')))
  assert.equal(byAi.ai, everything.ai)
  assert.ok(everything.ai >= 3)
  // Through the route, as the Activity view asks.
  const res = await h.call(activityRoute, { method: 'GET', query: { actor: 'ai' } })
  assert.equal(res.statusCode, 200)
  assert.ok((res.body.items as Array<{ actorKind: string | null }>).every((i) => i.actorKind !== null))
  assert.equal(res.body.ai, everything.ai)
  const all = await h.call(activityRoute, { method: 'GET', query: {} })
  assert.ok((all.body.items as Array<{ target: string | null }>).some((i) => i.target === 'by-hand'))
})

test('the ai area and the Activity filter choices appear only once there is something to show', async () => {
  const { AUDIT_AREAS, AUDIT_AREA_LABEL, auditTargetHref } = await import('../lib/audit/describe')
  const { activityFilterOptions, activityFilterParams, AI_ACTOR_FILTER } = await import('../components/Admin/system/activityFormat')
  assert.ok((AUDIT_AREAS as readonly string[]).includes('ai'))
  assert.equal(AUDIT_AREA_LABEL.ai, 'AI access')
  assert.equal(auditTargetHref('ai', null), '/admin/ai')
  const none = activityFilterOptions(AUDIT_AREAS, AUDIT_AREA_LABEL, { post: 2 }, 0, '')
  assert.equal(none.some((o) => o.value === 'ai' || o.value === AI_ACTOR_FILTER), false, 'a site without AI shows no AI filter')
  assert.equal(none.at(-1)?.value, 'session', 'sign-ins stay last')
  assert.equal(none.find((o) => o.value === 'post')?.label, 'Posts (2 in 30 days)')
  const some = activityFilterOptions(AUDIT_AREAS, AUDIT_AREA_LABEL, { ai: 1 }, 4, '')
  assert.ok(some.some((o) => o.value === 'ai' && o.label === 'AI access (1 in 30 days)'))
  assert.deepEqual(some.at(-1), { value: AI_ACTOR_FILTER, label: 'Changes made by AI (4 in 30 days)' })
  // A selected choice stays offered even when its count drops to zero.
  assert.ok(activityFilterOptions(AUDIT_AREAS, AUDIT_AREA_LABEL, {}, 0, AI_ACTOR_FILTER).some((o) => o.value === AI_ACTOR_FILTER))
  assert.deepEqual(activityFilterParams(AI_ACTOR_FILTER), { actor: 'ai' })
  assert.deepEqual(activityFilterParams('post'), { area: 'post' })
  assert.deepEqual(activityFilterParams(''), {})
  // The view uses them (and keeps the keyboard list and its tokens).
  const panel = fs.readFileSync(path.join(import.meta.dirname, '..', 'components/Admin/system/ActivityPanel.tsx'), 'utf8')
  assert.match(panel, /activityFilterOptions\(AUDIT_AREAS, AUDIT_AREA_LABEL, areas, aiCount, area, aiRetained\)/)
  assert.match(panel, /aiRetained\?\.writes === true/)
  assert.match(panel, /item\.interrupted/)
})

test('the AI filters stay offered while the kept log holds an AI row, however old: 45 days, 399 days, not 401', async () => {
  const { AUDIT_AREAS, AUDIT_AREA_LABEL } = await import('../lib/audit/describe')
  const { activityFilterOptions, AI_ACTOR_FILTER } = await import('../components/Admin/system/activityFormat')
  const { getAuditDb } = await import('../lib/audit/db')
  const offered = (page: import('../lib/audit/activity').ActivityPage) => {
    const values = activityFilterOptions(AUDIT_AREAS, AUDIT_AREA_LABEL, page.areas, page.ai, '', page.aiRetained).map((o) => o.value)
    return { writes: values.includes(AI_ACTOR_FILTER), area: values.includes('ai') }
  }
  // A store of its own moment: everything earlier in this file is "now"; look from far enough ahead that it is not.
  const DAY = 86_400_000
  getAuditDb().exec('DELETE FROM audit_snapshots; DELETE FROM audit_log')
  const now = Date.now()
  const nothing = activity.activityPage({ now })
  assert.deepEqual(nothing.aiRetained, { writes: false, area: false })
  assert.deepEqual(offered(nothing), { writes: false, area: false }, 'a site without AI rows offers no AI filter')

  const aiColumns = { actorKind: 'mcp' as const, client: 'laptop token', grantId: 'g_laptop0001', provider: null, model: null, runId: null, tool: 'edit_content', argsSha256: 'a'.repeat(64), toolListHash: 'b'.repeat(64), changeId: null, approvedBySession: null, approvedAt: null }
  const entry = { route: 'mcp', method: 'PUT', status: 200, requestId: null, sessionId: null, device: 'AI · laptop token', ipPrefix: null, country: null }
  store.recordAudit({ ...entry, action: 'post.save', area: 'post', target: 'old-ai-edit', summary: 'Saved changes to post “old-ai-edit”', ai: aiColumns }, now - 45 * DAY)
  store.recordAudit({ ...entry, route: 'admin/ai/settings', method: 'PATCH', action: 'ai.enable', area: 'ai', target: null, summary: 'Turned on AI access' }, now - 45 * DAY)
  const old = activity.activityPage({ now })
  assert.equal(old.ai, 0, 'nothing in the last 30 days')
  assert.equal(old.areas.ai ?? 0, 0)
  assert.deepEqual(old.aiRetained, { writes: true, area: true })
  assert.deepEqual(offered(old), { writes: true, area: true }, 'a 45-day-old AI write can still be filtered for')
  const label = activityFilterOptions(AUDIT_AREAS, AUDIT_AREA_LABEL, old.areas, old.ai, '', old.aiRetained)
  assert.ok(label.some((o) => o.value === AI_ACTOR_FILTER && o.label === 'Changes made by AI'), 'no "0 in 30 days" count')
  assert.ok(label.some((o) => o.value === 'ai' && o.label === 'AI access'))
  // The filter shows it, through the route too.
  assert.ok(activity.activityPage({ actor: 'ai', now }).items.some((i) => i.target === 'old-ai-edit'))
  const res = await h.call(activityRoute, { method: 'GET', query: {} })
  assert.deepEqual(res.body.aiRetained, { writes: true, area: true })

  // Still inside the 400 kept days: offered. Past them (pruned or not): not.
  assert.deepEqual(offered(activity.activityPage({ now: now - 45 * DAY + 399 * DAY })), { writes: true, area: true })
  assert.deepEqual(activity.activityPage({ now: now - 45 * DAY + 401 * DAY }).aiRetained, { writes: false, area: false })
})

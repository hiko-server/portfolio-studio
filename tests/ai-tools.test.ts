/**
 * M1 — the read tools and executeTool on a throw-away store (design §4.1,
 * §4.2): metadata (names, static ASCII descriptions, annotations), every
 * wire schema inside the profile, the input rules every surface shares
 * (unknown keys, `__proto__`, types), each tool's happy path and access
 * rules, paging under the 64 KiB result cap, and what executeTool adds:
 * the switches, the scope check, budgets, the expensive reads' cache, the
 * loop guard, invisible characters stripped, and the call log.
 *
 * Writes (versions, frontmatter refusals, edit limits, translations) are
 * stage M2's part of this suite.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { editorialHarness, type Handler } from './editorialHarness'
import { ROOT } from './helpers/importGraph'
import { aiToolCaller, storeWriters } from './helpers/aiTools'

const h = editorialHarness('ai-tools', 'ai-tools-secret-0123456789abcdef0123456789')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let registry: typeof import('../lib/ai/registry')
let posts: Handler
const NOW = Date.now()

before(async () => {
  await h.setup()
  registry = await import('../lib/ai/registry')
  posts = (await import('../pages/api/admin/posts')).default
  const w = await storeWriters()
  // Posts: published, draft, live with unpublished changes, a scheduled draft, a draft shown by a review link.
  await w.item('blog', 'hello-world', { title: 'Hello world', date: '2026-05-01', tags: ['Edge AI', 'notes'], description: 'A first post', cover: '/uploads/cover.webp' }, 'Intro text.\n\n![A field](/uploads/field.webp)\n')
  await w.item('blog', 'draft-note', { title: 'Draft note', date: '2026-05-02', draft: true, tags: ['secret-tag'] }, 'Not yet.\n\n![x](/uploads/draft-only.webp)')
  await w.item('blog', 'live-pending', { title: 'Live pending', date: '2026-04-01', tags: ['notes'] }, 'Live text.')
  w.pending('blog', 'live-pending', { title: 'Live pending v2', date: '2026-04-01', tags: ['notes'] }, 'Pending zebra text.')
  const soon = new Date(NOW + 7 * 86_400_000).toISOString()
  await w.item('blog', 'scheduled-draft', { title: 'Scheduled draft', date: '2026-05-03', draft: true, publishAt: soon }, 'Goes live soon.')
  await w.item('blog', 'in-review', { title: 'In review', date: '2026-05-04', draft: true }, 'Shared draft.')
  const { createReviewLink } = await import('../lib/review/store')
  assert.equal(createReviewLink({ collection: 'blog', slug: 'in-review', variant: 'draft', ttlHours: 24 }).ok, true)
  await w.item('blog', 'chinese-post', { title: '中文文章', date: '2026-03-01', lang: 'zh-Hans' }, '这是一个很长的中文正文。'.repeat(3000))
  await w.item('work', 'case-one', { title: 'Case one', tech: ['TypeScript'], status: 'live' }, 'Case study text with an invisible ‮flip and a tag \u{E0041}char.')
  await w.page('now', { title: 'Now' }, 'Working on the site.')
  await w.kv('home', {
    hero: { welcome: 'Hi', brand: 'Example Person', tagline: 'Engineer | Writer', avatarUrl: '/uploads/avatar.webp', phone: '+852 0000 0000', email: 'owner@example.test' },
    socials: { github: 'https://github.com/example', whatsapp: 'https://wa.me/85200000000' },
    brands: [],
    quickAccess: [{ label: 'Blog', url: '/blog' }],
    photos: [{ url: '/uploads/field.webp', describe: 'A field' }, { url: '/uploads/hidden-photo.webp', describe: 'Hidden one', visible: false }],
  })
  await w.kv('cvdata', {
    en: [
      { sessionName: 'personalInformation', firstName: 'Example', lastName: 'Person', email: 'owner@example.test', phoneNumber: '+852 0000 0000', address: 'Example Street 1', introduction: 'Hello there.' },
      {
        sessionName: 'workExperience',
        experiences: [
          { uid: 'exp-public', jobTitle: 'Engineer', companyName: 'Example Co', startDate: '2024-01', features: [] },
          { uid: 'exp-hidden', jobTitle: 'Hidden role', companyName: 'Hidden Co', isVisible: false, features: [] },
        ],
      },
    ],
    zh: [{ sessionName: 'personalInformation', firstName: '例', lastName: '人', introduction: '你好。' }],
  })
  w.asset('field.webp', 2048, 1600, 900)
  w.asset('cover.webp')
  w.asset('avatar.webp')
  w.asset('hidden-photo.webp')
  w.asset('draft-only.webp')
  w.asset('orphan.webp')
  await w.kv('media-library', { v: 1, items: { 'field.webp': { alt: 'A green field', altZh: '一片绿地', caption: '', captionZh: '', updatedAt: 5 } } })
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

// ── Metadata ─────────────────────────────────────────────────────────────

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

test('names, titles, descriptions: the name pattern, printable ASCII, all four annotations, read tools annotated as reads', () => {
  for (const t of registry.TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{0,47}$/)
    for (const s of [t.title, t.description]) assert.match(s, PRINTABLE_ASCII, `${t.name}: ${s}`)
    assert.ok(t.description.length >= 40, `${t.name} says when to call it`)
    const a = t.wire.annotations
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) assert.equal(typeof a[k], 'boolean', `${t.name}.${k}`)
    assert.equal(a.title, t.title)
    if (t.risk === 'read') assert.deepEqual([a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint], [true, false, true, false], t.name)
    const walk = (node: any): void => {
      if (typeof node?.description === 'string') assert.match(node.description, PRINTABLE_ASCII, `${t.name}: ${node.description}`)
      for (const v of Object.values(node?.properties ?? {})) walk(v)
      if (node?.items) walk(node.items)
    }
    walk(t.wire.inputSchema)
  }
})

test('descriptions and schemas are static constants: no interpolation of runtime data in any tool module', () => {
  const dir = path.join(ROOT, 'lib/ai/tools')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
    const literal = (n: ts.Node): boolean =>
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && literal(n.left) && literal(n.right)) || (ts.isParenthesizedExpression(n) && literal(n.expression))
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ['description', 'title'].includes(n.name.text) && ts.isCallExpression(n.parent.parent) && /define(Write)?Tool/.test(n.parent.parent.expression.getText(sf))) {
        assert.ok(literal(n.initializer), `${file}: ${n.name.text} is not a literal`)
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'describe') {
        assert.ok(n.arguments.length === 1 && literal(n.arguments[0]), `${file}: .describe() takes a literal (${n.getText(sf).slice(0, 80)})`)
      }
      n.forEachChild(visit)
    }
    visit(sf)
  }
  // Content and settings change nothing in the list a model sees.
  assert.match(registry.TOOL_LIST_HASH, /^[0-9a-f]{64}$/)
})

test('every wire schema is inside the profile, and the profile check refuses what providers reject', () => {
  for (const t of registry.TOOLS) {
    assert.deepEqual(registry.wireProfileProblems(t.wire.inputSchema), [], t.name)
    assert.equal(t.wire.inputSchema.type, 'object')
    assert.equal(t.wire.inputSchema.additionalProperties, false)
    assert.ok(!JSON.stringify(t.wire.inputSchema).includes('$schema'))
  }
  const root = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, additionalProperties: false, ...extra })
  const outside = [
    root({ a: { type: 'string', minLength: 1 } }),
    root({ a: { type: 'string', pattern: '^a' } }),
    root({ a: { type: 'string', format: 'uri' } }),
    root({ a: { type: ['string', 'null'] } }),
    root({ a: { oneOf: [{ type: 'string' }] } }),
    root({ a: { $ref: '#/x' } }),
    root({ a: { type: 'array' } }),
    root({ a: { type: 'integer', maximum: 5 } }),
    root({ a: { type: 'object', properties: {}, additionalProperties: false } }),
    root({ a: { type: 'string', enum: [1, 2] } }),
    root({}, { required: ['b'] }),
    { type: 'object', properties: {} },
    { type: 'string' },
    root({ a: {} }),
  ]
  for (const s of outside) assert.notDeepEqual(registry.wireProfileProblems(s), [], JSON.stringify(s))
})

test('the wire list is filtered by scope and hashed once; three levels see 8, 14 and 14 tools', () => {
  const read = registry.wireToolsFor(new Set(['content:read']))
  const draft = registry.wireToolsFor(new Set(['content:read', 'content:draft']))
  assert.equal(read.length, 8)
  assert.equal(draft.length, 14)
  assert.deepEqual(registry.wireToolsFor(new Set(['content:read', 'content:draft', 'content:propose'])), draft)
  assert.deepEqual(read.map((t) => t.name), [...read.map((t) => t.name)].sort())
  const view = registry.catalogueView()
  assert.equal(view.length, registry.TOOLS.length)
  for (const row of view) assert.ok(!('input' in row) && !('wire' in row), row.name)
})

// ── Input rules ──────────────────────────────────────────────────────────

const MINIMAL: Record<string, unknown> = {
  get_site_overview: {},
  search_content: {},
  get_content: { collection: 'blog', ref: 'hello-world' },
  get_home: {},
  get_cv: {},
  list_media: {},
  get_content_health: { summary: true },
  get_authoring_guide: { topic: 'mdx' },
  list_versions: { collection: 'home' },
  get_change: { change_id: 'ch_abcdefghijklmnop' },
  list_my_changes: {},
  create_draft: { collection: 'blog', slug: 'minimal-draft', frontmatter: { title: 'Minimal', date: '2026-05-01' }, body: 'Text.' },
  edit_content: { collection: 'blog', slug: 'hello-world', body: 'Text.', base_version: '"1"' },
  set_media_text: { name: 'field.webp', alt: 'A field', expected_updated_at: 0 },
}

test('every tool refuses unknown keys, __proto__, constructor and prototype, and wrong types, naming the field: INVALID_INPUT', async () => {
  assert.deepEqual(Object.keys(MINIMAL).sort(), registry.TOOLS.map((t) => t.name).sort())
  for (const [name, args] of Object.entries(MINIMAL)) {
    for (const extra of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"x":1}}}', '{"prototype":1}', '{"unexpected":1}']) {
      const merged = JSON.parse(`{${JSON.stringify(args).slice(1, -1)}${Object.keys(args as object).length ? ',' : ''}${extra.slice(1)}`)
      const out = await tools.call(name, merged, 'draft')
      assert.deepEqual([out.ok, out.code], [false, 'INVALID_INPUT'], `${name} ${extra}`)
      assert.match(out.json.error.message, /Unrecognized key|\(arguments\)/)
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  }
  const typed = await tools.call('get_content', { collection: 'blog', ref: 7 }, 'read')
  assert.equal(typed.code, 'INVALID_INPUT')
  assert.equal(typed.json.error.field, 'ref')
  const enumBad = await tools.call('search_content', { status: 'everything' }, 'read')
  assert.equal(enumBad.json.error.field, 'status')
  assert.equal((await tools.call('search_content', { limit: 51 }, 'read')).code, 'INVALID_INPUT')
  assert.equal((await tools.call('search_content', { limit: 2.5 }, 'read')).code, 'INVALID_INPUT')
  assert.equal((await tools.call('search_content', 'not an object', 'read')).code, 'INVALID_INPUT')
})

// ── The tools ────────────────────────────────────────────────────────────

test('search_content: published only without draft access; drafts, pending, schedule and review flags with it; filters and paging', async () => {
  const read = await tools.data('search_content', { collection: 'blog' }, 'read')
  const slugs = read.items.map((r: any) => r.slug)
  assert.deepEqual(slugs.sort(), ['chinese-post', 'hello-world', 'live-pending'])
  for (const row of read.items) for (const k of ['version', 'has_unpublished_changes', 'scheduled_at', 'in_review', 'edit_url']) assert.ok(!(k in row), `${row.slug}.${k} at read`)
  const lp = read.items.find((r: any) => r.slug === 'live-pending')
  assert.equal(lp.title, 'Live pending', 'the live title, not the unpublished one')
  assert.deepEqual((await tools.data('search_content', { status: 'draft' }, 'read')).items, [])
  assert.deepEqual((await tools.data('search_content', { query: 'zebra' }, 'read')).items, [], 'unpublished text is invisible')

  const draft = await tools.data('search_content', { collection: 'blog' }, 'draft')
  const bySlug = Object.fromEntries(draft.items.map((r: any) => [r.slug, r]))
  assert.deepEqual(Object.keys(bySlug).sort(), ['chinese-post', 'draft-note', 'hello-world', 'in-review', 'live-pending', 'scheduled-draft'])
  assert.equal(bySlug['live-pending'].title, 'Live pending v2')
  assert.equal(bySlug['live-pending'].has_unpublished_changes, true)
  assert.match(bySlug['live-pending'].version, /^"\d+\.\d+"$/)
  assert.equal(bySlug['scheduled-draft'].status, 'draft')
  assert.match(String(bySlug['scheduled-draft'].scheduled_at), /^\d{4}-\d\d-\d\dT/)
  assert.equal(bySlug['in-review'].in_review, true)
  assert.equal(bySlug['hello-world'].in_review, false)
  assert.equal(bySlug['hello-world'].edit_url, '/admin/blog/edit?slug=hello-world')
  assert.deepEqual((await tools.data('search_content', { status: 'scheduled' }, 'draft')).items.map((r: any) => r.slug), ['scheduled-draft'])
  assert.deepEqual((await tools.data('search_content', { status: 'unpublished_changes' }, 'draft')).items.map((r: any) => r.slug), ['live-pending'])
  assert.deepEqual((await tools.data('search_content', { query: 'zebra' }, 'draft')).items.map((r: any) => r.slug), ['live-pending'])

  assert.deepEqual((await tools.data('search_content', { tag: 'edge-ai' }, 'read')).items.map((r: any) => r.slug), ['hello-world'])
  assert.deepEqual((await tools.data('search_content', { lang: 'zh' }, 'read')).items.map((r: any) => r.slug), ['chinese-post', 'about-zh'], 'the Chinese bio is Chinese by name')
  assert.deepEqual((await tools.data('search_content', { collection: 'work' }, 'read')).items.map((r: any) => r.slug), ['case-one'])
  const pages = (await tools.data('search_content', { collection: 'page' }, 'read')).items
  assert.deepEqual(pages.map((r: any) => [r.slug, r.empty]), [['now', false], ['uses', true], ['about', true], ['about-zh', true]])

  const first = await tools.data('search_content', { limit: 2 }, 'read')
  assert.equal(first.items.length, 2)
  assert.equal(first.next_cursor, 'o2')
  const second = await tools.data('search_content', { limit: 2, cursor: first.next_cursor }, 'read')
  assert.notDeepEqual(second.items, first.items)
  assert.equal((await tools.call('search_content', { cursor: 'garbage' }, 'read')).code, 'INVALID_INPUT')
})

test('get_content: a draft without draft access is byte for byte an unknown slug; with it, version and held flags; views; pages', async () => {
  const unknown = await tools.call('get_content', { collection: 'blog', ref: 'no-such-post' }, 'read')
  const draft = await tools.call('get_content', { collection: 'blog', ref: 'draft-note' }, 'read')
  assert.equal(draft.code, 'NOT_FOUND')
  assert.equal(draft.text, unknown.text)
  assert.equal((await tools.call('get_content', { collection: 'blog', ref: '../../etc/passwd' }, 'read')).text, unknown.text)

  const live = await tools.data('get_content', { collection: 'blog', ref: 'live-pending' }, 'read')
  assert.equal(live.body, 'Live text.')
  assert.equal(live.title, 'Live pending')
  for (const k of ['version', 'has_unpublished_changes', 'scheduled_at', 'in_review', 'edit_url']) assert.ok(!(k in live), k)
  const latest = await tools.data('get_content', { collection: 'blog', ref: 'live-pending' }, 'draft')
  assert.equal(latest.body, 'Pending zebra text.')
  assert.equal(latest.has_unpublished_changes, true)
  assert.match(latest.version, /^"\d+\.\d+"$/)
  const asPublished = await tools.data('get_content', { collection: 'blog', ref: 'live-pending', view: 'live' }, 'draft')
  assert.equal(asPublished.body, 'Live text.')
  assert.equal(asPublished.version, latest.version, 'one version covers both rows')

  const scheduled = await tools.data('get_content', { collection: 'blog', ref: 'scheduled-draft' }, 'draft')
  assert.equal(scheduled.status, 'draft')
  assert.ok(scheduled.scheduled_at)
  assert.ok(!('publishAt' in scheduled.frontmatter) && !('draft' in scheduled.frontmatter), 'server-owned keys are not shown as editable')
  assert.equal((await tools.data('get_content', { collection: 'blog', ref: 'in-review' }, 'draft')).in_review, true)
  const noBody = await tools.data('get_content', { collection: 'blog', ref: 'hello-world', include_body: false }, 'read')
  assert.ok(!('body' in noBody))
  assert.equal(noBody.body_length, 'Intro text.\n\n![A field](/uploads/field.webp)\n'.length)

  const page = await tools.data('get_content', { collection: 'page', ref: 'now' }, 'draft')
  assert.equal(page.body, 'Working on the site.')
  assert.equal(page.edit_url, '/admin/now')
  assert.match(page.version, /^"\d+"$/)
  assert.equal((await tools.call('get_content', { collection: 'page', ref: 'secrets' }, 'read')).text, unknown.text)
})

test('get_content pages a long body under the 64 KiB cap, Chinese included, never splitting a character', async () => {
  const full = '这是一个很长的中文正文。'.repeat(3000)
  let offset: number | null = 0
  let joined = ''
  let parts = 0
  while (offset !== null) {
    const out = await tools.call('get_content', { collection: 'blog', ref: 'chinese-post', offset }, 'read')
    assert.ok(out.ok)
    assert.ok(Buffer.byteLength(out.text) <= 64 * 1024, `part ${parts}: ${Buffer.byteLength(out.text)} bytes`)
    joined += out.json.body
    assert.equal(out.json.truncated, out.json.next_offset !== null)
    offset = out.json.next_offset
    parts++
  }
  assert.ok(parts >= 2)
  assert.equal(joined, full)
  const limited = await tools.data('get_content', { collection: 'blog', ref: 'chinese-post', limit: 10 }, 'read')
  assert.equal(limited.body, full.slice(0, 10))
  assert.equal(limited.next_offset, 10)
})

test('get_home: the public view without phone, e-mail or WhatsApp; hidden photos absent; positions as the view has them', async () => {
  const out = await tools.data('get_home', {}, 'read')
  assert.equal(out.home.hero.brand, 'Example Person')
  assert.ok(!('phone' in out.home.hero) && !('email' in out.home.hero))
  assert.ok(!('whatsapp' in out.home.socials))
  assert.deepEqual(out.home.photos, [{ url: '/uploads/field.webp', describe: 'A field' }])
  assert.ok(!('version' in out))
  const withVersion = await tools.data('get_home', { section: 'socials' }, 'draft')
  assert.deepEqual(withVersion.value, { github: 'https://github.com/example' })
  assert.match(withVersion.version, /^"\d+"$/)
})

test('get_cv: the website view with entry uids; hidden entries and contact fields absent; language, section and paging', async () => {
  const out = await tools.data('get_cv', { lang: 'en' }, 'read')
  const pi = out.sections.find((s: any) => s.section.sessionName === 'personalInformation').section
  for (const k of ['email', 'phoneNumber', 'address']) assert.ok(!(k in pi), k)
  assert.equal(pi.introduction, 'Hello there.')
  const work = out.sections.find((s: any) => s.section.sessionName === 'workExperience').section
  assert.deepEqual(work.experiences.map((e: any) => e.uid), ['exp-public'])
  assert.ok(!JSON.stringify(out).includes('Hidden Co'))
  assert.equal(out.next_offset, null)
  const zh = await tools.data('get_cv', { lang: 'zh', section: 'personalInformation' }, 'draft')
  assert.deepEqual(zh.sections.map((s: any) => s.lang), ['zh'])
  assert.match(zh.version, /^"\d+"$/)
  assert.equal((await tools.call('get_cv', { section: 'inbox' }, 'read')).code, 'INVALID_INPUT')
})

test('list_media: what public pages show at read; drafts too with draft access; unused needs it; texts and paging', async () => {
  const read = await tools.data('list_media', {}, 'read')
  assert.deepEqual(read.items.map((r: any) => r.name), ['avatar.webp', 'cover.webp', 'field.webp'])
  const field = read.items.find((r: any) => r.name === 'field.webp')
  assert.deepEqual([field.width, field.height, field.bytes, field.alt, field.alt_zh], [1600, 900, 2048, 'A green field', '一片绿地'])
  assert.deepEqual(field.used_by.map((u: any) => u.doc).sort(), ['blog/hello-world', 'home'])
  assert.ok(!('texts_version' in field))
  const draft = await tools.data('list_media', {}, 'draft')
  assert.deepEqual(draft.items.map((r: any) => r.name), ['avatar.webp', 'cover.webp', 'draft-only.webp', 'field.webp'])
  assert.equal(draft.items.find((r: any) => r.name === 'field.webp').texts_version, 5)
  assert.equal((await tools.call('list_media', { filter: 'unused' }, 'read')).code, 'INSUFFICIENT_SCOPE')
  assert.deepEqual((await tools.data('list_media', { filter: 'unused' }, 'draft')).items.map((r: any) => r.name), ['orphan.webp'])
  assert.deepEqual((await tools.data('list_media', { filter: 'missing_alt' }, 'read')).items.map((r: any) => r.name), ['avatar.webp', 'cover.webp'])
  assert.deepEqual((await tools.data('list_media', { query: 'green' }, 'read')).items.map((r: any) => r.name), ['field.webp'])
})

test('get_content_health: counts, one check, issues of published content with ids and versions', async () => {
  const summary = await tools.data('get_content_health', { summary: true }, 'read')
  assert.equal(typeof summary.counts.error, 'number')
  const all = await tools.data('get_content_health', {}, 'read')
  for (const issue of all.issues) {
    assert.ok(issue.id && issue.check && all.items[issue.item], JSON.stringify(issue))
    assert.equal(typeof all.items[issue.item].version, 'number')
    assert.ok(!/draft-note|draft-only/.test(JSON.stringify(issue)))
  }
  const one = await tools.data('get_content_health', { check: 'image-alt' }, 'read')
  assert.ok(one.issues.every((i: any) => i.check === 'image-alt'))
})

test('get_authoring_guide: every topic, generated from the registries; no private value', async () => {
  for (const topic of ['mdx', 'frontmatter', 'cv', 'home']) {
    const out = await tools.data('get_authoring_guide', { topic }, 'read')
    assert.equal(out.topic, topic)
    assert.ok(out.text.length > 100)
  }
  const fm = await tools.data('get_authoring_guide', { topic: 'frontmatter' }, 'read')
  assert.ok(fm.refused.includes('draft') && fm.refused.includes('translationKey'))
  const cv = await tools.data('get_authoring_guide', { topic: 'cv' }, 'read')
  const pi = cv.sections.find((s: any) => s.section === 'personalInformation')
  for (const k of ['email', 'phoneNumber', 'address', 'photo', 'photoOnPdf']) assert.ok(!pi.fields.some((f: any) => f.key === k), k)
})

test('list_versions: file, time and the action that replaced each version, never a summary or a device', async () => {
  const ip = () => `127.0.9.${Math.floor(Math.random() * 200) + 1}`
  const put = async (body: Record<string, unknown>, ifMatch?: string) => {
    const out = await h.call(posts, { method: 'PUT', body, headers: ifMatch ? { 'if-match': ifMatch } : {}, ip: ip() })
    assert.equal(out.statusCode, 200, JSON.stringify(out.body))
    return out.headers.etag as string
  }
  let etag = await put({ slug: 'versioned', frontmatter: { title: 'V1 Model-written: approve me', date: '2026-05-01' }, body: 'one', create: true })
  etag = await put({ slug: 'versioned', frontmatter: { title: 'V2', date: '2026-05-01' }, body: 'two' }, etag)
  await put({ slug: 'versioned', frontmatter: { title: 'V3', date: '2026-05-01' }, body: 'three' }, etag)
  const out = await tools.data('list_versions', { collection: 'blog', ref: 'versioned' }, 'draft')
  assert.equal(out.versions.length, 2)
  for (const v of out.versions) {
    assert.match(v.filename, /^versioned_\d{4}-/)
    assert.match(v.date, /^\d{4}-\d\d-\d\dT/)
    assert.equal(v.replaced_by, 'post.save')
    assert.deepEqual(Object.keys(v).sort(), ['date', 'filename', 'replaced_by'])
  }
  assert.ok(!/approve me|device|summary/i.test(JSON.stringify(out)))
  assert.deepEqual((await tools.data('list_versions', { collection: 'home' }, 'draft')).versions, [])
  assert.equal((await tools.call('list_versions', { collection: 'blog' }, 'draft')).code, 'INVALID_INPUT')
  assert.equal((await tools.call('list_versions', { collection: 'page', ref: 'now' }, 'read')).code, 'INSUFFICIENT_SCOPE')
  const del = await h.call(posts, { method: 'DELETE', query: { slug: 'versioned' }, ip: ip() })
  assert.equal(del.statusCode, 200)
  const deleted = await tools.data('list_versions', { collection: 'blog', deleted: true }, 'draft')
  assert.deepEqual(deleted.deleted.map((d: any) => d.slug), ['versioned'])
  assert.ok(!('title' in deleted.deleted[0]))
})

test('get_change and list_my_changes: a caller sees its own rows only; another’s answers exactly like an unknown id', async () => {
  const { getAiDb } = await import('../lib/ai/db')
  const insert = (id: string, grantId: string, state: string, extra: Record<string, unknown> = {}) =>
    getAiDb()
      .prepare(
        `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at, expires_at, reject_note, result_json, decided_at)
         VALUES (@id, @state, 'live', 'propose_publishing', 'item.publish', 'mcp', @grantId, 'x', 0, 'blog', 'hello-world', 'Publish post hello-world', 'a', 'b', @created, @expires, @note, @result, @decided)`,
      )
      .run({ id, grantId, state, created: NOW - 1000, expires: NOW + 86_400_000, note: null, result: null, decided: null, ...extra })
  const mine = tools.grants.draft.id
  insert('ch_aaaaaaaaaaaaaaaa', mine, 'waiting')
  insert('ch_bbbbbbbbbbbbbbbb', mine, 'rejected', { note: 'Not now, thanks.' })
  insert('ch_cccccccccccccccc', mine, 'waiting', { expires: NOW - 1 })
  insert('ch_dddddddddddddddd', mine, 'applied', { result: JSON.stringify({ publicUrls: ['/blog/hello-world'], version: '"1"' }) })
  insert('ch_eeeeeeeeeeeeeeee', mine, 'applying', { decided: NOW - 6 * 60_000 })
  insert('ch_ffffffffffffffff', tools.grants.propose.id, 'waiting')

  const w = await tools.data('get_change', { change_id: 'ch_aaaaaaaaaaaaaaaa' }, 'draft')
  assert.deepEqual([w.state, w.action, w.target], ['waiting', 'item.publish', { kind: 'blog', ref: 'hello-world' }])
  assert.equal((await tools.data('get_change', { change_id: 'ch_bbbbbbbbbbbbbbbb' }, 'draft')).owner_note, 'Not now, thanks.')
  assert.equal((await tools.data('get_change', { change_id: 'ch_cccccccccccccccc' }, 'draft')).state, 'expired')
  assert.deepEqual((await tools.data('get_change', { change_id: 'ch_dddddddddddddddd' }, 'draft')).public_urls, ['/blog/hello-world'])
  assert.equal((await tools.data('get_change', { change_id: 'ch_eeeeeeeeeeeeeeee' }, 'draft')).state, 'failed')
  const unknown = await tools.call('get_change', { change_id: 'ch_zzzzzzzzzzzzzzzz' }, 'draft')
  const others = await tools.call('get_change', { change_id: 'ch_ffffffffffffffff' }, 'draft')
  assert.equal(others.code, 'NOT_FOUND')
  assert.equal(others.text, unknown.text)
  assert.equal((await tools.call('get_change', { change_id: '../ch_aaaa' }, 'draft')).text, unknown.text)

  const list = await tools.data('list_my_changes', {}, 'draft')
  assert.deepEqual(list.items.map((r: any) => r.change_id).sort(), ['ch_aaaaaaaaaaaaaaaa', 'ch_bbbbbbbbbbbbbbbb', 'ch_cccccccccccccccc', 'ch_dddddddddddddddd', 'ch_eeeeeeeeeeeeeeee'])
  assert.deepEqual((await tools.data('list_my_changes', { state: 'expired' }, 'draft')).items.map((r: any) => r.change_id), ['ch_cccccccccccccccc'])
  for (const r of list.items) assert.ok(!('flags' in r) && !('args' in r) && !('preview' in r))
  assert.deepEqual((await tools.data('list_my_changes', {}, 'propose')).items.map((r: any) => r.change_id), ['ch_ffffffffffffffff'])
})

test('get_site_overview: counts for everyone, drafts and schedules by name only with draft access, published tags only at read', async () => {
  const read = await tools.data('get_site_overview', {}, 'read')
  const blog = read.collections.find((c: any) => c.collection === 'blog')
  assert.equal(blog.published, 3)
  assert.equal(blog.drafts, 3)
  assert.ok(!('draft_items' in blog))
  assert.ok(!blog.top_tags.some((t: any) => t.slug === 'secret-tag'), 'a draft-only tag can name unreleased work')
  assert.deepEqual(read.scheduled, { count: 1 })
  assert.equal(read.pages.find((p: any) => p.name === 'now').has_text, true)
  assert.ok(!JSON.stringify(read).includes('Draft note'))
  const draft = await tools.data('get_site_overview', {}, 'draft')
  const db = draft.collections.find((c: any) => c.collection === 'blog')
  assert.ok(db.draft_items.some((d: any) => d.slug === 'draft-note'))
  assert.ok(db.top_tags.some((t: any) => t.slug === 'secret-tag'))
  assert.equal(draft.scheduled[0].slug, 'scheduled-draft')
})

// ── executeTool ──────────────────────────────────────────────────────────

test('executeTool: off refuses everything; the scope is checked again; unknown tools are not run', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_settings SET enabled = 0 WHERE id = 1').run()
  assert.equal((await tools.call('get_authoring_guide', { topic: 'mdx' }, 'read')).code, 'ACCESS_OFF')
  process.env.AI_DISABLED = '1'
  getAuthDb().prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
  assert.equal((await tools.call('get_authoring_guide', { topic: 'mdx' }, 'read')).code, 'ACCESS_OFF')
  delete process.env.AI_DISABLED
  const scoped = await tools.call('list_my_changes', {}, 'read')
  assert.deepEqual([scoped.ok, scoped.code], [false, 'INSUFFICIENT_SCOPE'])
  const unknown = await tools.call('drop_tables', {}, 'propose')
  assert.equal(unknown.code, 'NOT_FOUND')
})

test('executeTool: results lose TAG characters and bidi controls; arguments never reach the call log', async () => {
  const out = await tools.call('get_content', { collection: 'work', ref: 'case-one' }, 'read')
  assert.ok(out.ok)
  assert.ok(!/[‪-‮⁦-⁩]|\udb40[\udc00-\udc7f]/.test(out.text))
  assert.match(out.json.body, /invisible flip and a tag char/)
  const { getAiDb } = await import('../lib/ai/db')
  const row = getAiDb().prepare("SELECT * FROM ai_tool_calls WHERE tool = 'get_content' AND target = 'case-one' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>
  assert.equal(row.actor_kind, 'mcp')
  assert.equal(row.outcome, 'ok')
  assert.equal(row.risk, 'read')
  assert.equal(row.country, 'HK')
  assert.equal(row.era, 'modern')
  assert.match(String(row.args_sha256), /^[0-9a-f]{64}$/)
  assert.ok(Number(row.bytes_out) > 0)
  const daily = getAiDb().prepare('SELECT * FROM ai_grant_daily WHERE grant_id = ?').get(tools.grants.read.id) as Record<string, number>
  assert.ok(daily.calls > 0 && daily.bytes_in > 0)
  const dump = JSON.stringify(getAiDb().prepare('SELECT * FROM ai_tool_calls').all())
  assert.ok(!dump.includes('case-one"') || !dump.includes('"collection"'), 'no arguments, only the target slug')
  assert.ok(!dump.includes('Case study text'))
})

test('executeTool: 60 calls a minute per grant, then BUDGET; expensive reads cached 60 s and capped site-wide', async () => {
  const { clearReadCache } = await import('../lib/ai/execute')
  const g = tools.grantAt('read')
  for (let i = 0; i < 60; i++) assert.equal((await tools.call('get_authoring_guide', { topic: 'home' }, 'read', { grant: g })).ok, true, `call ${i + 1}`)
  const over = await tools.call('get_authoring_guide', { topic: 'home' }, 'read', { grant: g })
  assert.equal(over.code, 'BUDGET')
  assert.ok(over.json.error.retry_after_s >= 1)

  clearReadCache()
  tools.nextMinute()
  const g2 = tools.grantAt('read')
  const first = await tools.call('get_site_overview', {}, 'read', { grant: g2 })
  assert.ok(first.ok)
  for (let i = 0; i < 10; i++) assert.equal((await tools.call('get_site_overview', {}, 'read', { grant: g2 })).text, first.text, 'served from the cache, no site budget spent')
  const distinct = [{}, { filter: 'missing_alt' }, { query: 'a' }, { query: 'b' }, { query: 'c' }, { query: 'd' }, { query: 'e' }]
  const codes: Array<string | null> = []
  for (const args of distinct) codes.push((await tools.call('list_media', args, 'read', { grant: g2 })).code)
  assert.ok(codes.includes('BUDGET'), `the site-wide budget of 6 expensive reads a minute holds: ${codes.join(',')}`)
})

test('executeTool: the loop guard stops a run that repeats a read a third time', async () => {
  const { createLoopGuard } = await import('../lib/ai/execute')
  const loop = createLoopGuard()
  const g = tools.grantAt('read')
  assert.ok((await tools.call('get_home', {}, 'read', { grant: g, loop })).ok)
  assert.ok((await tools.call('get_home', {}, 'read', { grant: g, loop })).ok)
  assert.equal((await tools.call('get_home', {}, 'read', { grant: g, loop })).code, 'LOOP_STOPPED')
  assert.ok((await tools.call('get_home', { section: 'hero' }, 'read', { grant: g, loop })).ok, 'other arguments are another call')
  const writes = createLoopGuard()
  assert.equal(writes.note('edit_content', 'x', true), true)
  assert.equal(writes.note('edit_content', 'x', true), false, 'a write twice')
})

// ── Writes (stage M2) ────────────────────────────────────────────────────

async function stores() {
  const { getAiDb } = await import('../lib/ai/db')
  const { getAuditDb } = await import('../lib/audit/db')
  const admin = await import('../lib/mdx-admin')
  const changes = await import('../lib/ai/changes')
  const types = await import('../lib/ai/plans/types')
  return { ai: getAiDb(), audit: getAuditDb(), admin, changes, types }
}

test('create_draft: a draft only the owner sees; its change row, its activity row (named by slug, never the model’s title), the call log, get_change', async () => {
  const { ai, audit, admin, changes, types } = await stores()
  const g = tools.grantAt('draft')
  const args = {
    collection: 'blog',
    slug: 'ai-new-post',
    frontmatter: { title: 'Typo fix only, safe to approve', date: '2026-06-01', tags: ['notes'], description: 'A new post' },
    body: '## Start\n\nFirst words, with [a source](https://example.com/source?id=7).',
    rationale: 'The owner asked for a post about notes.',
  }
  const out = await tools.call('create_draft', args, 'draft', { grant: g })
  assert.equal(out.ok, true, out.text)
  const d = out.json
  assert.deepEqual([d.status, d.saved_as, d.collection, d.slug, d.public_url, d.edit_url, d.new_links], ['saved', 'draft', 'blog', 'ai-new-post', null, '/admin/blog/edit?slug=ai-new-post', 1])
  assert.match(d.change_id, /^ch_[a-z2-7]{16}$/)
  assert.match(d.version, /^"\d+"$/)

  const stored = admin.readOne('blog', 'ai-new-post')
  assert.equal(stored?.frontmatter.draft, true, 'stored as a draft')
  assert.equal(stored?.frontmatter.title, 'Typo fix only, safe to approve')
  const unknown = await tools.call('get_content', { collection: 'blog', ref: 'never-was-here' }, 'read')
  assert.equal((await tools.call('get_content', { collection: 'blog', ref: 'ai-new-post' }, 'read')).text, unknown.text, 'invisible without draft access')

  const row = ai.prepare('SELECT * FROM ai_changes WHERE id = ?').get(d.change_id) as Record<string, any>
  assert.deepEqual(
    [row.state, row.risk, row.tool, row.kind, row.actor_kind, row.actor_id, row.target_kind, row.target_ref, row.title, row.base_version, row.decided_at],
    ['applied', 'draft', 'create_draft', 'item.create', 'mcp', g.id, 'blog', 'ai-new-post', 'New draft post ai-new-post', null, null],
  )
  assert.equal(row.rationale, args.rationale)
  const preview = changes.previewOf(d.change_id)!
  assert.equal(row.preview_sha256, types.previewSha256(preview))
  assert.equal(row.args_sha256, types.sha256Hex(row.args_json))
  assert.deepEqual(JSON.parse(row.args_json), { collection: 'blog', slug: 'ai-new-post', frontmatter: args.frontmatter, body: args.body })
  assert.deepEqual(changes.beforeStateOf(d.change_id), { kind: 'item', collection: 'blog', slug: 'ai-new-post', live: null, pending: null })
  assert.equal(preview.documents[0].before, '')
  assert.match(preview.documents[0].after, /^title: Typo fix only, safe to approve$/m)
  assert.match(preview.documents[0].after, /First words/)
  assert.deepEqual(preview.newLinks, [{ url: 'https://example.com/source?id=7', flags: ['query'] }])
  assert.deepEqual(preview.effects, { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null })
  assert.deepEqual(JSON.parse(row.result_json), { editUrl: '/admin/blog/edit?slug=ai-new-post', publicUrls: [], savedAs: 'draft', version: d.version })

  const log = audit.prepare('SELECT * FROM audit_log WHERE change_id = ?').get(d.change_id) as Record<string, any>
  assert.deepEqual([log.action, log.status, log.route, log.device, log.actor_kind, log.ai_grant_id, log.tool], ['post.create', 200, 'mcp', 'AI · extra draft', 'mcp', g.id, 'create_draft'])
  assert.match(log.summary, /ai-new-post/)
  assert.doesNotMatch(log.summary, /Typo fix|safe to approve/, 'a model-written title never becomes a headline')
  assert.equal(log.tool_list_hash, registry.TOOL_LIST_HASH)

  const call = ai.prepare("SELECT * FROM ai_tool_calls WHERE tool = 'create_draft' AND actor_id = ? ORDER BY id DESC LIMIT 1").get(g.id) as Record<string, any>
  assert.deepEqual([call.outcome, call.risk, call.target], ['ok', 'draft', 'ai-new-post'])
  const daily = ai.prepare('SELECT sum(writes) AS w FROM ai_grant_daily WHERE grant_id = ?').get(g.id) as { w: number }
  assert.equal(daily.w, 1)

  const change = await tools.call('get_change', { change_id: d.change_id }, 'draft', { grant: g })
  assert.deepEqual([change.json.state, change.json.action, change.json.version, change.json.edit_url, change.json.public_urls], ['applied', 'item.create', d.version, '/admin/blog/edit?slug=ai-new-post', []])
  assert.deepEqual((await tools.call('list_my_changes', {}, 'draft', { grant: g })).json.items.map((r: any) => r.change_id), [d.change_id])
  assert.equal((await tools.call('get_change', { change_id: d.change_id }, 'draft')).code, 'NOT_FOUND', 'another grant cannot see it')
})

test('create_draft: the published state, the schedule and translation links are the server’s; other fields are refused by name; nothing is written', async () => {
  const { admin } = await stores()
  const base = { collection: 'blog', slug: 'refused-draft', body: 'Text.' }
  const fm = { title: 'Refused', date: '2026-06-01' }
  for (const [extra, field] of [
    [{ draft: false }, 'frontmatter.draft'],
    [{ publishAt: '2026-12-01T00:00:00Z' }, 'frontmatter.publishAt'],
    [{ unpublishAt: '2026-12-01T00:00:00Z' }, 'frontmatter.unpublishAt'],
    [{ translationKey: 'stolen' }, 'frontmatter.translationKey'],
    [{ canonical: 'https://example.com/' }, 'frontmatter.canonical'],
  ] as const) {
    const out = await tools.call('create_draft', { ...base, frontmatter: { ...fm, ...extra } }, 'draft')
    assert.deepEqual([out.code, out.json.error.field], ['FIELD_NOT_EDITABLE', field], JSON.stringify(extra))
  }
  const otherCollection = await tools.call('create_draft', { ...base, frontmatter: { ...fm, tech: ['TypeScript'] } }, 'draft')
  assert.deepEqual([otherCollection.code, otherCollection.json.error.field], ['FIELD_NOT_EDITABLE', 'tech'], 'a case-study field on a post')
  const proto = await tools.call('create_draft', JSON.parse(`{"collection":"blog","slug":"refused-draft","body":"x","frontmatter":{"title":"x","date":"2026-06-01","__proto__":{"polluted":true}}}`), 'draft')
  assert.equal(proto.code, 'INVALID_INPUT')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal((await tools.call('create_draft', { ...base, frontmatter: { date: '2026-06-01' } }, 'draft')).code, 'INVALID_INPUT', 'a title is required')
  assert.equal((await tools.call('create_draft', { ...base, frontmatter: { title: 'No date' } }, 'draft')).code, 'INVALID_INPUT', 'a post needs a date')
  const date = await tools.call('create_draft', { ...base, frontmatter: { title: 'x', date: 'June 1st' } }, 'draft')
  assert.deepEqual([date.code, date.json.error.field], ['INVALID_INPUT', 'frontmatter.date'])
  tools.nextMinute()
  assert.equal((await tools.call('create_draft', { ...base, slug: 'Bad Slug', frontmatter: fm }, 'draft')).code, 'INVALID_INPUT')
  assert.equal((await tools.call('create_draft', { ...base, slug: 'hello-world', frontmatter: fm }, 'draft')).code, 'SLUG_EXISTS')
  assert.equal((await tools.call('create_draft', { ...base, slug: 'draft-note', frontmatter: fm }, 'draft')).code, 'SLUG_EXISTS')
  assert.equal((await tools.call('create_draft', { ...base, frontmatter: fm }, 'read')).code, 'INSUFFICIENT_SCOPE')
  assert.equal(admin.readOne('blog', 'refused-draft'), null)
  assert.equal(admin.readOne('blog', 'Bad Slug'), null)
  const ok = await tools.call('create_draft', { collection: 'work', slug: 'ai-case', frontmatter: { title: 'A case', tech: ['TypeScript'], status: 'case-study', featured: false, outcomes: [{ value: '93', unit: '%', label: 'Accuracy' }] }, body: 'Text.' }, 'draft')
  assert.equal(ok.ok, true, ok.text)
  assert.deepEqual(admin.readOne('work', 'ai-case')?.frontmatter, { title: 'A case', tech: ['TypeScript'], status: 'case-study', featured: false, outcomes: [{ value: '93', unit: '%', label: 'Accuracy' }], draft: true })
})

test('create_draft: translation_of copies the partner’s translation key, and refuses with the reason when it cannot', async () => {
  const w = await storeWriters()
  const { admin } = await stores()
  await w.item('blog', 'tr-en', { title: 'Piece', date: '2026-05-01', lang: 'en', translationKey: 'tr-piece' }, 'English text.')
  await w.item('blog', 'tr-nokey', { title: 'Lonely', date: '2026-05-01', lang: 'en' }, 'English text.')
  const draft = (slug: string, partner: string, lang = 'zh-Hans') => ({ collection: 'blog', slug, frontmatter: { title: '译文', date: '2026-05-02', lang }, body: '中文正文。', translation_of: partner })
  const noKey = await tools.call('create_draft', draft('tr-x1', 'tr-nokey'), 'draft')
  assert.deepEqual([noKey.code, noKey.json.error.field], ['INVALID_INPUT', 'translation_of'])
  assert.match(noKey.json.error.message, /no translation key/)
  assert.equal((await tools.call('create_draft', draft('tr-x2', 'tr-en', 'en'), 'draft')).code, 'INVALID_INPUT', 'same language')
  assert.equal((await tools.call('create_draft', draft('tr-x3', 'no-such-post'), 'draft')).code, 'NOT_FOUND')
  const zh = await tools.call('create_draft', draft('tr-zh', 'tr-en'), 'draft')
  assert.equal(zh.ok, true, zh.text)
  assert.equal(admin.readOne('blog', 'tr-zh')?.frontmatter.translationKey, 'tr-piece')
  tools.nextMinute()
  const second = await tools.call('create_draft', draft('tr-zh-2', 'tr-en'), 'draft')
  assert.deepEqual([second.code, second.json.error.existing], ['INVALID_INPUT', 'tr-zh'], 'a group gets one version per language')
  for (const s of ['tr-x1', 'tr-x2', 'tr-x3', 'tr-zh-2']) assert.equal(admin.readOne('blog', s), null)
})

test('edit_content: a draft stays a draft; a published item’s change is its unpublished changes, and its public row is byte for byte the same', async () => {
  const { ai, audit, admin, changes } = await stores()
  const store = await import('../lib/contentStore')
  const g = tools.grantAt('draft')
  const v = async (slug: string) => (await tools.data('get_content', { collection: 'blog', ref: slug }, 'draft')).version as string

  const draftEdit = await tools.call('edit_content', { collection: 'blog', slug: 'draft-note', edits: [{ find: 'Not yet.', replace: 'Soon, with more words.' }], base_version: await v('draft-note') }, 'draft', { grant: g })
  assert.equal(draftEdit.ok, true, draftEdit.text)
  assert.deepEqual([draftEdit.json.saved_as, draftEdit.json.public_url], ['draft', null])
  const nowDraft = admin.readOne('blog', 'draft-note')!
  assert.equal(nowDraft.frontmatter.draft, true)
  assert.match(nowDraft.body, /^Soon, with more words\./)

  const livePublic = JSON.stringify(store.getItem('blog', 'hello-world'))
  const liveBefore = admin.readOne('blog', 'hello-world')!
  const liveEdit = await tools.call(
    'edit_content',
    { collection: 'blog', slug: 'hello-world', edits: [{ find: 'Intro text.', replace: 'A better intro.' }], frontmatter_patch: { description: 'A sharper first post' }, base_version: await v('hello-world') },
    'draft',
    { grant: g },
  )
  assert.equal(liveEdit.ok, true, liveEdit.text)
  assert.deepEqual([liveEdit.json.saved_as, liveEdit.json.public_url], ['unpublished_changes', '/blog/hello-world'])
  assert.equal(JSON.stringify(store.getItem('blog', 'hello-world')), livePublic, 'the published row is untouched')
  const asPublished = await tools.data('get_content', { collection: 'blog', ref: 'hello-world', view: 'live' }, 'read')
  assert.match(asPublished.body, /^Intro text\./)
  const latest = await tools.data('get_content', { collection: 'blog', ref: 'hello-world' }, 'draft')
  assert.match(latest.body, /^A better intro\./)
  assert.equal(latest.frontmatter.description, 'A sharper first post')
  assert.equal(latest.frontmatter.cover, '/uploads/cover.webp', 'fields left out stay as stored')
  assert.equal(latest.version, liveEdit.json.version)
  assert.deepEqual(changes.beforeStateOf(liveEdit.json.change_id), {
    kind: 'item',
    collection: 'blog',
    slug: 'hello-world',
    live: { frontmatter: liveBefore.frontmatter, body: liveBefore.body, updatedAt: liveBefore.updatedAt },
    pending: null,
  })

  // An item with unpublished changes: the edit applies to them (what the editor shows).
  const pendingEdit = await tools.call('edit_content', { collection: 'blog', slug: 'live-pending', edits: [{ find: 'zebra', replace: 'giraffe' }], base_version: await v('live-pending') }, 'draft', { grant: g })
  assert.equal(pendingEdit.ok, true, pendingEdit.text)
  assert.equal((await tools.data('get_content', { collection: 'blog', ref: 'live-pending' }, 'draft')).body, 'Pending giraffe text.')
  assert.equal((changes.beforeStateOf(pendingEdit.json.change_id) as any).pending.body, 'Pending zebra text.', 'the replaced unpublished changes are kept for undo')

  const actions = (audit.prepare('SELECT action, summary FROM audit_log WHERE ai_grant_id = ? ORDER BY id').all(g.id) as Array<{ action: string; summary: string }>).map((r) => r.action)
  assert.deepEqual(actions, ['post.save', 'post.save-pending', 'post.save-pending'])
  const kinds = (ai.prepare('SELECT kind FROM ai_changes WHERE actor_id = ? ORDER BY created_at, rowid').all(g.id) as Array<{ kind: string }>).map((r) => r.kind)
  assert.deepEqual(kinds, ['item.edit-draft', 'item.edit-pending', 'item.edit-pending'])
})

test('edit_content: VERSION_CONFLICT, EDIT_NOT_FOUND, EDIT_AMBIGUOUS, NO_VISIBLE_CHANGE and the frontmatter refusals; nothing written', async () => {
  const { admin, ai } = await stores()
  const g = tools.grantAt('draft')
  const before = JSON.stringify([admin.readOne('blog', 'chinese-post'), admin.readOne('work', 'case-one')])
  const rowsBefore = (ai.prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n
  const current = (await tools.data('get_content', { collection: 'work', ref: 'case-one' }, 'draft')).version as string
  const call = (args: Record<string, unknown>) => tools.call('edit_content', { collection: 'work', slug: 'case-one', base_version: current, ...args }, 'draft', { grant: g })
  const stale = await call({ base_version: '"1"', body: 'x' })
  assert.deepEqual([stale.code, stale.json.error.current_version], ['VERSION_CONFLICT', current])
  const miss = await call({ edits: [{ find: 'not in the text', replace: 'x' }] })
  assert.deepEqual([miss.code, miss.json.error.field, miss.json.error.find], ['EDIT_NOT_FOUND', 'edits[0]', 'not in the text'])
  tools.nextMinute()
  const twice = await tools.call('edit_content', { collection: 'blog', slug: 'chinese-post', edits: [{ find: '中文', replace: '汉语' }], base_version: (await tools.data('get_content', { collection: 'blog', ref: 'chinese-post', include_body: false }, 'draft')).version }, 'draft', { grant: g })
  assert.deepEqual([twice.code, twice.json.error.field], ['EDIT_AMBIGUOUS', 'edits[0]'])
  assert.equal((await call({ edits: [{ find: 'Case study', replace: 'Case study' }] })).code, 'NO_VISIBLE_CHANGE')
  assert.deepEqual([(await call({ frontmatter_patch: { draft: false } })).code, (await call({ frontmatter_patch: { draft: false } })).json.error.field], ['FIELD_NOT_EDITABLE', 'frontmatter_patch.draft'])
  const remove = await call({ remove_frontmatter: ['draft'] })
  assert.deepEqual([remove.code, remove.json.error.field], ['FIELD_NOT_EDITABLE', 'remove_frontmatter: draft'])
  tools.nextMinute()
  const postField = await call({ frontmatter_patch: { tags: ['x'] } })
  assert.deepEqual([postField.code, postField.json.error.field], ['FIELD_NOT_EDITABLE', 'tags'], 'a post field on a case study')
  assert.equal((await call({ remove_frontmatter: ['title'] })).code, 'INVALID_INPUT', 'the title is required')
  assert.equal((await tools.call('edit_content', { collection: 'blog', slug: 'no-such-post', body: 'x', base_version: '"1"' }, 'draft', { grant: g })).code, 'NOT_FOUND')
  assert.equal((await call({ body: 'x' })).ok, true, 'sanity: the same call with a real change goes through')
  const after = JSON.parse(JSON.stringify([admin.readOne('blog', 'chinese-post'), null]))
  assert.deepEqual(after[0], JSON.parse(before)[0], 'the refused Chinese post is unchanged')
  assert.equal((ai.prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n, rowsBefore + 1, 'only the real change left a row')
})

test('set_media_text: texts with a version check; hidden and unknown uploads answer alike; the route’s checks travelled (constructor, variants)', async () => {
  const g = tools.grantAt('draft')
  const ok = await tools.call('set_media_text', { name: 'field.webp', alt: 'A wide green field at dawn', caption_zh: '清晨的田野', expected_updated_at: 5 }, 'draft', { grant: g })
  assert.equal(ok.ok, true, ok.text)
  assert.equal(ok.json.saved_as, 'texts')
  assert.ok(ok.json.texts_version > 5)
  const listed = (await tools.data('list_media', { query: 'dawn' }, 'draft')).items[0]
  assert.deepEqual([listed.name, listed.alt, listed.alt_zh, listed.caption_zh, listed.texts_version], ['field.webp', 'A wide green field at dawn', '一片绿地', '清晨的田野', ok.json.texts_version])
  const stale = await tools.call('set_media_text', { name: 'field.webp', alt: 'Again', expected_updated_at: 5 }, 'draft', { grant: g })
  assert.deepEqual([stale.code, stale.json.error.current_version], ['VERSION_CONFLICT', ok.json.texts_version])
  assert.equal((await tools.call('set_media_text', { name: 'field.webp', alt: 'A wide green field at dawn', expected_updated_at: ok.json.texts_version }, 'draft', { grant: g })).code, 'NO_VISIBLE_CHANGE')
  const unknown = await tools.call('set_media_text', { name: 'no-such.webp', alt: 'x', expected_updated_at: 0 }, 'draft', { grant: g })
  assert.equal(unknown.code, 'NOT_FOUND')
  for (const name of ['hidden-photo.webp', 'constructor', '__proto__', '../etc/passwd', 'field-640w.webp']) {
    tools.nextMinute()
    assert.equal((await tools.call('set_media_text', { name, alt: 'x', expected_updated_at: 0 }, 'draft', { grant: g })).text, unknown.text, name)
  }
  assert.equal((await tools.call('set_media_text', { name: 'orphan.webp', alt: 'Nothing uses this yet', expected_updated_at: 0 }, 'draft', { grant: g })).ok, true, 'an unused upload is visible at draft level')
  assert.equal((await tools.call('set_media_text', { name: 'field.webp', alt: 'x', expected_updated_at: 0 }, 'read')).code, 'INSUFFICIENT_SCOPE')
  assert.equal((await tools.call('set_media_text', { name: 'field.webp', expected_updated_at: 0 }, 'draft', { grant: g })).code, 'INVALID_INPUT', 'one text at least')
})

test('writes: a remote image, an invisible control character and invalid MDX are refused with their codes; nothing written', async () => {
  const { admin } = await stores()
  const g = tools.grantAt('draft')
  const make = (slug: string, body: string, fm: Record<string, unknown> = {}) => tools.call('create_draft', { collection: 'blog', slug, frontmatter: { title: 'x', date: '2026-06-01', ...fm }, body }, 'draft', { grant: g })
  assert.equal((await make('bad-1', '![x](https://img.example/x.png)')).code, 'REMOTE_IMAGE')
  assert.equal((await make('bad-2', 'Text.', { cover: 'https://img.example/c.png' })).code, 'REMOTE_IMAGE')
  assert.equal((await make('bad-3', 'Hidden ‮flip')).code, 'INVISIBLE_CHARS')
  const mdx = await make('bad-4', 'Fine.\n\n<Callout>\nnever closed')
  assert.equal(mdx.code, 'MDX_INVALID')
  assert.ok(Number.isInteger(mdx.json.error.line), mdx.text)
  for (const s of ['bad-1', 'bad-2', 'bad-3', 'bad-4']) assert.equal(admin.readOne('blog', s), null)
})

test('writes: the loop guard stops the same write the second time in a run; the read cache is cleared by a write', async () => {
  const { createLoopGuard, clearReadCache } = await import('../lib/ai/execute')
  const g = tools.grantAt('draft')
  const loop = createLoopGuard()
  const args = { collection: 'blog', slug: 'looped', frontmatter: { title: 'Looped', date: '2026-06-01' }, body: 'Once.' }
  assert.equal((await tools.call('create_draft', args, 'draft', { grant: g, loop })).ok, true)
  assert.equal((await tools.call('create_draft', args, 'draft', { grant: g, loop })).code, 'LOOP_STOPPED')

  clearReadCache()
  const before = (await tools.data('get_site_overview', {}, 'draft')).collections.find((c: any) => c.collection === 'blog').drafts
  assert.equal((await tools.call('create_draft', { ...args, slug: 'looped-2' }, 'draft', { grant: g })).ok, true)
  const after = (await tools.data('get_site_overview', {}, 'draft')).collections.find((c: any) => c.collection === 'blog').drafts
  assert.equal(after, before + 1, 'the overview is read again after a write, not served from the cache')
})

test('writes: per-grant and per-item budgets refuse past their limit with BUDGET; past 80 % of a daily budget the owner hears once', async () => {
  const { ai } = await stores()
  const { executeTool } = await import('../lib/ai/execute')
  const { PERSISTED_BUDGETS } = await import('../lib/ai/budgets')
  const g = tools.grantAt('draft')
  const hour = (now: number) => Math.floor(now / 3_600_000) * 3_600_000
  const day = (now: number) => Math.floor(now / 86_400_000) * 86_400_000
  const now = Date.now()
  const fill = (key: string, start: number, n: number) => ai.prepare('INSERT OR REPLACE INTO ai_counters (key, window_start, n) VALUES (?, ?, ?)').run(key, start, n)
  const events: unknown[] = []
  const write = (slug: string) =>
    executeTool('create_draft', { collection: 'blog', slug, frontmatter: { title: 'Budget', date: '2026-06-01' }, body: 'x' }, {
      actor: { kind: 'mcp', grantId: g.id, label: g.name },
      scopes: new Set(g.scopes as never[]),
      origin: { ipPrefix: null, country: null },
      era: 'modern',
      requestId: null,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    })
  fill(`grantWritesDay|${g.id}`, day(now), PERSISTED_BUDGETS.grantWritesDay.limit * 0.8 - 1)
  assert.equal((await write('budget-1')).ok, true)
  assert.deepEqual(events, [{ type: 'write-budget', grantId: g.id, label: g.name, budget: 'writes' }])
  fill(`grantWritesHour|${g.id}`, hour(now), PERSISTED_BUDGETS.grantWritesHour.limit)
  const over = await write('budget-2')
  assert.equal(over.code, 'BUDGET')
  assert.equal(JSON.parse(over.text).error.budget, 'grantWritesHour')
  fill(`grantWritesHour|${g.id}`, hour(now), 0)
  fill('itemWritesHour|blog/budget-3', hour(now), PERSISTED_BUDGETS.itemWritesHour.limit)
  const item = await write('budget-3')
  assert.deepEqual([item.code, JSON.parse(item.text).error.budget], ['BUDGET', 'itemWritesHour'])
})

test('writes: with drafts set to need approval, AI writes are refused (there is no queue yet); nothing written', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { admin } = await stores()
  getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 0 WHERE id = 1').run()
  try {
    const out = await tools.call('create_draft', { collection: 'blog', slug: 'needs-approval', frontmatter: { title: 'x', date: '2026-06-01' }, body: 'x' }, 'draft', { grant: tools.grantAt('draft') })
    assert.equal(out.code, 'APPROVAL_REQUIRED', out.text)
    assert.equal(admin.readOne('blog', 'needs-approval'), null)
  } finally {
    getAuthDb().prepare('UPDATE ai_settings SET auto_apply_drafts = 1 WHERE id = 1').run()
  }
})

test('writes: an activity log that cannot be written refuses the write (fail closed), and no change row is left', async () => {
  const { ai, audit, admin } = await stores()
  const rows = (ai.prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n
  audit.exec("CREATE TRIGGER test_refuse_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit refused by the test'); END")
  try {
    const out = await tools.call('create_draft', { collection: 'blog', slug: 'unaudited', frontmatter: { title: 'x', date: '2026-06-01' }, body: 'x' }, 'draft', { grant: tools.grantAt('draft') })
    assert.equal(out.code, 'AUDIT_UNAVAILABLE', out.text)
  } finally {
    audit.exec('DROP TRIGGER test_refuse_audit')
  }
  assert.equal(admin.readOne('blog', 'unaudited'), null)
  assert.equal((ai.prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n, rows)
})

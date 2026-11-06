/**
 * M1 — no tool leaks what the site hides (design §5.7, §12.1; THREATS H4,
 * S7). A store filled with sentinels: hidden CV fields, entries, list items
 * and sections, values limited to the downloads, a recommendation without
 * consent, the CV's contact fields and its PDF-only photo; the home page's
 * phone, e-mail, WhatsApp, a hidden photo and a switched-off logo strip;
 * drafts, unpublished changes, a draft-only image and tag, a review link;
 * broken-link results for hidden addresses. Every tool, with every argument
 * shape that reaches a different code path, at every access level:
 *
 *   - hidden and private values appear at no level;
 *   - drafts and unpublished changes appear only with content:draft;
 *   - a draft read without it is byte for byte an unknown slug;
 *   - no result carries a `path`, `note` or `token` field (review-link
 *     addresses, version notes, secrets).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters, type Level } from './helpers/aiTools'

const h = editorialHarness('ai-tools-leak', 'ai-tools-leak-secret-0123456789abcdef0123')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let reviewToken = ''

/** Must never appear, at any access level. */
const HIDDEN = [
  'SENTINEL-CV-EMAIL',
  'SENTINEL-CV-PHONE',
  'SENTINEL-CV-ADDRESS',
  'sentinel-pdf-photo',
  'SENTINEL-HIDDEN-FIELD',
  'sentinel-download-only',
  'SENTINEL-HIDDEN-ITEM',
  'SENTINEL-HIDDEN-ENTRY',
  'sentinel-hidden-entry-url',
  'SENTINEL-ONLYIN-ENTRY',
  'SENTINEL-NO-CONSENT',
  'SENTINEL-HIDDEN-SECTION',
  'SENTINEL-HOME-PHONE',
  'SENTINEL-HOME-EMAIL',
  'SENTINEL-WA',
  'sentinel-hidden-photo',
  'SENTINEL-HIDDEN-PHOTO-DESC',
  'SENTINEL-OFF-BRAND',
  'sentinel-brand-logo',
  'SENTINEL-PDF-ALT',
]
/** Owner-only: may appear with content:draft, never at content:read. */
const DRAFT_ONLY = ['SENTINEL-DRAFT-TITLE', 'SENTINEL-DRAFT-BODY', 'sentinel-draft-image', 'sentineldrafttag', 'SENTINEL-PENDING-TITLE', 'SENTINEL-PENDING-BODY', 'sentinel-draft-post']

before(async () => {
  await h.setup()
  const w = await storeWriters()
  await w.kv('cvdata', {
    en: [
      {
        sessionName: 'personalInformation',
        firstName: 'Example',
        lastName: 'Person',
        nickName: 'SENTINEL-HIDDEN-FIELD',
        hiddenFields: ['nickName'],
        email: 'SENTINEL-CV-EMAIL@example.test',
        phoneNumber: 'SENTINEL-CV-PHONE',
        address: 'SENTINEL-CV-ADDRESS',
        personalWebsite: 'https://sentinel-download-only.example.com',
        fieldsOnlyIn: { personalWebsite: ['download'] },
        photo: '/uploads/sentinel-pdf-photo.jpg',
        photoOnPdf: true,
        introduction: 'A public summary.',
      },
      {
        sessionName: 'workExperience',
        experiences: [
          { uid: 'exp-1', jobTitle: 'Engineer', companyName: 'Example Co', relatedSkills: ['TypeScript', 'SENTINEL-HIDDEN-ITEM'], hiddenItems: { relatedSkills: [1] }, features: [] },
          { uid: 'exp-hidden', jobTitle: 'SENTINEL-HIDDEN-ENTRY', companyName: 'Elsewhere', companyURL: 'https://sentinel-hidden-entry-url.example.com', isVisible: false, features: [] },
          { uid: 'exp-dl', jobTitle: 'SENTINEL-ONLYIN-ENTRY', companyName: 'Download Co', onlyIn: ['download'], features: [] },
        ],
      },
      { sessionName: 'recommendations', items: [{ quote: 'SENTINEL-NO-CONSENT', name: 'A Referee', permission: false }, { quote: 'Great to work with.', name: 'Example Referee', permission: true }] },
      { sessionName: 'certification', isVisible: false, showOnWebsite: false, certificates: [{ name: 'SENTINEL-HIDDEN-SECTION' }] },
    ],
    zh: [{ sessionName: 'personalInformation', firstName: '例', lastName: '人', email: 'SENTINEL-CV-EMAIL@example.test', photo: '/uploads/sentinel-pdf-photo.jpg', photoOnPdf: true }],
  })
  await w.kv('home', {
    hero: { welcome: 'Hi', brand: 'Example Person', tagline: 'Engineer', avatarUrl: '/uploads/public-avatar.webp', phone: 'SENTINEL-HOME-PHONE', email: 'SENTINEL-HOME-EMAIL@example.test' },
    socials: { github: 'https://github.com/example', whatsapp: 'https://wa.me/SENTINEL-WA' },
    brands: [{ name: 'SENTINEL-OFF-BRAND', href: 'https://brand.example.com', image: '/uploads/sentinel-brand-logo.png' }],
    sections: { brands: false },
    quickAccess: [{ label: 'Blog', url: '/blog' }],
    photos: [{ url: '/uploads/public-field.webp', describe: 'A field' }, { url: '/uploads/sentinel-hidden-photo.jpg', describe: 'SENTINEL-HIDDEN-PHOTO-DESC', visible: false }],
  })
  await w.item('blog', 'public-post', { title: 'Public post', date: '2026-05-01', tags: ['notes'] }, 'Public text with [a broken link](https://broken.example.com/page).\n\n![A field](/uploads/public-field.webp)\n')
  w.pending('blog', 'public-post', { title: 'SENTINEL-PENDING-TITLE', date: '2026-05-01', tags: ['notes'] }, 'SENTINEL-PENDING-BODY')
  await w.item('blog', 'sentinel-draft-post', { title: 'SENTINEL-DRAFT-TITLE', date: '2026-05-02', draft: true, tags: ['SENTINELDRAFTTAG'] }, 'SENTINEL-DRAFT-BODY\n\n![x](/uploads/sentinel-draft-image.png)')
  await w.item('work', 'public-case', { title: 'Public case', tech: ['TypeScript'] }, 'Case text.')
  await w.page('now', { title: 'Now' }, 'Now text.')
  for (const name of ['public-field.webp', 'public-avatar.webp', 'sentinel-pdf-photo.jpg', 'sentinel-hidden-photo.jpg', 'sentinel-draft-image.png', 'sentinel-brand-logo.png']) w.asset(name)
  await w.kv('media-library', { v: 1, items: { 'sentinel-pdf-photo.jpg': { alt: 'SENTINEL-PDF-ALT', altZh: '', caption: '', captionZh: '', updatedAt: 1 } } })
  const { createReviewLink } = await import('../lib/review/store')
  const link = createReviewLink({ collection: 'blog', slug: 'sentinel-draft-post', variant: 'draft', ttlHours: 24 })
  assert.ok(link.ok)
  // The link's address (/review/<token>): its token, and its id, must never reach a tool result.
  reviewToken = link.ok ? String(link.link.path).split('/').pop() || '' : ''
  assert.ok(reviewToken.length > 10)
  HIDDEN.push(link.ok ? link.link.id : 'no-link')
  // Broken-link results for the hidden addresses (the health report reads them) and for a public one.
  const broken = (url: string) => ({ url, outcome: 'broken', status: 404, code: null, reason: null, finalUrl: null, safeMove: false, checkedAt: Date.now() - 3 * 86_400_000, failures: 3, failingSince: Date.now() - 4 * 86_400_000 })
  const links = Object.fromEntries(
    ['https://wa.me/SENTINEL-WA', 'https://sentinel-download-only.example.com/', 'https://sentinel-hidden-entry-url.example.com/', 'https://brand.example.com/', 'https://broken.example.com/page'].map((u) => [u, broken(u)]),
  )
  fs.mkdirSync(path.join(h.tmp, 'data', 'content-health'), { recursive: true })
  fs.writeFileSync(path.join(h.tmp, 'data', 'content-health', 'links.json'), JSON.stringify({ version: 1, lastRun: null, links }))
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

/** Every argument shape that reaches a different code path of each tool. */
function variants(): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [['get_site_overview', {}]]
  for (const args of [{}, { status: 'draft' }, { status: 'unpublished_changes' }, { status: 'scheduled' }, { query: 'sentinel' }, { tag: 'sentineldrafttag' }, { collection: 'page' }, { collection: 'work' }, { lang: 'en' }])
    out.push(['search_content', args])
  for (const ref of ['public-post', 'sentinel-draft-post', 'no-such-post']) for (const view of ['latest', 'live']) out.push(['get_content', { collection: 'blog', ref, view }])
  for (const ref of ['now', 'uses', 'about', 'about-zh']) out.push(['get_content', { collection: 'page', ref }])
  out.push(['get_content', { collection: 'work', ref: 'public-case' }])
  out.push(['get_home', {}])
  for (const section of ['hero', 'socials', 'brands', 'quickAccess', 'photos', 'highlights', 'contact', 'availability', 'openSource', 'site', 'sections', 'sectionOrder']) out.push(['get_home', { section }])
  out.push(['get_cv', {}])
  for (const lang of ['en', 'zh']) out.push(['get_cv', { lang }])
  for (const section of ['personalInformation', 'workExperience', 'recommendations', 'certification']) out.push(['get_cv', { section }])
  for (const args of [{}, { filter: 'unused' }, { filter: 'missing_alt' }, { query: 'sentinel' }]) out.push(['list_media', args])
  out.push(['get_content_health', {}], ['get_content_health', { summary: true }])
  for (const check of ['broken-link', 'image-alt', 'image-missing', 'description']) out.push(['get_content_health', { check }])
  for (const topic of ['mdx', 'frontmatter', 'cv', 'home']) out.push(['get_authoring_guide', { topic }])
  out.push(['list_versions', { collection: 'blog', ref: 'public-post' }], ['list_versions', { collection: 'home' }], ['list_versions', { collection: 'cv' }], ['list_versions', { collection: 'blog', deleted: true }])
  out.push(['get_change', { change_id: 'ch_abcdefghijklmnop' }], ['list_my_changes', {}])
  return out
}

function keysOf(v: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, into)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) keysOf(x, into.add(k))
  return into
}

for (const level of ['read', 'draft', 'propose'] as Level[]) {
  test(`at ${level} level, no tool returns a hidden or private value${level === 'read' ? ', a draft or an unpublished change' : ''}`, async () => {
    const banned = level === 'read' ? [...HIDDEN, ...DRAFT_ONLY] : HIDDEN
    let calls = 0
    for (const [name, args] of variants()) {
      // Each call on a fresh minute: the budgets are another test's business.
      tools.nextMinute()
      const out = await tools.call(name, args, level)
      calls++
      const text = out.text.toLowerCase()
      for (const s of banned) assert.ok(!text.includes(s.toLowerCase()), `${name} ${JSON.stringify(args)} at ${level} returned ${s}: ${out.text.slice(0, 400)}`)
      assert.ok(!text.includes(reviewToken.toLowerCase()), `${name} returned a review token`)
      for (const k of keysOf(out.json)) assert.ok(!['path', 'note', 'token'].includes(k), `${name} ${JSON.stringify(args)} has a ${k} field`)
      if (out.code === 'BUDGET' || out.code === 'UNAVAILABLE') assert.fail(`${name} ${JSON.stringify(args)} at ${level}: ${out.text}`)
    }
    assert.ok(calls > 60)
  })
}

test('the sentinels are really there: the tools do read this store (the public values come through)', async () => {
  const cv = await tools.data('get_cv', { lang: 'en' }, 'propose')
  assert.match(JSON.stringify(cv), /A public summary\./)
  assert.match(JSON.stringify(cv), /Great to work with\./)
  assert.match(JSON.stringify(await tools.data('get_home', {}, 'read')), /public-field\.webp/)
  const health = await tools.data('get_content_health', { check: 'broken-link' }, 'read')
  assert.ok(health.issues.some((i: any) => i.url === 'https://broken.example.com/page'), 'a public broken link is reported')
  const draft = await tools.data('get_content', { collection: 'blog', ref: 'sentinel-draft-post' }, 'draft')
  assert.equal(draft.title, 'SENTINEL-DRAFT-TITLE', 'draft access reads drafts')
  // And the stored documents hold the hidden ones (the views remove them).
  const { readCvData } = await import('../lib/cvdata')
  assert.match(JSON.stringify(readCvData()), /SENTINEL-HIDDEN-ENTRY/)
})

test('a draft read without draft access is byte for byte the answer to an unknown slug', async () => {
  for (const view of ['latest', 'live']) {
    const unknown = await tools.call('get_content', { collection: 'blog', ref: 'never-existed', view }, 'read')
    const draft = await tools.call('get_content', { collection: 'blog', ref: 'sentinel-draft-post', view }, 'read')
    assert.equal(draft.code, 'NOT_FOUND')
    assert.equal(draft.text, unknown.text)
  }
})

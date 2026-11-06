/**
 * M2 — the egress lint of AI writes (design §4.5 steps 2 to 4, §12.1;
 * THREATS on prompt injection and egress), through validateAiWrite and the
 * real parse in the compile worker:
 *
 *   - a new remote image is refused in every form the renderer reads —
 *     Markdown inline and by reference, `<img>`, `<Figure>`, any JSX `src`,
 *     `srcset`/`srcSet` or `poster`, an expression attribute, a cover — and
 *     every spelling a browser reads as another host (`//`, `/\`, upper
 *     case, `data:`); one already in the stored text may stay;
 *   - invisible control characters a write adds are refused; zero-width
 *     characters outside joiner contexts are counted, emoji and Persian
 *     joiners are not;
 *   - new external links are kept and listed with their flags; links the
 *     text already had, site paths and inert iframes are not;
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
  const cover = await validate.validateAiWrite(subject('Text.', { fm: { cover: 'https://img.example/cover.png' }, touched: ['cover'] }))
  assert.ok(!cover.ok && cover.code === 'REMOTE_IMAGE' && cover.data?.field === 'cover', JSON.stringify(cover))
  for (const ok of ['![a](/uploads/field.webp)', '<Figure src="/uploads/field.webp" alt="a" />', '![a](/images/site.png)', '![a](relative.png)']) {
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

test('invisible control characters a write adds are refused; the owner’s own may stay', async () => {
  for (const [ch, name] of [
    ['‮', 'U+202E'],
    ['‪', 'U+202A'],
    ['⁦', 'U+2066'],
    ['⁩', 'U+2069'],
    ['\u{E0041}', 'U+E0041'],
    ['\u{E007F}', 'U+E007F'],
  ]) {
    const inBody = await validate.validateAiWrite(subject(`Hello ${ch}world`))
    assert.ok(!inBody.ok && inBody.code === 'INVISIBLE_CHARS' && inBody.data?.char === name, `${name}: ${JSON.stringify(inBody)}`)
    const inTitle = await validate.validateAiWrite(subject('Hello', { fm: { title: `Title ${ch}` }, touched: ['title'] }))
    assert.equal(!inTitle.ok && inTitle.code, 'INVISIBLE_CHARS', name)
  }
  const before = { frontmatter: { title: 'T', date: '2026-05-01' }, body: 'مرحبا ⁧عالم⁩' }
  assert.equal((await validate.validateAiWrite(subject('مرحبا ⁧عالم⁩ edited', { before }))).ok, true, 'isolates the owner wrote stay')
  const more = await validate.validateAiWrite(subject('مرحبا ⁧عالم⁩ ⁧again⁩', { before }))
  assert.equal(!more.ok && more.code, 'INVISIBLE_CHARS', 'one more is refused')
  const texts = await validate.validateAiWrite({ kind: 'texts', fields: { alt: 'A ‮flipped alt' }, before: { alt: '' } })
  assert.equal(!texts.ok && texts.code, 'INVISIBLE_CHARS')
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

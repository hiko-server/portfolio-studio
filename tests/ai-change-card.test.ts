/**
 * M3 — the change card as the server renders its first frame (design §8.2;
 * stage M3b): before any effect runs, Approve is off (arming needs a second
 * on screen and the owner's pointer or focus), a long change says to read it
 * first, a destructive one names its effect, the model's words are only a
 * quote and nothing on the card links anywhere but the admin's own change
 * pages. The card is .tsx: a test-local loader transpiles it with the
 * project's TypeScript (JSX → react/jsx-runtime), as tests/review-r3-visu
 * does. Interactions are e2e/ai-admin.spec.ts's.
 */
import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChangeDetail } from '../components/Admin/ai/types'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { readFileSync } from 'node:fs'
      import { fileURLToPath } from 'node:url'
      import { createRequire } from 'node:module'
      const require = createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})
      const ts = require('typescript')
      export async function load(url, context, next) {
        if (url.startsWith('file:') && url.endsWith('.tsx') && !url.includes('/node_modules/')) {
          const source = readFileSync(fileURLToPath(url), 'utf8')
          const out = ts.transpileModule(source, {
            fileName: fileURLToPath(url),
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
          })
          return { format: 'module', source: out.outputText, shortCircuit: true }
        }
        return next(url, context)
      }
    `),
  import.meta.url,
)

const ID = 'ch_abcdefghijklmnop'
const EARLIER = 'ch_qrstuvwxyz234567'

function change(over: Partial<ChangeDetail> = {}): ChangeDetail {
  const body = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}.`).join('\n')
  return {
    id: ID,
    state: 'waiting',
    risk: 'live',
    kind: 'item.publish',
    tool: 'propose_publishing',
    title: 'Publish post field-notes',
    target: { kind: 'blog', ref: 'field-notes' },
    actor: { kind: 'mcp', id: 'grant-1', label: 'Laptop', provider: null, model: null },
    rationale: 'Ready to go. [click here](https://collector.example/?d=1) ![x](https://collector.example/p.png) <img src="https://collector.example/q.png">',
    created_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    decided_at: null,
    applied_at: null,
    undone_at: null,
    code: null,
    reject_note: null,
    preview_sha256: 'a'.repeat(64),
    base_version: '"1"',
    result: null,
    undo: { available: false, code: 'NOT_APPLIED', message: 'Only an applied change can be undone.' },
    notes: { ai_written_earlier: EARLIER, publish_checks: [{ id: 'title', level: 'ok', label: 'Title length 11/70' }, { id: 'description', level: 'warning', label: 'No description' }] },
    preview: {
      kind: 'item.publish',
      risk: 'live',
      title: 'Publish post field-notes',
      documents: [{ ref: 'blog/field-notes', label: 'Public version of post field-notes', publicUrl: '/blog/field-notes', format: 'mdx', before: '', after: `title: Field notes\n---\n${body}` }],
      newLinks: [{ url: 'https://example.com/source?ref=trial', flags: ['query'] }],
      newEmbeds: [],
      zeroWidth: 2,
      effects: { publicPaths: ['/blog/field-notes', '/blog', '/'], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    ...over,
  }
}

async function renderRaw(c: ChangeDetail, variant: 'panel' | 'row' | 'page' = 'panel'): Promise<string> {
  const { ChakraProvider } = await import('@chakra-ui/react')
  const { default: theme } = await import('../theme/chakra.js')
  const { default: ChangeCard } = await import('../components/Admin/ai/ChangeCard')
  return renderToStaticMarkup(createElement(ChakraProvider, { theme }, createElement(ChangeCard, { change: c, reload: async () => {}, variant })))
}

async function render(c: ChangeDetail, variant: 'panel' | 'row' | 'page' = 'panel'): Promise<string> {
  // Emotion writes its style tags next to the elements on the server: the markup is what is left.
  return (await renderRaw(c, variant)).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
}

/**
 * The resting CSS emotion wrote for the element whose opening tag matches `tag` (its css-… class), from a raw
 * render: the plain `.css-…{…}` rule only, not :hover or :focus (a link that underlines on hover alone is still
 * told apart by colour while it rests).
 */
function cssOf(raw: string, tag: RegExp): string {
  const open = raw.match(tag)?.[0] ?? ''
  const cls = open.match(/class="[^"]*\b(css-[a-z0-9]+)\b/)?.[1]
  assert.ok(cls, `an emotion class on ${tag}`)
  const css = Array.from(raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), (m) => m[1]).join('')
  const rules = Array.from(css.matchAll(new RegExp(`(?:^|\\})\\.${cls}\\{([^}]*)`, 'g')), (m) => m[1])
  assert.ok(rules.length, `a resting rule for .${cls}`)
  return rules.join(';')
}

const approveButton = (html: string) => html.match(/<button[^>]*data-testid="change-approve"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]*)"/g), (m) => m[1])

test('a long change: Approve is off and says to read it all first; the card shows twelve changed lines and the count', async () => {
  const html = await render(change())
  const button = approveButton(html)
  assert.ok(button, 'the Approve button is there')
  assert.match(button, /disabled=""/)
  assert.match(button, /Read all 22 changed lines first/)
  assert.match(button, /data-armed="false"/, 'not armed before a second on screen and the owner’s pointer or focus')
  assert.match(html, /The whole change must be read before it can be approved/)
  assert.match(html, /10 more changed lines: Review all/)
  assert.equal((html.match(/<ins /g) || []).length, 12, 'twelve changed lines on the card, real <ins>')
  assert.match(html, /Goes live at \/blog\/field-notes and refreshes 2 other pages\./)
  assert.match(html, /Undo: one click, until it changes again\./)
  assert.match(html, /Undo restores the site, not what readers, feeds, IndexNow or crawlers already fetched\./)
})

test('the model’s words are a quote and nothing more: no link, no image; the only links lead to the admin’s own change page', async () => {
  const html = await render(change())
  assert.match(html, /The model says:/)
  assert.match(html, /“Ready to go\. \[click here\]\(https:\/\/collector\.example\/\?d=1\)/, 'the rationale as plain text')
  assert.doesNotMatch(html, /<img/i, 'nothing on the card loads an image')
  assert.deepEqual(hrefs(html), [`/admin/ai/change/${EARLIER}`], 'AI-written earlier links to that change, nothing else links')
  // Flags in full: the new link with its flag, invisible characters, the earlier AI change, the checks.
  assert.match(html, /https:\/\/example\.com\/source\?ref=trial/)
  assert.match(html, /⚑ query string/)
  assert.match(html, /2 invisible characters added/)
  assert.match(html, /AI wrote to this before\./)
  assert.match(html, /Title length 11\/70/)
  assert.match(html, /Warning: <\/span>No description/)
  assert.doesNotMatch(html, /autofocus/i, 'a card never takes the focus')
  assert.match(html, /role="group"/)
})

test('a link inside the card’s running text is underlined, not told apart by its colour alone (dark mode: 2.85:1)', async () => {
  const waiting = await renderRaw(change())
  const earlier = cssOf(waiting, new RegExp(`<a[^>]*href="/admin/ai/change/${EARLIER}"[^>]*>`))
  assert.match(earlier, /text-decoration:underline/, '“AI wrote to this before. Open that change”')
  const applied = await renderRaw(change({ state: 'applied', result: { publicUrls: [], editUrl: '/admin/blog/edit?slug=field-notes' }, undo: { available: false, code: 'CHANGED_SINCE', message: '' } }), 'row')
  assert.match(cssOf(applied, /<a[^>]*href="\/admin\/blog\/edit\?slug=field-notes"[^>]*>/), /text-decoration:underline/, '“Changed since. Open history”')
})

test('a short destructive change names its effect, and still waits for its arming', async () => {
  const del = change({
    kind: 'item.delete',
    risk: 'destructive',
    title: 'Delete post old-note',
    target: { kind: 'blog', ref: 'old-note' },
    rationale: null,
    notes: { ai_written_earlier: null, publish_checks: null },
    preview: {
      kind: 'item.delete',
      risk: 'destructive',
      title: 'Delete post old-note',
      documents: [{ ref: 'blog/old-note', label: 'post old-note', publicUrl: '/blog/old-note', format: 'mdx', before: 'title: Old\n---\nShort.', after: '' }],
      newLinks: [],
      newEmbeds: [],
      zeroWidth: 0,
      effects: { publicPaths: ['/blog/old-note', '/blog'], schedule: null, deleted: true, import: null, hiddenValuesChanged: null },
    },
  })
  const html = await render(del)
  const button = approveButton(html)
  assert.match(button, />Approve &amp; delete</)
  assert.match(button, /disabled=""/, 'off until armed')
  assert.doesNotMatch(html, /Read all/, 'three lines need no sheet')
  assert.match(html, /Takes \/blog\/old-note off the site and deletes the item\./)
  assert.match(html, /already fetched/, 'a published item: readers, feeds and crawlers may already hold it')
  assert.doesNotMatch(html, /The model says:/, 'no rationale, no quote')

  // Deleting a draft reaches no reader: no word of what readers already fetched under "Visitors never saw it."
  const draft = await render({
    ...del,
    preview: { ...del.preview!, documents: [{ ...del.preview!.documents[0], publicUrl: null }], effects: { ...del.preview!.effects, publicPaths: [] } },
  })
  assert.match(draft, /Deletes the draft\. Visitors never saw it\./)
  assert.match(draft, /Undo: one click, until it changes again\./)
  assert.doesNotMatch(draft, /already fetched/)
})

test('a publish with a blocking check: Approve names the effect and stays off, and the card says why (the sheet: ai-change-ui and the e2e)', async () => {
  const blocked = change({
    notes: { ai_written_earlier: null, publish_checks: [{ id: 'title', level: 'error', label: 'Add a title' }, { id: 'description', level: 'warning', label: 'No description' }] },
  })
  const html = await render(blocked, 'page')
  const button = approveButton(html)
  assert.match(button, />Approve &amp; publish</, 'reading to the end would not make it approvable: no “Read all … first”')
  assert.match(button, /disabled=""/)
  assert.match(button, new RegExp(`aria-describedby="change-${ID}-blocked"`))
  assert.match(html, new RegExp(`id="change-${ID}-blocked"[^>]*>A publish check blocks this: “Add a title”\\. Reject it and say why, so it can be fixed and proposed again\\.<`))
  assert.match(html, /Blocking: <\/span>Add a title/, 'the check the card calls blocking is the one that blocks')
  assert.doesNotMatch(html, /The whole change must be read before it can be approved/)
  // Warnings alone block nothing: the long change still asks to be read first.
  const warned = await render(change(), 'page')
  assert.match(approveButton(warned), /Read all 22 changed lines first/)
  assert.doesNotMatch(warned, /publish check blocks/)
})

test('decided changes: applied shows what happened and Live now; conflict, expired, voided and rejected say so in the owner’s words', async () => {
  const applied = await render(
    change({ state: 'applied', result: { publicUrls: ['/blog/field-notes'], approvedOn: 'Chrome on macOS', version: '"2"' }, undo: { available: true }, applied_at: new Date().toISOString() }),
    'row',
  )
  assert.match(applied, /Published <span[^>]*>field-notes<\/span>/)
  assert.match(applied, /approved on Chrome on macOS/)
  assert.deepEqual(hrefs(applied), ['/blog/field-notes'], 'Live now links the public page')
  assert.match(applied, />Undo</)
  assert.doesNotMatch(applied, /data-testid="change-approve"/)

  // A page, the home page and the CV are named as the headline names them: "/now", "the home page", "the CV".
  const page = (kind: string, target: { kind: string; ref: string }, title: string) =>
    change({ state: 'applied', kind, title, target, notes: { ai_written_earlier: null, publish_checks: null }, result: { publicUrls: [], approvedOn: 'Chrome on macOS' }, undo: { available: true }, preview: { ...change().preview!, kind } })
  assert.match(await render(page('page.edit', { kind: 'page', ref: 'now' }, 'Edit /now'), 'row'), /Published <span[^>]*>\/now<\/span><span[^>]*> · approved on Chrome on macOS/)
  assert.match(await render(page('home.edit', { kind: 'home', ref: 'home' }, 'Edit the home page'), 'row'), /Published the home page<span[^>]*> · approved on/)
  assert.match(await render(page('cv.restore', { kind: 'cv', ref: 'cv' }, 'Restore the CV'), 'row'), /Restored the CV<span[^>]*> · approved on/)
  const fixed = await render(page('health.fix', { kind: 'health', ref: 'content' }, 'Apply 2 content health fixes'), 'row')
  assert.match(fixed, />Fixed<span[^>]*> · approved on/, 'no bare "content": the row above says what was fixed')

  const changed = await render(change({ state: 'applied', result: { publicUrls: [], editUrl: '/admin/blog/edit?slug=field-notes' }, undo: { available: false, code: 'CHANGED_SINCE', message: '' } }), 'row')
  assert.match(changed, /Changed since\./)
  assert.ok(hrefs(changed).includes('/admin/blog/edit?slug=field-notes'), 'Open history goes to the editor that holds it')

  const conflict = await render(change({ state: 'conflict', code: 'PREVIEW_CHANGED' }), 'row')
  assert.match(conflict, /This changed after it was proposed\./)
  assert.match(conflict, /Nothing was written\. Laptop sees this the next time it checks/)
  assert.match(await render(change({ state: 'expired' }), 'row'), /This proposal expired\. Ask again if you still want it\./)
  assert.match(await render(change({ state: 'voided', code: 'ACCESS_OFF' }), 'row'), /AI access was turned off, so nothing it proposed can be applied\./)
  assert.match(await render(change({ state: 'voided', code: 'ISSUER_ENDED' }), 'row'), /The app that proposed this no longer has access\./)
  const rejected = await render(change({ state: 'rejected', reject_note: 'Too long, <b>shorten</b> it.' }), 'row')
  assert.match(rejected, /You said: “Too long, &lt;b&gt;shorten&lt;\/b&gt; it\.”/, 'the note is text')
  assert.match(await render(change({ state: 'failed', code: 'WRITE_FAILED' }), 'row'), /Failed: it could not be written completely/)
})

test('the review page variant leaves the headline to the page and the row variant leaves the header to its row', async () => {
  const page = await render(change(), 'page')
  assert.doesNotMatch(page, /<h3/, 'the page title is the headline')
  assert.match(page, /data-state="waiting"/, 'the state chip stays')
  assert.doesNotMatch(page, /Laptop · /, 'the page title already names who asked')
  const row = await render(change(), 'row')
  assert.doesNotMatch(row, /data-state=/, 'the row above carries the state')
  const panel = await render(change(), 'panel')
  assert.match(panel, /<h3[^>]*>Publish post <span[^>]*>field-notes<\/span><\/h3>/, 'the slug in mono, from the server’s title')
  assert.match(panel, /Waiting for you/)
})

